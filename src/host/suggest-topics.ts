/**
 * 建议选题（选题中心右栏）：写作要求 + 热榜 → 最多 10 条可写选题。
 *
 * 与 agent 工具 wewrite_suggest_topics（热榜 top-N + 逐条速览）不同：这里是「筛选」——
 * 只从给定热榜中挑条目、按写作要求排除无关热点，并把原标题改写成公众号可用的建议标题。
 * LLM 输出为行结构纯文本（不依赖 Markdown/JSON 解析），格式不符时由调用方重试一次。
 */

import type { HotspotItem, SuggestedTopicView } from '../shared/contract';
import type { WritingProfile } from '../shared/schema-base';
import { streamLlmText, writingProfileLines, type LlmStepOutcome, type PipelineLlm } from './pipeline/llm';
import type { HostLogger } from './platform';
import { WewriteServiceError } from './service-errors';

export interface SuggestTopicsDeps {
  readonly llm: PipelineLlm;
  /** settings.llmDefault 透传；缺省即 llm-not-configured。 */
  readonly provider?: string;
  readonly model?: string;
  readonly logger: HostLogger;
  readonly profile: WritingProfile;
  /** 单次 LLM 调用超时毫秒（默认 45s；测试注入缩短值验证 abort 分支）。 */
  readonly timeoutMs: number;
  readonly nowIso: () => string;
}

export interface SuggestTopicsOutcome {
  readonly topics: SuggestedTopicView[];
  readonly generatedAtIso: string;
  readonly model: string;
  readonly profileUsed: boolean;
  readonly totalHotspots: number;
}

/** 单次调用上限（bigmodel 带 thinking 时 max_tokens 必须 >32000，与速览/改写同口径）。 */
const SUGGEST_MAX_TOKENS = 33_000;
const MAX_ATTEMPTS = 2;
const TITLE_MAX_CHARS = 60;
const ANGLE_MAX_CHARS = 120;

/**
 * 写作要求是否足以参与筛选（封面风格与选题无关，不计入）。
 * 全空时仍生成通用建议，UI 顶部提示补充写作要求。
 */
export function hasWritingProfile(profile: WritingProfile): boolean {
  return Boolean(
    profile.name.trim()
    || profile.industry.trim()
    || profile.topics.length
    || profile.tone.trim()
    || profile.voice.trim()
    || profile.wordCount.trim()
    || profile.contentStyle.trim()
    || profile.persona.trim()
    || profile.blacklistWords.length
    || profile.blacklistTopics.length,
  );
}

/** 黑名单词（不写的话题 + 禁用词）：命中即排除，提示词与解析后各过滤一次。 */
function blockedTerms(profile: WritingProfile): string[] {
  return [...profile.blacklistTopics, ...profile.blacklistWords]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
}

function hitsBlocked(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const lowered = text.toLowerCase();
  return terms.some((term) => lowered.includes(term));
}

/** 黑名单硬过滤：标题命中的热榜条目不进候选（宁可少推，不推用户明确不写的话题）。 */
export function filterHotspots(hotspots: readonly HotspotItem[], profile: WritingProfile): HotspotItem[] {
  const terms = blockedTerms(profile);
  return hotspots.filter((item) => !hitsBlocked(item.title, terms));
}

const SYSTEM_PROMPT = [
  '你是一位中文公众号选题编辑，替作者从当日热榜里挑出真正值得写的选题。',
  '只输出中文纯文本，不用 Markdown 记号，不加表头、解释或空行；严格按用户给定的行结构输出。',
  '标题与角度都要具体、克制，不写套话，不用「震惊」「必看」一类夸张词。',
].join('');

function buildUserPrompt(input: {
  readonly profile: WritingProfile;
  readonly hotspots: readonly HotspotItem[];
  readonly count: number;
  readonly correction?: string;
}): string {
  const { profile, hotspots, count } = input;
  const lines = writingProfileLines(profile);
  const profileBlock = lines.length
    ? ['【公众号写作要求】', ...lines, '']
    : ['【公众号写作要求】', '作者还没有填写写作要求——按「适合普通中文公众号读者、有明确信息增量或情绪共鸣」的通用标准筛选。', ''];

  const hotspotLines = hotspots.map((item, index) => `[${index + 1}] ${item.source} #${item.rank} ${item.title}`);

  return [
    ...profileBlock,
    '【筛选标准】',
    '- 只从下面给出的热榜条目中选，不得引入热榜之外的热点，也不得编造事实；',
    '- 优先选与账号定位、主题方向、目标读者强相关的条目；与这些方向无关的热点一律不选；',
    '- 不选「不写的话题」涉及的内容，建议标题与角度都不得出现禁用词；',
    '- 建议标题按公众号标题习惯改写（不超过 30 字，具体、可读，不照抄原标题）；',
    '- 每条给一句话角度（不超过 40 字）：这篇写什么、读者能得到什么；',
    `- 按推荐优先级从高到低排序，最多 ${count} 条；尽量凑满 ${count} 条，同一热点最多用两次（两个不同角度）。`,
    '',
    '【热榜条目】',
    ...hotspotLines,
    '',
    '【输出格式】',
    `严格输出最多 ${count} 行，每行四个字段，用「|||」分隔：`,
    '序号 ||| 建议标题 ||| 一句话角度 ||| 热点序号',
    '其中「热点序号」是上面方括号里的编号。',
    ...(input.correction ? ['', `【纠正】${input.correction}`] : []),
  ].join('\n');
}

/** 去掉粗体、反引号、列表符号与整体包裹的引号（标题内部引号保留）。 */
function cleanField(value: string): string {
  return value
    // 先消粗体再消列表符号：否则 `- **标题**` 的首字符会被当成列表 `*` 吃掉一半。
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*•]\s*/, '')
    // 3 段格式可能把序号写在标题前（`2. 「标题」 ||| 角度 ||| 来源`）；要求序号后跟空白，避免误伤「3.15 晚会」这类标题。
    .replace(/^\d{1,3}\s*[.、)]\s+/, '')
    // 先 trim 再剥引号：字段两侧常带空格，`^《`/`》$` 直接匹配会落空。
    .trim()
    .replace(/^[《「『"'“”]+/, '')
    .replace(/[》」』"'“”]+$/, '')
    .trim();
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trim() : value;
}

/**
 * 解析模型输出：每行 `序号 ||| 标题 ||| 角度 ||| 热点序号`。
 * 失败行静默跳过；标题去重、来源越界丢弃、黑名单二次过滤；最多 count 条。
 */
export function parseSuggestedTopicLines(
  text: string,
  hotspots: readonly HotspotItem[],
  count: number,
  profile: WritingProfile,
): SuggestedTopicView[] {
  const terms = blockedTerms(profile);
  const seen = new Set<string>();
  const topics: SuggestedTopicView[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (topics.length >= count) break;
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|||').map((part) => part.trim());
    // 兼容 4 段（序号 ||| 标题 ||| 角度 ||| 来源）与 3 段（标题 ||| 角度 ||| 来源）。
    if (parts.length < 3) continue;
    const headIsIndex = /^\d{1,3}$/.test(cleanField(parts[0] ?? ''));
    const title = clamp(cleanField(parts[headIsIndex ? 1 : 0] ?? ''), TITLE_MAX_CHARS);
    const angle = clamp(cleanField(parts[headIsIndex ? 2 : 1] ?? ''), ANGLE_MAX_CHARS);
    if (!title || !angle || seen.has(title)) continue;

    // 热点序号取来源段里最后一个纯数字（容忍模型在末尾多带字段）。
    const sourceNumberText = [...parts.slice(headIsIndex ? 3 : 2)]
      .map((part) => cleanField(part))
      .reverse()
      .find((part) => /^\d{1,3}$/.test(part));
    if (!sourceNumberText) continue;
    const sourceNumber = Number.parseInt(sourceNumberText, 10);
    const hotspot = hotspots[sourceNumber - 1];
    if (!hotspot) continue;
    if (hitsBlocked(`${title} ${angle}`, terms)) continue;

    seen.add(title);
    topics.push({
      title,
      angle,
      source: hotspot.source,
      sourceRank: hotspot.rank,
      sourceTitle: hotspot.title,
      sourceUrl: hotspot.url,
    });
  }

  return topics;
}

/** 单次 LLM 调用（超时 → aborted；供应商错误 → error），供主流程重试复用。 */
async function requestOnce(deps: SuggestTopicsDeps, user: string): Promise<LlmStepOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    return await streamLlmText(
      deps.llm,
      {
        purpose: 'wewrite-suggest-topics',
        system: SYSTEM_PROMPT,
        user,
        provider: deps.provider ?? '',
        model: deps.model ?? '',
        maxTokens: SUGGEST_MAX_TOKENS,
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成建议选题：格式解析为 0 条时带纠正提示重试一次，仍失败抛 suggest-parse-failed。
 * 不负责缓存（由 service 层按写作要求 + count 缓存）。仅配置/供应商/格式错误抛出。
 */
export async function suggestTopics(
  deps: SuggestTopicsDeps,
  hotspots: readonly HotspotItem[],
  count: number,
): Promise<SuggestTopicsOutcome> {
  const startedAt = Date.now();
  const { provider, model } = deps;
  if (!provider || !model) {
    throw new WewriteServiceError('llm-not-configured', '尚未配置默认模型：请先到「设置」里选择 AI 供应商与模型，再生成建议选题');
  }
  if (hotspots.length === 0) {
    throw new WewriteServiceError('suggest-no-hotspots', '热榜还没有条目：先刷新热榜，再生成建议选题');
  }

  const candidates = filterHotspots(hotspots, deps.profile);
  if (candidates.length === 0) {
    throw new WewriteServiceError('suggest-no-hotspots', '热榜条目都被「不写的话题 / 禁用词」排除了，可以放宽写作要求或稍后重试');
  }
  const target = Math.min(count, candidates.length);

  let correction: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const outcome = await requestOnce(
      deps,
      buildUserPrompt({ profile: deps.profile, hotspots: candidates, count: target, ...(correction ? { correction } : {}) }),
    );

    if (outcome.status === 'aborted') {
      throw new WewriteServiceError('suggest-timeout', `建议选题生成超时（${Math.round(deps.timeoutMs / 1000)} 秒），已取消，请重试`);
    }
    // 供应商错误码/文案原样透传（与速览/改写同口径）
    if (outcome.status === 'error') throw new WewriteServiceError(outcome.code, outcome.message);

    if (!outcome.text) {
      if (attempt === MAX_ATTEMPTS) throw new WewriteServiceError('suggest-empty', '模型没有返回任何建议选题，请重试');
      correction = '上一次没有输出内容。本次必须按行结构输出选题。';
      continue;
    }

    const topics = parseSuggestedTopicLines(outcome.text, candidates, target, deps.profile);
    if (topics.length > 0) {
      deps.logger.info(
        `suggest topics ok：${topics.length}/${target} 条，热榜 ${hotspots.length} 条，model=${model} ${Date.now() - startedAt}ms`,
      );
      return {
        topics,
        generatedAtIso: deps.nowIso(),
        model,
        profileUsed: hasWritingProfile(deps.profile),
        totalHotspots: hotspots.length,
      };
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new WewriteServiceError('suggest-parse-failed', '模型输出没有可解析的选题（格式不符），请重试');
    }
    correction = '上一次输出没有被解析出任何选题：每行必须用「|||」分隔四个字段，并以热榜方括号编号结尾。';
  }

  // 循环内已覆盖全部终态；这里只是类型收窄的兜底。
  throw new WewriteServiceError('suggest-parse-failed', '模型输出没有可解析的选题（格式不符），请重试');
}
