import { describe, expect, it } from 'vitest';
import { buildSearchQueries, cleanSearchKeyword, createSogouWechatSearcher, isAggregatorUrl, parseSogouResults, pickBestHit } from '@/host/pipeline/steps/source-search';

/**
 * 热搜聚合页 → 媒体报道解析：
 * 微博/百度/头条搜索页不是原文（未登录只有空壳），必须按标题检索媒体文章。
 */

const SOGOU_HTML = `<html><body><ul class="news-list">
<li><div class="txt-box"><h3><a href="/link?url=abc">罗技广告再被指侮辱用户，客服回应</a></h3>
<p class="txt-info">11 月 2 日，罗技 G 影音旗舰店发布视频，使用小狗表情包……</p>
<div class="s-p"><a class="account">潇湘晨报</a></div></div></li>
<li><div class="txt-box"><h3><a href="https://weixin.sogou.com/link?url=def">其他新闻</a></h3>
<p class="txt-info">摘要</p><a class="account">某媒体</a></div></li>
</ul></body></html>`;

describe('isAggregatorUrl', () => {
  it('热搜/搜索聚合页 → true', () => {
    expect(isAggregatorUrl('https://s.weibo.com/weibo?q=%23%E7%BD%97%E6%8A%80%23')).toBe(true);
    expect(isAggregatorUrl('https://m.baidu.com/s?word=罗技')).toBe(true);
    expect(isAggregatorUrl('https://so.toutiao.com/search?keyword=罗技')).toBe(true);
    expect(isAggregatorUrl('https://weixin.sogou.com/weixin?type=2&query=罗技')).toBe(true);
  });

  it('文章直链 / 普通站点 / 非法 URL → false', () => {
    expect(isAggregatorUrl('https://mp.weixin.qq.com/s/abc')).toBe(false);
    expect(isAggregatorUrl('https://www.thepaper.cn/newsDetail_forward_1')).toBe(false);
    expect(isAggregatorUrl('not-a-url')).toBe(false);
  });
});

describe('parseSogouResults / pickBestHit', () => {
  it('解析标题/链接/摘要/公众号', () => {
    const hits = parseSogouResults(SOGOU_HTML);
    expect(hits).toHaveLength(2);
    expect(hits[0].title).toContain('罗技');
    expect(hits[0].url).toBe('https://weixin.sogou.com/link?url=abc');
    expect(hits[0].publisher).toBe('潇湘晨报');
    expect(hits[0].summary).toContain('11 月 2 日');
  });

  it('按标题字符重叠选最匹配报道', () => {
    const hits = parseSogouResults(SOGOU_HTML);
    expect(pickBestHit(hits, '罗技广告再被指侮辱用户')?.publisher).toBe('潇湘晨报');
  });

  it('标题重叠不足时返回 undefined（不把无关报道当原文）', () => {
    const hits = parseSogouResults(SOGOU_HTML);
    expect(pickBestHit(hits, '英伟达发布新一代显卡')).toBeUndefined();
  });

  it('无结果时返回 undefined', () => {
    expect(pickBestHit([], '罗技')).toBeUndefined();
  });
});

describe('cleanSearchKeyword / buildSearchQueries', () => {
  it('去掉话题井号、引号与“热搜”字样', () => {
    expect(cleanSearchKeyword('#罗技广告再被指侮辱用户#')).toBe('罗技广告再被指侮辱用户');
    expect(cleanSearchKeyword('“罗技”广告又上热搜')).toBe('罗技广告又上');
  });

  it('回退链：原题 → 清洗词 → 话题词，去重且保留原题', () => {
    const queries = buildSearchQueries('“罗技”广告再被指侮辱用户（热搜）', '罗技广告');
    expect(queries[0]).toBe('“罗技”广告再被指侮辱用户（热搜）');
    expect(queries).toContain('罗技广告再被指侮辱用户');
    expect(queries).toContain('罗技广告');
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe('createSogouWechatSearcher.search', () => {
  it('返回验证码页且无结果 → 抛出可读错误（区分风控与真的 0 条）', async () => {
    const searcher = createSogouWechatSearcher({
      fetchImpl: (async () =>
        new Response('<html><body>请输入验证码</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch,
      userAgents: ['test-ua'],
    });
    await expect(searcher.search('罗技', 5)).rejects.toThrow('验证码');
  });
});

describe('createSogouWechatSearcher.resolve', () => {
  it('302 Location 指向 mp.weixin.qq.com → 返回直链', async () => {
    const searcher = createSogouWechatSearcher({
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: 'https://mp.weixin.qq.com/s/xyz' } })) as typeof fetch,
    });
    await expect(searcher.resolve('https://weixin.sogou.com/link?url=abc')).resolves.toBe('https://mp.weixin.qq.com/s/xyz');
  });

  it('中转页 JS 拼接 url → 返回直链', async () => {
    const html = "<script>var url = ''; url += 'https://mp.weixin.qq.com'; url += '/s/abc';</script>";
    const searcher = createSogouWechatSearcher({
      fetchImpl: (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
    });
    await expect(searcher.resolve('https://weixin.sogou.com/link?url=def')).resolves.toBe('https://mp.weixin.qq.com/s/abc');
  });
});
