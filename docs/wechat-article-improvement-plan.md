# 借鉴 wechat-article 全流程的改进计划

> 状态：**Phase 1 已完成并真机验证**（2026-10-30：v1.0 tag 后启动；Phase 0 图像 spike、I-01 预检、I-02 尺寸/裁剪、I-03 压缩、I-04 回读、I-05 发布记录已完成；真机推送 `pushVerify.ok=true`）
> 日期：2026-10-29（2026-10-30 更新实施状态）
> 对照基线：`~/Documents/wechat-article/`（2026-10-22 ~ 10-29，7 篇已推草稿）与 `~/Documents/wechat-article/.wewrite/`
> 本文只描述「补什么、放在哪、怎么验收」，不含代码改动。
> 关联文档：`docs/prd.md`（F1–F9）、`docs/spec.md`、`docs/decisions/OPEN-DECISIONS.md`、`docs/v0.5-launch-brief.md`

---

## 0. 摘要

`wechat-article` 是一条已在真实生产中跑通 7 篇的「人 + agent + CLI」流程；`dsh-wewrite` 把它产品化成了六步管线（topic → outline → draft → gates → render → images）。两者在**发布前后的机械校验、跨篇记忆、内容层评审、排版容器、配图规范**五个面上差距最大。

按投入产出排序：

| 优先级 | 主题 | 改进项 | 数据模型影响 |
|---|---|---|---|
| **P0** | 发布链闭环 | I-01 ~ I-05 | 仅新增可选字段 |
| **P1** | 选题与写作合同 | I-06 ~ I-14 | 新增可选字段 |
| **P2** | 排版 / 配图 / 事实核查 | I-15 ~ I-23 | 新增可选字段，可选步骤 |

**唯一硬缺口**：封面比例与图片体积。微信 `uploadimg` 硬限制单图 < 1MB，封面要求 2.35:1；当前管线按 `defaultImageSize`（默认 1024×1024）生成且不压缩，推送存在直接失败的风险。I-02 / I-03 建议最先做。

**需要先拍板的技术选型**：I-02（裁剪）与 I-03（压缩）都需要本地图像处理能力。当前项目没有任何图像处理依赖，这是 P0 的前置决策，见 §6 Q1。

---

## 1. 范围与方法

### 1.1 对照对象

| 侧 | 入口 | 关键产物 |
|---|---|---|
| 外部流程 | `~/Documents/wechat-article/w`（CLI 包装器）+ agent 手工编排 | `选题候选.md`、`.wewrite/runs/<id>/{brief,claims,sources,review-report}`、`公众号-*.md` / `排版稿-*.md` / `发布稿-*.md`、`final-check.py`、`verify-publish.py`、`发布记录.txt` |
| 当前项目 | `src/host/pipeline/engine.ts` 六步管线 + 工作台 | `RunRecord`、`ArticleRecord`、`GatesReport`、`ArticleRecord.wechatMediaId` |

### 1.2 判定标准

一个外部做法被列入本计划，需同时满足：

1. **可机械化**：能落成确定性代码或单次结构化 LLM 调用，不依赖人工脚本；
2. **有验收面**：能写成单测、快照或 e2e 断言；
3. **不破坏现有契约**：六步序列、只进草稿箱、fail-closed 审批三条不动。

优先级依据：**会导致线上失败的 > 能显著减少返工的 > 提升成稿质量的 > 体验类**。

### 1.3 不作为改进项的部分

外部流程里的 CLI 包装器（`w`）、SSH 隧道（`publish-via-tunnel.sh`）、Python 脚本本体（`build-layout.py` 等）不搬。它们解决的是「命令行环境一致性」问题，而插件跑在 DSH host 内，对应能力应产品化进 host 代码。

---

## 2. 现状对照

| 环节 | 外部做法 | 当前项目 | 差距 |
|---|---|---|---|
| 热点 | 热搜条目 + 原始报道双链接；区分热点 / 高频需求 / 常青；同题密度观察并注明「不显示阅读量」 | 三源热榜 + 逐条 AI 速览（`src/host/hotspot-digest.ts`） | 条目只有一个 `url`；无来源类型、无同题证据 |
| 选题 | 10 个候选 + 确定性打分 + 近 7 天去重 + 8 字段 + 已排除清单 + 编辑推荐 | `TopicCandidateRecord` 仅 `title/source/url/rank/digest`；工具上限 5 条 | 无打分、无跨篇去重、无推荐理由 |
| 写作 | `brief.yaml` 写作合同（受众/论点/边界/反方/must_include/must_avoid/sections→claims） | `RunParams.brief` 仅 `title/approach/outline/sources` | 无主张与边界约束 |
| 事实 | `claims.yaml` + `sources.yaml`（status/boundary）+ `research/facts.md` / `mechanisms.md` | 门禁只检查 URL 可见性与「不许编造来源」 | 不检查主张是否有来源支撑 |
| 评审 | 五维评分 + blockers + major_issues + pass_number | 规则门禁（`src/host/pipeline/steps/gates.ts`） | 无内容层评审 |
| 排版 | 三稿分离 + `:::` 容器（steps/summary/highlight）+ 图注后处理 | `src/render/blocks.ts` 不支持任何容器 | 无容器、无图注、无三稿 |
| 配图 | 封面 2.35:1、正文 16:9、共享视觉系统、<1MB 压缩、量化验图 | `src/host/images.ts` 固定模板 prompt；尺寸枚举无 2.35:1；不压缩不校验 | 硬限制未覆盖 |
| 发布 | 发布前终检 + `draft/get` 回读 + 发布记录 | `src/host/wechat/client.ts` 只有 `draft/add` | 无终检、无回读、无记录 |

---

## 3. 改进项

编号规则：`I-xx` 全局唯一，实施时可直接引用。

### 3.1 P0 — 发布链闭环

#### I-01 推送前预检（preflight）✅ 已完成（2026-10-30）

- **问题**：微信的硬限制（标题 ≤64 字、摘要 ≤120 字节、正文图 ≤10 张、单图 <1MB）目前没有任何一处集中校验，超限时只能拿到 API 报错。
- **做法**：在 `pushDraft` 之前增加纯函数 `preflightPush(article, images)`，返回 `{ ok, issues[] }`。检查项：标题字数、摘要字节数（UTF-8）、正文图数量、图片引用是否都能解析到 `ImageRecord`、单图字节数、封面是否存在。失败时抛出可行动错误，不发起任何微信调用。
- **落点**：`src/host/wechat-flow.ts`（编排层）、`src/host/wechat/client.ts`（只保留 API 语义）。
- **验收**：`tests/host/push-gate.test.ts` 增加 6 组边界用例（63/64/65 字标题、119/120/121 字节摘要、9/10/11 张图、0.99/1.00MB 图片）；预检失败时断言微信 client 未被调用。

#### I-02 封面比例与正文尺寸 ✅ 已完成（2026-10-30）

- **问题**：微信封面要求 2.35:1，当前 `ImageSize` 枚举（`src/host/providers/types.ts`）只有 1:1、2:3、3:2、7:4 等，没有 2.35:1；正文图也未固定 16:9。
- **做法**：
  1. 新增尺寸常量：封面目标 `1280×545`（2.35:1），正文目标 `1280×720`（16:9）。dashscope 直接请求 1280×720（实测可用），封面由本地裁剪；避免 2048 大尺寸触发限流/尺寸限制。
  2. 在 provider 层引入**能力矩阵**：每个 provider 声明可请求的尺寸集合。能直接请求目标尺寸的（dashscope 1280×720）直接请求；不能的请求最接近的支持尺寸，再由本地裁剪到目标比例。矩阵需按各家实际 API 文档逐条确认，不按厂商名一刀切。
  3. `images.ts` 的封面与正文分别使用两套 prompt 与尺寸，不再共用 `defaultImageSize`。
- **落点**：`src/host/providers/types.ts`、`src/host/providers/registry.ts`、`src/host/images.ts`、`src/host/domain.ts`（`defaultImageSize` 保留旧值，新增枚举）。
- **验收**：单测断言每个 provider 的请求尺寸落在其支持集合内；集成测试断言最终封面宽高比误差 < 0.02；`tests/host/providers-registry.test.ts` 增加能力矩阵用例。
- **依赖**：裁剪需要图像处理能力，见 §6 Q1。

#### I-03 图片压缩至 < 1MB ✅ 已完成（2026-10-30）

- **问题**：AI 生成的 PNG 通常 2MB 以上，`uploadimg` 会直接拒绝。当前项目只存 base64，不做任何压缩。
- **做法**：生成后、持久化前统一走 `compressForWeChat(buffer, mime)`：JPEG 质量梯度 92 → 90 → 88 → 86 → 84 → 80，目标 ≤ 0.92 × 1MB（留出编码余量）；保留原图 `ImageRecord` 与压缩后记录（或原图标记 `original: true`）。压缩失败不阻断成稿，标记 `compressed: false` 交由 I-01 预检兜底。
- **落点**：`src/host/images.ts`（新增后处理层），`src/host/domain.ts`（`ImageRecord` 增加可选 `bytes` / `compressed`）。
- **验收**：单测用 3 张固定样本（2.4MB PNG / 0.9MB JPEG / 0.3MB PNG）断言输出 ≤ 1MB 且 `mime` 正确；覆盖「压缩失败降级」路径。
- **依赖**：同 Q1。

#### I-04 推送后回读校验 ✅ 已完成（2026-10-30）

- **问题**：`draft/add` 返回 `media_id` 只说明请求成功，不说明线上内容正确（中文编码、图片替换、容器渲染都可能出问题）。外部流程用 `draft/get` 逐项比对，项目没有。
- **做法**：
  1. `client.ts` 增加 `getDraft(mediaId)`，实现 `/cgi-bin/draft/get`；响应体显式按 UTF-8 解码（外部踩过的坑：默认 latin-1 会把中文变乱码）。
  2. 新增纯函数 `verifyDraft(actual, expected)`：比对标题、作者、摘要（字节数）、`thumb_media_id` 是否存在、正文 `<img>` 数量、正文长度下限、关键段落是否出现（标题 + 每个 H2）。
  3. 推送结果增加 `verify: { ok, issues[] }`；校验失败**不回滚**已推送事实，但 UI 明确标红并给出差异。
  4. 正文图占位：渲染层把 `![alt](图片待生成)` 保留为 `ww-image-placeholder`，`pushDraft` 按序替换为 `uploadimg` 返回的 CDN URL；无对应图的占位删除，避免微信把占位当成图片（回读会多出空图）。
- **落点**：`src/host/wechat/client.ts`、`src/host/wechat-flow.ts`、`src/render/inline.ts`、`src/host/domain.ts`（`ArticleRecord` 增加可选 `pushVerify`）。
- **验收**：`tests/host/wechat-client.test.ts` 用 mock 响应覆盖：正常、中文乱码、图片数不符、封面缺失四组；断言 `issues` 内容可读且不含敏感信息。2026-10-30 真机推送验证：`pushVerify.ok=true`，`digestBytes=117`，封面 1280×545 / 正文图 1280×720 均 <1MB。

#### I-05 发布记录 ✅ 已完成（2026-10-30）

- **问题**：推送后只有 `wechatMediaId/thumbMediaId`，没有时间、没有摘要字节、没有校验结论，无法审计与重推。
- **做法**：`ArticleRecord` 增加可选字段 `pushedAt` / `digestBytes` / `pushVerify`；工作台文章详情增加「发布记录」折叠区，支持导出为与外部流程同形的 `发布记录.txt`（media_id、标题、摘要字节、推送时间、校验结论、重推说明）。重推命令只生成不执行。
- **落点**：`src/host/domain.ts`、`src/host/articles-store.ts`、`src/client/panels/editor-panel.tsx`。
- **验收**：持久化 round-trip 单测；导出文本快照测试；旧记录（无新字段）能正常读取。

---

### 3.2 P1 — 选题与跨篇去重

#### I-06 候选扩到 10 条

- **问题**：`wewrite_suggest_topics` 上限 5 条（`src/host/agent-tools/suggest-topics.ts`），外部一次给 10 条供编辑挑选。
- **做法**：上限提到 10；默认仍为 3，避免默认成本上升。逐条速览只对前 3 条生成，其余按需点开（复用现有逐条 digest + 当日缓存）。
- **落点**：`src/host/agent-tools/suggest-topics.ts`、`src/host/service.ts`、`src/shared/contract.ts`。
- **验收**：工具参数边界测试（0/1/10/11）；断言 10 条时 LLM 调用次数 ≤ 3。

#### I-07 确定性打分与近 7 天去重

- **问题**：当前选题完全靠人看榜单，没有可解释的排序，也没有跨篇去重。
- **做法**：
  1. 纯函数 `scoreTopic(candidate, history)`：`总分 = 热度×0.3 + 相关度×0.4 + 切入价值×0.3`；命中近 7 天关键词扣 3 分；权重来自设置项（可配，默认上述值）。
  2. 热度、相关度、切入价值由 LLM 以结构化 JSON 给出（0–10），打分与去重由代码完成——模型不参与算分。
  3. 历史来源：`articles` 表的标题 + 手动维护的关键词（见 I-14），不新增表。
- **落点**：新增 `src/host/pipeline/steps/topic-score.ts`（纯函数 + 类型），`src/host/service.ts` 装配。
- **验收**：固定输入固定输出的表驱动单测 ≥ 12 组（含并列分、无历史、全量重复三种边界）；扣分规则单测。

#### I-08 候选字段与编辑推荐

- **问题**：候选只有标题 + 来源 + 速览，缺少「为什么写这个」和「写了会不会重复」。
- **做法**：`TopicCandidateRecord` 增加可选字段：`sourceType`（热点 / 高频需求 / 常青）、`originUrl`（原始报道）、`heat` / `relevance` / `value` / `score`、`idealClick`、`seo`、`framework`（观点型 / 热点解读 / 痛点型）、`reason`、`historyMark`。批次结果追加「已排除清单」与「编辑推荐（首选/次选/第三）」。
- **落点**：`src/host/domain.ts`、`src/host/service.ts`、`src/client/panels/hotspots-panel.tsx`。
- **验收**：schema 向后兼容（旧记录无新字段可读）；面板快照测试；推荐项必须存在于候选列表。

#### I-09 热点来源类型与原文链接

- **问题**：热榜条目只有一个 URL，写作时容易只基于标题；外部流程区分「热搜话题」与「原始报道」。
- **做法**：速览阶段同时抽取原文链接（正文 `<link rel=canonical>` 或首个外链），区分 `topicUrl` 与 `originUrl`；速览输出增加一行「同题密度：N 篇 / 未检索」，并固定附上「不显示阅读量，不能推断爆款」的边界说明。
- **落点**：`src/host/hotspot-digest.ts`。
- **验收**：抓取失败降级路径不变；速览输出结构快照；原文链接只接受 http(s)。

---

### 3.3 P1 — 写作合同与编辑评审

#### I-10 写作合同扩展

- **问题**：`RunParams.brief` 只有四个字段，模型拿不到「这篇要论证什么、边界在哪、反方是谁」。
- **做法**：可选新增 `thesis`（一句话主张）、`boundary`（不写什么）、`counterpoint`（最强反方及回应）、`audience`（who/context/question）、`mustInclude`（必须出现的事实/机制）、`mustAvoid`（不得出现）。全部可选，缺省时提示词与现状完全一致。
- **落点**：`src/shared/contract.ts`（`RunParamsSchema`）、`src/host/pipeline/llm.ts`、`src/client/components/StartupCard.tsx`（「更多信息」折叠区）。
- **验收**：旧参数快照不变；新字段注入后的 prompt 快照；`tests/host/launch-brief.test.ts` 扩展。

#### I-11 mustInclude / mustAvoid 机械门禁

- **问题**：外部流程用 `final-check.py` 逐条检查「必须出现」和「禁区」，项目只有禁用词表。
- **做法**：`gates.ts` 增加两项：`mustInclude` 中每项必须原样出现；`mustAvoid` 中每项不得出现（正则安全转义）。二者都进入 `GatesReport.issues`，沿用「任一硬项不过即阻断」。
- **落点**：`src/host/pipeline/steps/gates.ts`。
- **验收**：单测覆盖命中/未命中/正则元字符/空数组；报告结构快照。

#### I-12 编辑评审（五维评分）

- **问题**：规则门禁只能抓禁用词与结构问题，抓不到「论证是否成立、是否自相矛盾、是否编造亲历」。
- **做法**：
  1. 在 `gates` 步内部增加第二判定阶段（**不新增管线步骤**，避免破坏六步序列、stepper 与既有测试）：规则门禁通过后，调用一次 LLM 评审，输出结构化 JSON：`{ dimensions: {accuracy, viewpoint, usefulness, voice, readability}, blockers[], majorIssues[], notes }`，每维 0–5。
  2. 判定：任一维 < 3.5（建议值，可配）或存在 blocker → 不通过；`majorIssues` 非空但无 blocker → 通过并记录。
  3. 评审结果落 `RunRecord.steps[gates].metrics.review`，门禁面板展示。
- **落点**：`src/host/pipeline/steps/gates.ts`、`src/host/pipeline/engine.ts`（透传评审输入）、`src/client/components/GateReport.tsx`。
- **验收**：JSON 解析容错（缺字段、非 JSON、分数越界）；四条判定路径单测；LLM 失败时按「评审不可用」处理（可配置：阻断或降级为仅规则，默认降级并警告）。

#### I-13 自动修订一轮

- **问题**：评审不通过时目前只能人工改稿。
- **做法**：评审失败且存在 `majorIssues` 时，带 issues 列表重写一次成稿，再跑一次规则门禁 + 评审；仍不通过则阻断推送。最多一轮，避免无限循环与成本失控。
- **落点**：`src/host/pipeline/engine.ts`（draft 自愈机制已存在，复用同一模式）。
- **验收**：两次调用次数断言；第二轮仍失败时 `run.status=failed` 且错误信息含首轮 issues。

#### I-14 跨篇已用机制

- **问题**：外部流程显式排除「近期已用机制」（沉没成本、弱连接、社会证明……），避免连续几篇同一套解释。项目没有这个概念。
- **做法**：文章记录增加可选 `mechanisms: string[]`（成稿后由评审阶段抽取并随文章保存）；选题与写作时把近 N 篇（默认 7 天）的 mechanisms 注入 `mustAvoid`，并在选题打分中作为去重依据。
- **落点**：`src/host/domain.ts`、`src/host/articles-store.ts`、`src/host/pipeline/llm.ts`。
- **验收**：机制抽取输出快照；近 7 天窗口单测；无历史时提示词不注入空段。

---

### 3.4 P2 — 排版与配图

#### I-15 `:::` 容器语法

- **问题**：`src/render/blocks.ts` 只处理标准 Markdown，`:::` 会被当成普通段落。外部流程的 `steps` / `summary` / `highlight` 卡片全部依赖它。
- **做法**：
  1. 在 `renderMarkdownBody` 的预处理阶段扫描 `:::<name> ... :::` 块，替换为占位符（复用 `PIPE_SENTINEL` 的占位思路），渲染完成后替换为容器 HTML。
  2. 容器样式进 `themes.ts`，每个主题提供 `containerSteps` / `containerSummary` / `containerHighlight` 三段样式。
  3. 约束：`steps` 内不解析有序列表（外部踩坑：`1.` 会被渲染成普通段落），由容器自动编号。
- **落点**：`src/render/convert.ts`、`src/render/blocks.ts`、`src/render/themes.ts`。
- **验收**：`tests/render/parity.test.ts` 增加容器快照（3 种容器 × 3 个主题）；未闭合容器走原路径不报错；`steps` 内 `1.` 不产生 `<ol>`。

#### I-16 图注后处理

- **问题**：图片与其后的斜体说明在渲染后同为 `<p>`，视觉上分不开。
- **做法**：在 `renderBlock` 层识别「图片段落 + 紧随的纯 `<em>` 段落」，直接输出图注样式（居中、13px、灰色、字距 0.5px），并调整图片 margin 为上 36px / 下 6px。避免再引入 HTML 后处理依赖。
- **落点**：`src/render/blocks.ts`、`src/render/themes.ts`。
- **验收**：快照测试；非纯斜体段落不被误判；无图注时输出与现状一致。

#### I-17 三稿视图

- **问题**：外部流程有「公众号（纯正文）/ 排版稿 / 发布稿」三份产物；项目只有一份 Markdown。
- **做法**：不落三份库——**正文稿是唯一真源，排版稿与发布稿按需派生**：排版稿 = 正文 + 容器；发布稿 = 排版稿 + 图片路径替换为压缩版。编辑器视图切换增加「排版 / 发布」，预览直接渲染派生结果，避免三份内容漂移。
- **落点**：`src/host/articles-store.ts`（派生函数）、`src/client/components/editor/EditorHeadActions.tsx`、`src/client/components/editor/PreviewCanvas.tsx`。
- **验收**：派生函数纯函数单测；同一正文三次派生结果稳定；发布预览与实际推送 HTML 字节一致（现有契约保持）。

#### I-18 基于正文的图片提示词 + 视觉系统

- **问题**：当前封面 prompt 是固定模板（「风格克制、信息密度高，深色纯色背景」），与文章内容无关，也不保证套图一致。
- **做法**：draft 完成后用一次 LLM 调用产出 `images.json` 同形清单：封面 + 正文图各自的 prompt 与尺寸。每条 prompt 复写同一段「视觉系统」（色板、材质、光线、负空间），并强制「无文字、无字母、无数字、无 logo、无水印、无清晰人脸」。清单随 `RunRecord` 保存，供复现。
- **落点**：`src/host/images.ts`、`src/host/pipeline/engine.ts`（images 步输入改为清单）、`src/host/domain.ts`。
- **验收**：清单结构校验（尺寸、禁用词）；LLM 失败降级为现有固定模板；生成的 prompt 不含指定禁用元素。

#### I-19 量化验图

- **问题**：模型不能读图，图片是否空白、比例是否跑偏无法自动判断。
- **做法**：`verifyImage(buffer, kind)` 用确定性指标判定：格式、宽高比误差 < 0.02、最小宽度（封面 ≥ 2000）、明度标准差 > 8（非纯色）、三段明度差 > 4（构图非单点）。不达标自动重试一次，仍失败则无图推进（沿用 AC-9）。
- **落点**：`src/host/images.ts`。
- **验收**：固定样本（正常 / 纯色 / 比例错误）三组单测；重试次数断言。

#### I-20 成本预估与上限

- **问题**：外部流程按张数 × 单价做预算预检；项目没有成本概念。
- **做法**：设置项增加可选 `imageCostPerImage`；images 步开始前计算预估成本，超过 `maxImageCost`（可选）则跳过配图并记录原因。
- **落点**：`src/host/domain.ts`、`src/host/images.ts`、`src/client/panels/settings-sections.tsx`。
- **验收**：超限跳过路径单测；未配置时不产生任何限制。

---

### 3.5 P2 — 事实核查（可选）

#### I-21 research 底稿

- **问题**：外部流程有 `research/facts.md`（已核实 / 未核实不采用 / 表述边界 / 引语规则）与 `mechanisms.md`（文献→核对→机制→用法→不能写成→边界），项目完全没有研究阶段。
- **做法**：**不新增管线步骤**（六步序列锁定）。做成可选 agent 工具 `wewrite_research`：输入主题与候选来源，输出两份底稿并把结论写入 `RunParams.brief.mustInclude / boundary`。用户不调用时管线行为不变。
- **落点**：`src/host/agent-tools/`（新工具）、`src/shared/contract.ts`。
- **验收**：工具契约测试；不调用时管线快照与现状一致。

#### I-22 claims / sources 结构

- **问题**：现在只有 `sources: string[]`，无法表达「这条主张有多少把握、不能写成什么」。
- **做法**：`brief` 增加可选 `claims: { id, text, type: fact|opinion, sourceIds, status: supported|bounded, boundary }[]`；`sources` 从字符串数组升级为可选结构（保留旧字符串形态兼容）。门禁增加：`mustInclude` 中每条 fact 类主张必须至少关联一个 source。
- **落点**：`src/shared/contract.ts`、`src/host/pipeline/steps/gates.ts`、`src/host/pipeline/llm.ts`。
- **验收**：两种 sources 形态都能解析；claim-source 一致性单测；旧 brief 不触发新门禁。

#### I-23 Crossref 核对（默认关闭）

- **问题**：外部流程用 Crossref API 逐条核对 DOI、卷期页，曾据此纠正过错误 DOI。
- **做法**：可选开关。开启后对 claims 中带 DOI 的条目请求 `api.crossref.org`，比对题名与卷期页；失败/超时标记「未核对」，**不阻断成稿**，只在评审 notes 中列出。
- **落点**：`src/host/pipeline/steps/gates.ts`（或独立 `src/host/research/crossref.ts`）。
- **验收**：mock 200/404/超时三条路径；未开启时不发任何外部请求。

---

## 4. 数据模型变更

全部为**新增可选字段**，`domain.version` 保持 1，旧记录可直接读取。

| 记录 | 新增字段 | 说明 |
|---|---|---|
| `ArticleRecord` | `pushedAt?`、`digestBytes?`、`pushVerify?`、`mechanisms?` | I-05 / I-04 / I-14 |
| `ImageRecord` | `bytes?`、`compressed?`、`original?` | I-03 / I-19 |
| `TopicCandidateRecord` | `sourceType?`、`originUrl?`、`heat?`、`relevance?`、`value?`、`score?`、`idealClick?`、`seo?`、`framework?`、`reason?`、`historyMark?` | I-08 |
| `RunParams.brief` | `thesis?`、`boundary?`、`counterpoint?`、`audience?`、`mustInclude?`、`mustAvoid?`、`claims?` | I-10 / I-22 |
| `SettingsRecord` | `imageCostPerImage?`、`maxImageCost?`、`topicScoreWeights?`、`editorialReview?` | I-20 / I-07 / I-12 |

**不新增表**：历史与去重从 `articles` 派生，避免第二套真源。

---

## 5. 实施阶段

### Phase 1 — 发布链闭环（P0）

- 包含：I-01、I-02、I-03、I-04、I-05
- 前置：§6 Q1（图像处理依赖）
- 测试：`tests/host/push-gate.test.ts`、`tests/host/wechat-client.test.ts`、`tests/host/providers-registry.test.ts`
- 退出标准：预检与回读的单测全绿；本地真机推送一篇文章，`draft/get` 回读全部一致；封面宽高比误差 < 0.02 且正文图 < 1MB。

### Phase 2 — 选题（P1）

- 包含：I-06、I-07、I-08、I-09
- 测试：新增 `tests/host/topic-score.test.ts`、`tests/host/hotspots.test.ts` 扩展
- 退出标准：打分与去重纯函数覆盖率 ≥ 90%；10 条候选一次生成，LLM 调用 ≤ 3 次；面板能显示分数与理由。

### Phase 3 — 写作合同与评审（P1）

- 包含：I-10、I-11、I-12、I-13、I-14
- 测试：`tests/host/launch-brief.test.ts`、`tests/host/pipeline-engine.test.ts`、新增评审解析测试
- 退出标准：旧 brief 快照零变化；四条评审判定路径全绿；自动修订最多一轮且可观测。

### Phase 4 — 排版与配图（P2）

- 包含：I-15、I-16、I-17、I-18、I-19、I-20
- 测试：`tests/render/parity.test.ts` 扩展、新增 `tests/host/image-verify.test.ts`
- 退出标准：三种容器 × 三个主题快照稳定；图注不误判；验图三组样本判定正确；无图降级路径不回退成失败。

### Phase 5 — 事实核查（P2，可选）

- 包含：I-21、I-22、I-23
- 测试：工具契约、claim-source 一致性、Crossref mock
- 退出标准：不开启任何开关时，全量回归与现状一致（零行为变化）。

**依赖关系**：Phase 1 独立；Phase 2 依赖 Phase 1 的 `ArticleRecord` 字段（仅为历史派生）；Phase 3 依赖 Phase 2 的 mechanisms；Phase 4 与 Phase 5 互不依赖，可并行。

---

## 6. 开放问题（需拍板）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| **Q1** | 图像裁剪与压缩用什么实现 | A. `sharp`（optionalDependency，原生模块，能力全）<br>B. 纯 JS/WASM 方案（体积可控，能力有限）<br>C. 不引依赖：只做尺寸校验，超限给出明确错误 | **已定：A（sharp 0.35.5 spike 通过）**，加载失败降级为 C 的行为 |
| Q2 | 编辑评审不通过是否阻断推送 | A. blocker 阻断、低分不阻断<br>B. 全部只警告 | **A**：与现有 fail-closed 一致，但保留设置项可关闭 |
| Q3 | 事实核查是否进管线 | A. 独立 agent 工具，不改六步<br>B. 新增 research 步 | **A**：避免破坏 stepper、run 记录与既有测试 |
| Q4 | 三稿是否落库 | A. 派生不落库<br>B. 存三份 Markdown | **A**：单一真源，避免漂移 |
| Q5 | 历史与去重是否新建表 | A. 从 `articles` 派生<br>B. 新增 `history` 表 | **A**：减少迁移面；若后续需要跨设备历史再升级 |

---

## 7. 不采纳项

| 外部做法 | 不采纳原因 |
|---|---|
| `./w` 包装器、`new-article-dir.sh` | 解决 shell 环境变量一致性问题；插件在 host 进程内运行，无此问题 |
| SSH SOCKS 隧道、`publish-via-tunnel.sh` | 项目已有 `wechatApiBaseUrl` 代理缝 + `tools/wechat-relay`，不再引入第二种出网方式 |
| Python 脚本本体（`build-layout.py` 等） | 逻辑产品化进 host（I-15 ~ I-19），不引入 Python 运行时 |
| 「10 条候选全部 AI 速览」 | 成本随条数线性上升；只对前 3 条速览，其余按需点开 |
| 阅读量 / 转发量 / 爆款推断 | 数据源不提供，任何数字都是编的；保持外部流程同样的表述纪律 |
| 面向具体账号的点名与引语 | 版权与风险问题；只做现象级描述 |

---

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 新增图像依赖导致安装失败 | 插件装不上 | optionalDependency + 加载失败降级；CI 增加无该依赖的安装用例 |
| 评审增加 LLM 成本与时延 | 单篇多一次调用、约 +10–30s | 默认开启但可关；超时按「评审不可用」降级 |
| 容器语法破坏既有 Markdown | 旧文章渲染变化 | 仅识别显式 `:::` 块；未命中走原路径；parity 快照守护 |
| 压缩损失画质 | 封面观感下降 | 质量梯度 + 先满足体积；保留原图，可回溯 |
| schema 变更影响旧数据 | 读取失败 | 全部可选字段；`domain.test.ts` 增加旧记录读取用例 |
| 回读校验误报 | 用户不信任校验结果 | 只做确定性比对（标题/作者/字节数/图片数/关键段落），不做语义判断 |

**回滚**：每个 Phase 独立提交；数据字段全部可选，回滚代码后旧记录仍可读；图像依赖为可选，移除后自动走降级路径。

---

## 9. 验收与度量

发布后可观察的指标（不新增遥测，全部来自本地记录）：

- 推送成功率、`pushVerify.ok` 比例；
- 图片平均体积、压缩触发率、验图失败率；
- 门禁通过率与评审 blocker 分布；
- 单篇 LLM 调用次数、成稿 → 推送耗时；
- 选题候选的采纳率（选了第几条）。

---

## 附录 A：外部流程证据索引

| 借鉴点 | 外部文件 |
|---|---|
| 候选打分、已排除清单、编辑推荐 | `20261029-1/选题候选.md` |
| 写作合同（受众/论点/边界/反方/must_include） | `.wewrite/runs/20261029-101247-00948d/brief.yaml` |
| 主张—来源—边界 | `.wewrite/runs/20261029-101247-00948d/claims.yaml`、`sources.yaml` |
| 事实底稿与机制核查 | `20261029-1/research/facts.md`、`mechanisms.md` |
| 五维评审与修订记录 | `.wewrite/runs/20261029-101247-00948d/review-report.json`、`assessment.yaml` |
| 容器与三稿生成 | `20261029-1/build-layout.py`、`排版稿-名词偷懒.md` |
| 图注后处理 | `20261029-1/polish-layout.py` |
| 封面 2.35:1、正文尺寸、成本 | `20261022-1/README-配图说明.md` |
| 量化验图 | `20261022-1/verify-images.py` |
| 压缩到 <1MB | `20261029-1/compress-images.py` |
| 发布前终检 | `20261029-1/final-check.py` |
| 发布后回读 | `20261029-1/verify-publish.py` |
| 发布记录 | `20261029-1/发布记录.txt` |
| 跨篇历史 | `.wewrite/history.yaml` |
| 踩坑清单 | `README-文件管理规范.md` |

## 附录 B：与现有文档的关系

- 本文是**增量计划**，不修改 `docs/prd.md` 的 F1–F9 范围；I-12 / I-21 若被采纳，建议同步在 `docs/spec.md` 增补验收条款。
- 六步管线序列（`topic → outline → draft → gates → render → images`）保持不变；I-12 在 `gates` 内部扩展，I-21 走 agent 工具。
- 所有待拍板项登记在 §6，确认后可迁入 `docs/decisions/OPEN-DECISIONS.md` 作为 D-12 起的决策记录。
