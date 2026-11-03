/**
 * 五维编辑评审（I-12）：规则门禁通过后，在 gates 步内部追加一次 LLM 评审。
 * 不新增管线步骤；LLM 失败/超时/解析失败一律降级为「评审不可用」，不阻断成稿。
 * 判定：任一维 < 3.5 或存在 blocker → 不通过；majorIssues 只记录。
 */

import { streamLlmText, styleGuideLines, type PipelineLlm } from '../llm';
import type { WritingProfile } from '../../../shared/schema-base';
import type { HostLogger } from '../../platform';

export const REVIEW_DIMENSIONS = ['accuracy', 'viewpoint', 'usefulness', 'voice', 'readability'] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const REVIEW_DIMENSION_LABELS: Readonly<Record<ReviewDimension, string>> = {
  accuracy: '事实准确',
  viewpoint: '观点成立',
  usefulness: '有用性',
  voice: '表达人格',
  readability: '可读性',
};

export const DEFAULT_REVIEW_THRESHOLD = 3.5;

export interface EditorialReview {
  readonly dimensions: Readonly<Record<ReviewDimension, number>>;
  readonly blockers: readonly string[];
  readonly majorIssues: readonly string[];
  /** I-14：本篇使用的解释机制（如沉没成本/损失厌恶），供跨篇去重。 */
  readonly mechanisms: readonly string[];
  readonly notes: string;
  readonly model: string;
  readonly generatedAtIso: string;
}

export interface EditorialReviewDeps {
  readonly llm: PipelineLlm;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly logger: HostLogger;
  readonly nowIso: () => string;
}

export interface EditorialReviewInput {
  readonly markdown: string;
  readonly topic?: string;
  /** 本账号风格基线（含风格指南与范文）；用来给 voice 维度定标，不参与事实判断。 */
  readonly profile?: WritingProfile;
}

const SYSTEM_PROMPT = [
  '你是一位严格但克制的公众号编辑，对成稿做五维评审。',
  '只输出一个 JSON 对象，不要 Markdown 代码围栏、不要解释、不要前后缀文字。',
  '评分 0–5，保留一位小数；blockers 只放会导致事实错误、自相矛盾、编造亲历等不可发布的问题。',
].join('');

function userPrompt(input: EditorialReviewInput): string {
  const styleLines = styleGuideLines(input.profile);
  return [
    input.topic ? `主题：${input.topic}` : '',
    ...(styleLines.length
      ? ['', '本账号风格基线（voice 维度按它打分；与事实冲突时以准确为先）：', ...styleLines]
      : []),
    '请评审下面的成稿，严格输出 JSON：',
    '{"dimensions":{"accuracy":0,"viewpoint":0,"usefulness":0,"voice":0,"readability":0},"blockers":[],"majorIssues":[],"mechanisms":[],"notes":"一句话总评"}',
    '字段说明：accuracy=事实准确；viewpoint=论证是否成立；usefulness=读者能否用上；voice=是否贴合给定风格基线（无基线时看表达是否稳定可信，重点核对每千字数字密度、问号、第一人称、连续单句段与对偶句频率）；readability=结构与节奏；mechanisms=本篇用到的解释机制（2–5 条，如沉没成本、损失厌恶、社会证明）。',
    'majorIssues 每条必须引用成稿里的具体句子或数据，并指出它违反的风格条款（如「每千字数字 < 20」「连续 3 段单句成段」「设问推进过多」）或事实问题；不要写「表达不错」「可以更生动」这类空评。',
    '',
    '成稿：',
    input.markdown,
  ].filter(Boolean).join('\n');
}

function clampDimension(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(5, Math.max(0, parsed));
}

function readStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** 从模型输出里提取 JSON 并归一化；非法输出返回 null（调用方降级）。 */
export function parseEditorialReview(
  text: string,
  model: string,
  generatedAtIso: string,
): EditorialReview | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const rawDimensions = record.dimensions;
  if (!rawDimensions || typeof rawDimensions !== 'object') return null;
  const dimensionsRecord = rawDimensions as Record<string, unknown>;
  const dimensions = Object.fromEntries(
    REVIEW_DIMENSIONS.map((dimension) => [dimension, clampDimension(dimensionsRecord[dimension])]),
  ) as Record<ReviewDimension, number>;

  return {
    dimensions,
    blockers: readStringArray(record.blockers, 8),
    majorIssues: readStringArray(record.majorIssues, 12),
    mechanisms: readStringArray(record.mechanisms, 8),
    notes: typeof record.notes === 'string' ? record.notes.trim().slice(0, 500) : '',
    model,
    generatedAtIso,
  };
}

/** 判定：任一维低于阈值或存在 blocker → 不通过；majorIssues 只记录。 */
export function judgeEditorialReview(
  review: EditorialReview,
  threshold: number = DEFAULT_REVIEW_THRESHOLD,
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const dimension of REVIEW_DIMENSIONS) {
    const score = review.dimensions[dimension];
    if (score < threshold) {
      issues.push(`评审维度「${REVIEW_DIMENSION_LABELS[dimension]}」${score.toFixed(1)} 分，低于 ${threshold}`);
    }
  }
  for (const blocker of review.blockers) issues.push(`评审 blocker：${blocker}`);
  return { passed: issues.length === 0, issues };
}

export interface ReviewOutcome {
  readonly review: EditorialReview | null;
  /** 评审不可用的原因（未配置模型 / LLM 错误 / JSON 解析失败 / 超时）。 */
  readonly reason?: string;
  /** 实际尝试次数（配置缺失时为 0，正常最多 2）。 */
  readonly attempts: number;
}

/** 单次评审尝试；任何失败都返回原因，不抛错。 */
async function attemptReview(deps: EditorialReviewDeps, input: EditorialReviewInput): Promise<{ review: EditorialReview | null; reason?: string }> {
  const { provider, model } = deps;
  if (!provider || !model) return { review: null, reason: '未配置评审模型（provider/model 为空）' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const outcome = await streamLlmText(
      deps.llm,
      {
        purpose: 'wewrite-editorial-review',
        system: SYSTEM_PROMPT,
        user: userPrompt(input),
        provider,
        model,
        maxTokens: 33_000,
      },
      controller.signal,
    );
    if (outcome.status !== 'ok' || !outcome.text) {
      const reason =
        outcome.status === 'aborted'
          ? `评审超时（>${deps.timeoutMs}ms）`
          : outcome.status === 'error'
            ? `LLM 错误：${outcome.message}`
            : 'LLM 返回空文本';
      deps.logger.warn(`editorial review 降级：${reason}`);
      return { review: null, reason };
    }
    const review = parseEditorialReview(outcome.text, model, deps.nowIso());
    if (!review) {
      deps.logger.warn('editorial review 降级：JSON 解析失败');
      return { review: null, reason: '评审 JSON 解析失败' };
    }
    return { review };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`editorial review 降级：${reason}`);
    return { review: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** 评审（失败重试一次）；仍失败返回结构化原因，供 run metrics 记录。 */
export async function reviewArticle(
  deps: EditorialReviewDeps,
  input: EditorialReviewInput,
): Promise<ReviewOutcome> {
  if (!deps.provider || !deps.model) {
    return { review: null, reason: '未配置评审模型（provider/model 为空）', attempts: 0 };
  }
  let lastReason: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await attemptReview(deps, input);
    if (result.review) return { review: result.review, attempts: attempt };
    lastReason = result.reason;
    // 超时不再重试（下一次仍会等满超时）；其他失败给一次重试。
    if (result.reason?.startsWith('评审超时')) break;
  }
  return { review: null, ...(lastReason ? { reason: lastReason } : {}), attempts: 2 };
}
