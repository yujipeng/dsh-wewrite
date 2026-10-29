# wechat-relay — 微信 API 反向代理参考配置

本文是 dsh-wewrite 的微信出口代理（ADR-007）参考实现文档：只给配置示例，不含代码。
适用场景：你的机器出口 IP 不在公众号 IP 白名单（errcode 40164），且出口 IP 不固定（家宽/办公网），
无法直接加白。解法是在一台有固定公网 IP 的服务器上反向代理 `api.weixin.qq.com`，
把这台服务器的 IP 加进白名单一次即可，dsh-wewrite 侧只改一个配置项。

原理：dsh-wewrite 的微信出口是唯一的 `apiBaseUrl` 配置缝（设置页「微信 API 地址」）。
配成 relay 地址后，全部微信调用（token / uploadimg / material / draft）统一走 relay，无直连混合路径。

## 前提

- 一台有固定公网 IP 的服务器（任意 1 核 512M 的 VPS 都够用；微信 API 调用量远低于这个水位）。
- 该服务器能访问 `api.weixin.qq.com`（443 出网）。
- dsh-wewrite v0.1.0 对 relay 的要求：透明转发，不改写 query string 与请求体
  （微信凭据 appid/secret 在 query/body 里，任何改写都会破坏调用）。

## 方案一：Caddy（推荐，一行配置）

Caddyfile：

```
wx.example.com {
    reverse_proxy api.weixin.qq.com
}
```

（`wx.example.com` 换成你的域名，证书 Caddy 自动签发。无域名也可用 `reverse_proxy api.weixin.qq.com` 裸 IP + 自签，不推荐。）

然后：

1. 把服务器公网 IP 加进公众号后台 IP 白名单（步骤见下节）。
2. dsh-wewrite 设置页「微信 API 地址」填 `https://wx.example.com`（不带尾斜线，路径自动拼接）。
3. 点「连接测试」，通过即生效。

## 方案二：Nginx

```nginx
server {
    listen 443 ssl;
    server_name wx.example.com;
    ssl_certificate     /etc/letsencrypt/live/wx.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wx.example.com/privkey.pem;

    location / {
        proxy_pass https://api.weixin.qq.com;
        proxy_set_header Host api.weixin.qq.com;
        proxy_ssl_server_name on;
        proxy_read_timeout 60s;
        client_max_body_size 12m;   # 封面/正文图上传（微信单图上限 10MB，留余量）
    }
}
```

上面是「透明转发」的最小形态，对公网完全开放。实际部署建议至少加一层访问控制
（path secret 或 bearer），对应的 nginx 写法见下文「可选：访问控制」一节的 **Nginx 示例**。

## 服务器 IP 加白名单步骤

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)（管理员账号）。
2. 左侧「设置与开发」→「基本配置」→「公众号开发信息」→「IP 白名单」→「修改」。
3. 填入 relay 服务器的公网 IP（多个用换行分隔），扫码确认。
4. 回到 dsh-wewrite 设置页点「连接测试」。返回 40164 说明白名单未生效（IP 填错/未保存），按诊断提示核对。

## 可选：访问控制（path secret / bearer）

公网 relay 会被扫到，建议至少加一层访问限制。两种形态：

**形态 A：path secret（dsh-wewrite v0.1.0 兼容，推荐）**

在 base URL 里藏一段随机路径。

**Caddy 示例**

```
wx.example.com {
    handle_path /kX9mP2qR8vT4wN6z/* {
        reverse_proxy api.weixin.qq.com
    }
    respond 404
}
```

**Nginx 示例**

nginx 没有 `handle_path` 这种「剥前缀」指令，等价物是 `proxy_pass` 末尾的那个 `/`：
`proxy_pass https://api.weixin.qq.com/;` 会把 location 匹配到的前缀替换成 `/`，
原请求的 query string（`appid`/`secret`/`access_token`）自动原样带上。

```nginx
# http {} 层，与 server 同级：日志脱敏用（原因见本节末）
map $uri $wx_relay_path {
    ~^/kX9mP2qR8vT4wN6z(/.*)?$  $1;    # 裸前缀也一并抹掉（避免 404 请求把 secret 记进日志）
    default                     $uri;
}
log_format wxrelay '$remote_addr [$time_local] "$request_method $wx_relay_path" $status';

server {
    listen 443 ssl;
    server_name wx.example.com;
    ssl_certificate     /etc/letsencrypt/live/wx.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wx.example.com/privkey.pem;

    # 不写默认的 combined 格式：它会把 query 里的 appid/secret 记进日志
    access_log /var/log/nginx/wxrelay.log wxrelay;

    # 前缀末尾的 / 不能省；^~ 保证不被其它正则 location 抢走
    location ^~ /kX9mP2qR8vT4wN6z/ {
        proxy_pass https://api.weixin.qq.com/;   # 末尾的 / 负责剥前缀
        proxy_set_header Host api.weixin.qq.com;
        proxy_ssl_server_name on;                # 到上游的 TLS SNI
        proxy_http_version 1.1;
        proxy_set_header Connection "";          # 复用长连接
        proxy_read_timeout 60s;
        client_max_body_size 12m;                # 图片上传余量
    }

    # 前缀不匹配一律 404，不暴露 relay 存在（对齐 Caddy 的 respond 404）
    location / {
        return 404;
    }
}
```

三个必须点，任一处写错都会「配置看着没问题、请求全 404」：

1. `location` 的路径必须**以 `/` 结尾**（`^~ /kX9mP2qR8vT4wN6z/`）。写成不带尾斜杠的前缀会连带匹配
   `/kX9mP2qR8vT4wN6z-foo` 这类路径，替换语义也跟着变。
2. `proxy_pass` 必须**带 URI 部分**，即末尾那个 `/`。删掉它就退化成「原样转发」，
   `/kX9mP2qR8vT4wN6z/cgi-bin/token` 会被整段发给微信，微信侧 404。
3. location 前缀区分大小写，必须与设置页填的 base URL 完全一致（`resolveApiBaseUrl` 只剥尾斜杠，不做大小写归一）。

日志是 nginx 与 Caddy 的一处实质差异：nginx 默认开启 `access_log combined`，会把
`$request`（含 query 里的 `appid`/`secret`）和 path secret 一起落盘。上面的 `map` + `log_format`
把 secret 前缀抹掉、只记 `$uri`（不含 query）；不想保留任何访问日志时更省事的做法是直接
`access_log off;`。

可选加固：nginx 到上游默认不校验证书（`proxy_ssl_verify off`）。要收紧可加
`proxy_ssl_verify on;` 与 `proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;`（Debian/Ubuntu 路径）。

若用 `certbot --webroot` 签发证书，404 兜底会挡掉 ACME 校验，需要放行（`certbot --nginx` 会自动插入，无需手写）：

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/www/certbot;
}
```

路径段用 `openssl rand -hex 16` 生成，不要用示例值；dsh-wewrite 设置页「微信 API 地址」填
`https://wx.example.com/kX9mP2qR8vT4wN6z`（`resolveApiBaseUrl` 支持带路径前缀的 base URL，
拼接 `/cgi-bin/...` 后整体命中 location）。

**形态 B：Authorization: Bearer 校验**

**Caddy 示例**（要求请求带 `Authorization: Bearer <token>`，否则 401）：

```
wx.example.com {
    @auth not header Authorization "Bearer kX9mP2qR8vT4wN6z"
    respond @auth 401
    reverse_proxy api.weixin.qq.com
}
```

**Nginx 示例**

nginx 侧的「识别」就是比对请求头变量 `$http_authorization`（没带该头时是空串）。
推荐用 `map` 做精确匹配，把鉴定结果变成一个可复用变量：

```nginx
# http {} 层，与 server 同级
map $http_authorization $wx_relay_authed {
    default                      0;
    "Bearer kX9mP2qR8vT4wN6z"    1;
}

server {
    listen 443 ssl;
    server_name wx.example.com;
    ssl_certificate     /etc/letsencrypt/live/wx.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wx.example.com/privkey.pem;

    location / {
        if ($wx_relay_authed = 0) {
            return 401;
        }
        add_header WWW-Authenticate 'Bearer realm="wechat-relay"' always;

        proxy_pass https://api.weixin.qq.com;   # location 是 /，路径原样转发
        proxy_set_header Host api.weixin.qq.com;
        proxy_ssl_server_name on;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
        client_max_body_size 12m;
    }
}
```

不想动 `http {}` 层时，单行 `if` 等价：

```nginx
location / {
    if ($http_authorization != "Bearer kX9mP2qR8vT4wN6z") {
        return 401;
    }
    # ...proxy_pass 等同上
}
```

`if` 在 nginx 里名声不好，是因为它属于 rewrite 模块、和 `proxy_pass`/`add_header` 等指令组合时行为反直觉；
**`if` 里只写 `return` 是安全的**，不要试图在 `if` 内放 `proxy_pass`。

比对规则是逐字节字符串相等：`Bearer` 的大小写、中间那一个空格、token 全文都必须一致，
多一个空格或大小写不同都会 401。`add_header WWW-Authenticate ...` 是可选项，
让调用方知道该用哪种凭据。

日志提醒同形态 A：query 里的 `appid`/`secret` 与默认 `combined` 格式一起落盘，
按上面的 `map` + `log_format` 脱敏，或直接 `access_log off;`。

兼容性说明：dsh-wewrite v0.1.0 的出口是纯地址替换，**不附加 Authorization 头**。
形态 B 适用于你自己还有其他脚本/工具要复用同一个 relay 的场景；只用 dsh-wewrite 的话请选形态 A，
否则所有请求会被 relay 以 401 拒绝（表现为连接测试 NETWORK 类失败）。
这一点对上面的 Caddy 与 Nginx 两种写法同样成立——校验发生在 relay 侧，与用哪个 web server 无关。

## Nginx 侧：鉴权如何被识别，以及怎么验证

两套配置的「识别」都发生在 nginx 的请求处理阶段，与 dsh-wewrite 无关：

| 形态 | nginx 识别什么 | 命中条件 |
| --- | --- | --- |
| A：path secret | 请求 URI 的**路径前缀**（`location ^~`，最长前缀匹配、区分大小写） | 以 `/kX9mP2qR8vT4wN6z/` 开头；其余一律 `404`（ACME 校验例外见形态 A 末） |
| B：bearer | 请求头 `Authorization` 的**完整字符串**（`map` / `if` 精确相等） | 恰为 `Bearer kX9mP2qR8vT4wN6z`；否则 `401` |

不要用 `User-Agent` 之类的特征做鉴权：dsh-wewrite 走 Node `fetch`，UA 随运行时版本变化且可任意伪造，
只能当排障线索，不能当凭据。

**验证**（部署后按顺序跑一遍；A、B 按你实际启用的那个形态选对应几条）

```bash
export APPID=... SECRET=...                # 公众号后台的 AppID / AppSecret
S=kX9mP2qR8vT4wN6z                        # 换成你自己的 path secret / bearer token
B=https://wx.example.com

# A-1 前缀正确：relay 链路通 → 微信返回 access_token 或 40164（两者都说明 nginx 侧正常）
curl -s "$B/$S/cgi-bin/token?grant_type=client_credential&appid=$APPID&secret=$SECRET"

# A-2 前缀错误：必须是 nginx 的 404，且不暴露 relay 存在
curl -s -o /dev/null -w '%{http_code}\n' "$B/cgi-bin/token"

# B-1 不带 Authorization：必须 401
curl -s -o /dev/null -w '%{http_code}\n' "$B/cgi-bin/token"

# B-2 带正确的 Authorization：进入微信侧，返回 access_token 或 40164
curl -s -H "Authorization: Bearer $S" \
  "$B/cgi-bin/token?grant_type=client_credential&appid=$APPID&secret=$SECRET"
```

判定标准：

- `{"errcode":40164,...}`：**relay 链路已经通了**，只是 relay 服务器的出口 IP 还没进公众号白名单。
- `{"access_token":"...","expires_in":7200}`：全链路正常。
- nginx 的 `404` 页面：前缀不匹配（多半是 `proxy_pass` 漏了末尾 `/`，或 base URL 多/少了字符）。
- `401`：形态 B 的 header 不是逐字节相等（大小写、空格、token 写错），或压根没带。
- `502` / `504`：nginx 到 `api.weixin.qq.com` 的 DNS/TLS 失败，先查 `proxy_ssl_server_name on` 与服务器出网。

真实 `appid`/`secret` 别写进 shell 历史（用 `read -s` 或环境变量文件）；`/cgi-bin/token` 有每日调用额度，
冒烟一次即可，日常用设置页的「连接测试」。

**故障对照表**

| 现象 | 多半是什么 |
| --- | --- |
| `404`（nginx 页面） | location 前缀与 base URL 不一致；或 `proxy_pass` 少了末尾 `/`，含 secret 的路径被整段发给微信 |
| `401` | 形态 B：`Authorization` 不是逐字节相等（大小写/空格/token），或者没带 |
| `40164` | relay 正常，白名单里缺 relay 服务器的公网 IP |
| `502` / `504` | 上游不可达：DNS 解析过期、SNI 缺失、服务器出网被拦 |
| `413` | `client_max_body_size` 太小，图片上传被 nginx 直接拒掉 |

还有一处 dsh-wewrite 侧的坑：base URL 只填 `scheme://host[/path-prefix]`，**不要带尾斜杠，更不要带 `?`**
——`resolveApiBaseUrl` 只剥尾斜杠，带了 query 会把后续的 `/cgi-bin/...` 拼进 query 里。

## 运维要点

- relay 无状态、不落盘，可以随时销毁重建；唯一的「配置」就是白名单里的服务器 IP。
- 服务器换 IP 后记得同步改公众号白名单，否则 40164 复现。
- 不想自建、也无法固定出口 IP：此路不通是微信侧约束（白名单只认 IP），dsh-wewrite
  不提供也不销售代理服务；可退回「主题写作 + 本地渲染」，把推送步骤留到有白名单条件时再做。
