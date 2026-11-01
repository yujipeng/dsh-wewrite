/**
 * 管线文本步的 LLM 访问层（ADR-003：宿主直调 ctx.llm.stream，F22 辅助调用先例）。
 * 2026-08-19 真机校准：宿主 dsh-llm seam 的真实协议是
 * GenerateOptions{provider, model, system, messages[{role, content:[{type:'text',text}]}], purpose}
 * 与 StreamChunk{text-delta | finish(reason.kind)}；旧版按 {type:'text'} 块 + content 传字符串，
 * 在真宿主上产出 0 字空稿（v0.1.4 缺陷），本层按真实协议重写。
 */

import type { WritingProfile } from '../../shared/schema-base';

export interface LlmStreamOptions {  /** 辅助调用标注（F22）：wewrite-pipeline。 */
  readonly purpose: string;
  /** 宿主 GenerateOptions.system：系统提示独立字段，不进 messages。 */
  readonly system: string;
  /** 用户轮提示全文（outline/draft 各自组装）。 */
  readonly user: string;
  /** 宿主已注册的供应商路由 id（必填，GenerateOptions.provider）。 */
  readonly provider: string;
  /** 供应商下点名的模型 id（必填，GenerateOptions.model）。 */
  readonly model: string;
  readonly maxTokens?: number;
}

/** 宿主 StreamChunk 的最小依赖面：text-delta 承载增量文本，finish.reason 承载终态。 */
export type PipelineLlmChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | {
      readonly type: 'finish';
      readonly reason: {
        readonly kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error';
        readonly failure?: { readonly code?: string; readonly message: string };
      };
    }
  | { readonly type: string; readonly [field: string]: unknown };

/** 宿主 GenerateOptions 的最小形状依赖（seam 实际读取字段的子集）。 */
export interface PipelineLlm {
  stream(options: Record<string, unknown>): AsyncIterable<PipelineLlmChunk> | Promise<AsyncIterable<PipelineLlmChunk>>;
}

/** 组装宿主 GenerateOptions（只带 seam 会读的字段；source 按 Message 协议最小声明）。 */
function toHostOptions(options: LlmStreamOptions): Record<string, unknown> {
  return {
    purpose: options.purpose,
    provider: options.provider,
    model: options.model,
    system: options.system,
    messages: [
      {
        id: `wewrite-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: options.user }],
        source: { kind: 'plugin', plugin: 'dsh-wewrite', form: 'live' },
      },
    ],
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  };
}

/** 把流式 text-delta 组装为完整文本。 */
export class BlockAssembler {
  private readonly parts: string[] = [];

  push(chunk: PipelineLlmChunk): void {
    if (chunk.type !== 'text-delta') return;
    const text = (chunk as { text?: unknown }).text;
    if (typeof text === 'string' && text) this.parts.push(text);
  }

  getText(): string {
    return this.parts.join('').trim();
  }
}

export type LlmStepOutcome =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'aborted' }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

/** 消费一次 stream 至终端 finish chunk；AbortSignal 中止与供应商错误显式分流。 */
export async function streamLlmText(
  llm: PipelineLlm,
  options: LlmStreamOptions,
  signal: AbortSignal,
): Promise<LlmStepOutcome> {
  const assembler = new BlockAssembler();
  const iterable = await llm.stream(toHostOptions(options));
  for await (const chunk of iterable) {
    if (signal.aborted) return { status: 'aborted' };
    if (chunk.type === 'text-delta') {
      assembler.push(chunk);
      continue;
    }
    if (chunk.type === 'finish') {
      const reason = (chunk as { reason?: { kind?: string; failure?: { code?: string; message?: string } } }).reason;
      if (reason?.kind === 'aborted') return { status: 'aborted' };
      if (reason?.kind === 'error') {
        return {
          status: 'error',
          code: reason.failure?.code || 'llm-error',
          message: reason.failure?.message || '供应商返回错误（无详细信息）',
        };
      }
      return { status: 'ok', text: assembler.getText() };
    }
  }
  return { status: 'ok', text: assembler.getText() };
}

const SYSTEM_STYLE = [
  '你是一位长期写公众号的作者，行文克制、信息密度高。',
  '不写套话与总结腔，不用「总而言之」「值得一提」一类空转词。',
  '先给具体事实与场景，再给机制与判断；读者是谁、写到多深，以写作要求为准。',
].join('');

/** 公众号写作要求（来自设置页，参考 wechat-article/.wewrite/style.yaml）；空项不注入。 */
export function writingProfileLines(profile?: WritingProfile): string[] {
  if (!profile) return [];
  const lines: string[] = [];
  if (profile.name) lines.push(`公众号：${profile.name}${profile.industry ? `（${profile.industry}）` : ''}`);
  if (profile.topics.length) lines.push(`主题方向：${profile.topics.join('、')}`);
  if (profile.tone) lines.push(`语气：${profile.tone}`);
  if (profile.voice) lines.push(`人称与视角：${profile.voice}`);
  if (profile.wordCount) lines.push(`目标字数：${profile.wordCount}`);
  if (profile.contentStyle) lines.push(`内容风格：${profile.contentStyle}`);
  if (profile.persona) lines.push(`写作人格：${profile.persona}`);
  if (profile.blacklistWords.length) lines.push(`禁用词（不得出现）：${profile.blacklistWords.join('、')}`);
  if (profile.blacklistTopics.length) lines.push(`不写的话题：${profile.blacklistTopics.join('、')}`);
  return lines;
}

/** 风格指南与范文的长度上限（提示词层兜底；schema 已限制保存值）。 */
const STYLE_GUIDE_MAX_CHARS = 4000;
const EXEMPLAR_EXCERPT_MAX_CHARS = 2000;

function truncateForPrompt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

/**
 * 风格基准与范文块（I-24）：只校准结构与节奏，空值不注入。
 * 范文必须带「禁止复用」声明；超长内容按注入预算截断。
 */
export function styleGuideLines(profile?: WritingProfile): string[] {
  if (!profile) return [];
  const lines: string[] = [];
  const guide = profile.styleGuide.trim();
  if (guide) {
    lines.push('', '文风基准（必须遵守；与事实冲突时以事实与来源约束为准）：', truncateForPrompt(guide, STYLE_GUIDE_MAX_CHARS));
  }
  const exemplars = profile.styleExemplars.filter((item) => item.excerpt.trim()).slice(0, 3);
  if (exemplars.length) {
    lines.push('', '风格样例（只校准结构、段落节奏与语气；禁止复用其中的观点、句子、数字组合、人物和个人经历）：');
    exemplars.forEach((item, index) => {
      lines.push(`【样例 ${index + 1}】${item.title.trim() || '未命名'}`);
      if (item.learn.trim()) lines.push(`学习点：${item.learn.trim()}`);
      lines.push(truncateForPrompt(item.excerpt.trim(), EXEMPLAR_EXCERPT_MAX_CHARS));
    });
  }
  return lines;
}

/** 启动 brief 的 prompt 投影（v0.5 变密度输入，docs/v0.5-launch-brief.md）。 */
export interface LaunchBriefForPrompt {
  readonly title?: string;
  readonly approach?: string;
  readonly outline?: readonly string[];
  readonly sources?: readonly string[];
  readonly thesis?: string;
  readonly boundary?: string;
  readonly counterpoint?: string;
  readonly audience?: { readonly who?: string; readonly context?: string; readonly question?: string };
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  /** I-22：主张—来源—边界；fact 类必须带 sourceIds。 */
  readonly claims?: readonly {
    readonly id: string;
    readonly text: string;
    readonly type: 'fact' | 'opinion';
    readonly doi?: string;
    readonly sourceIds?: readonly string[];
    readonly status?: 'supported' | 'bounded';
    readonly boundary?: string;
  }[];
}

export function outlineUserPrompt(
  topic: string,
  brief?: LaunchBriefForPrompt,
  retryMissing?: readonly string[],
  profile?: WritingProfile,
): string {
  const skeleton = brief?.outline?.length ? brief.outline : undefined;
  const profileLines = writingProfileLines(profile);
  const profileBlock = profileLines.length ? ['公众号写作要求：', ...profileLines, ''] : [];
  const styleBlock = styleGuideLines(profile);
  if (skeleton) {
    // 骨架绑模式：给定节名合同（原样保留、顺序不变），LLM 只做补洞。
    return [
      `主题：${topic}`,
      '',
      ...profileBlock,
      ...styleBlock,
      '用户已定大纲骨架——以下节名必须原样保留（一字不改）、相对顺序不变：',
      ...skeleton.map((section) => `- ${section}`),
      '',
      '你的任务是补洞：',
      '- 可以在骨架节之间补充必要小节（证据/对比/结尾），每节一句话说明覆盖的具体内容；',
      '- 标注每节计划出现的证据类型（数据/命令/对比/亲历细节）；',
      '- 输出完整大纲（给定节与补充节合并），不得改写、合并、拆分或删除给定节名。',
      ...(retryMissing?.length
        ? ['', `上一次输出遗漏了以下给定节，本次必须原样包含：${retryMissing.map((section) => `「${section}」`).join('、')}`]
        : []),
    ].join('\n');
  }
  return [
    `主题：${topic}`,
    '',
    ...profileBlock,
    ...styleBlock,
    '请给出一篇文章大纲：',
    '- 5 到 8 个二级标题小节，每节一句话说明要覆盖的具体内容；',
    '- 标注每节计划出现的具体证据类型（数据/命令/对比/亲历细节）；',
    '- 不写引言节与总结节，首节直接切入主体。',
  ].join('\n');
}

export function draftUserPrompt(
  topic: string,
  outline: string,
  brief?: LaunchBriefForPrompt,
  retryMissingOutline?: readonly string[],
  retryInvisibleSources?: readonly string[],
  profile?: WritingProfile,
): string {
  const lines: string[] = [`主题：${topic}`];
  const profileLines = writingProfileLines(profile);
  if (profileLines.length) lines.push('', '公众号写作要求：', ...profileLines);
  lines.push(...styleGuideLines(profile));
  if (brief?.title) {
    lines.push(`已定标题：《${brief.title}》——全文围绕这个题目展开；正文仍不出现一级标题（由发布字段承载）。`);
  }
  if (brief?.approach) {
    lines.push('', '总体思路（用户主张，全文必须围绕它展开，不得偏离）：', brief.approach);
  }
  if (brief?.thesis) {
    lines.push('', '核心主张（全文论证围绕它展开）：', brief.thesis);
  }
  if (brief?.boundary) {
    lines.push('', '边界（这篇不写什么，不要越界）：', brief.boundary);
  }
  if (brief?.counterpoint) {
    lines.push('', '最强反方与回应：', brief.counterpoint);
  }
  if (brief?.audience) {
    const audience = [
      brief.audience.who ? `- 读者：${brief.audience.who}` : '',
      brief.audience.context ? `- 场景：${brief.audience.context}` : '',
      brief.audience.question ? `- 关心的问题：${brief.audience.question}` : '',
    ].filter(Boolean);
    if (audience.length) lines.push('', '目标读者：', ...audience);
  }
  if (brief?.mustInclude?.length) {
    lines.push('', '必须出现的事实/机制（正文需原样出现）：', ...brief.mustInclude.map((item) => `- ${item}`));
  }
  if (brief?.mustAvoid?.length) {
    lines.push('', '不得出现的内容（正文禁止出现）：', ...brief.mustAvoid.map((item) => `- ${item}`));
  }
  if (brief?.claims?.length) {
    lines.push(
      '',
      '事实主张（fact 类必须带来源 URL；opinion 可无来源）：',
      ...brief.claims.map((claim) => {
        const sources = claim.sourceIds?.length ? `（来源：${claim.sourceIds.join('、')}）` : '';
        const boundary = claim.boundary ? `（边界：${claim.boundary}）` : '';
        return `- [${claim.type}] ${claim.text}${sources}${boundary}`;
      }),
    );
  }
  if (brief?.sources?.length) {
    lines.push(
      '',
      '引用来源约束：',
      '- 事实引用优先锚定以下来源；',
      '- 来源以可见 URL 文本呈现（如「（来源：URL）」或括号内裸链接）——不要用 Markdown 链接语法 []()，微信会剥离锚标签导致链接丢失；',
      '- 不得编造未提供的 URL。',
      ...brief.sources.map((url) => `- ${url}`),
    );
  }
  lines.push(
    '',
    '大纲如下：',
    outline,
    '',
    '请成稿：',
    '- Markdown 输出，标题层级从 ## 开始（一级标题由发布字段承载，正文不出现）；',
    '- 每节至少两处可核验的具体信息（数字、时间、研究细节、场景动作或对比结论），并把这节的机制展开成连续推理，不要只留结论金句；',
    '- 段落与句式按写作要求里的风格指南展开；未给定风格指南时，段均 2–2.5 句、句长均值 22–24 字，连续 3 段以上单句成段时插入一段展开；',
    '- 正文配图位置以「![描述](图片待生成)」占位，后续管线会替换。',
  );
  if (retryMissingOutline?.length) {
    lines.push(
      '',
      `上一次成稿遗漏/改写了以下给定节名，本次必须原样保留（节名一字不改）：${retryMissingOutline
        .map((section) => `「${section}」`)
        .join('、')}`,
    );
  }
  if (retryInvisibleSources?.length) {
    lines.push(
      '',
      '上一次成稿把以下来源写成了 Markdown 链接（微信会剥离锚标签，读者看不到 URL）——本次必须以裸 URL 文本引用（如「（来源：URL）」）：',
      ...retryInvisibleSources.map((url) => `- ${url}`),
    );
  }
  return lines.join('\n');
}

export function pipelineSystemPrompt(profile?: WritingProfile): string {
  const lines = writingProfileLines(profile);
  const identity = profile && (profile.name.trim() || profile.industry.trim())
    ? '账号定位与读者由下面的写作要求决定，不要套用其他领域的读者预设或行文习惯。'
    : '';
  return lines.length ? [SYSTEM_STYLE, identity, ...lines].filter(Boolean).join('\n') : SYSTEM_STYLE;
}

// ── 文章改写提示（uiux v0.3 §3；只输出改写文本，无围栏无前后语）──────────────────

export function rewriteSystemPrompt(): string {
  return [
    '你是一位公众号写作的改稿助手，负责按指令改写作者选中的段落。',
    '只输出改写后的文本：无前言后语、无解释、无代码围栏。',
    '保持 Markdown 结构不变：标题层级、列表、代码块的骨架原样保留。',
    '忠实执行改写指令，不虚构原文没有的事实。',
  ].join('');
}

export function rewriteUserPrompt(input: { readonly text: string; readonly instruction: string; readonly title?: string }): string {
  return [
    ...(input.title ? [`文章题名（语气锚点）：${input.title}`] : []),
    `改写指令：${input.instruction}`,
    '',
    '原文：',
    input.text,
  ].join('\n');
}
