/**
 * 选题确定性打分与近 7 天去重（I-07）。
 * LLM 只给 heat/relevance/value 三个 0–10 分；总分、去重、排序全部由本模块完成。
 */

export interface TopicScoreInput {
  readonly title: string;
  readonly heat: number;
  readonly relevance: number;
  readonly value: number;
}

export interface TopicHistory {
  /** 近 7 天文章标题（来自 articles 表，不新增表）。 */
  readonly titles?: readonly string[];
  /** 手动维护的已写关键词（I-14 前的轻量形态）。 */
  readonly keywords?: readonly string[];
}

export interface TopicScoreWeights {
  readonly heat: number;
  readonly relevance: number;
  readonly value: number;
  readonly duplicatePenalty: number;
}

export const DEFAULT_TOPIC_SCORE_WEIGHTS: TopicScoreWeights = {
  heat: 0.3,
  relevance: 0.4,
  value: 0.3,
  duplicatePenalty: 3,
};

export interface TopicScoreResult {
  readonly score: number;
  readonly duplicateHits: readonly string[];
  readonly historyMark?: string;
}

/** 标题 bigram 相似度阈值：低于该值不视为同题。 */
const SIMILARITY_THRESHOLD = 0.5;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, value));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text: string): Set<string> {
  const chars = [...text];
  const set = new Set<string>();
  if (chars.length < 2) {
    if (chars.length === 1) set.add(chars[0]);
    return set;
  }
  for (let index = 0; index < chars.length - 1; index += 1) {
    set.add(`${chars[index]}${chars[index + 1]}`);
  }
  return set;
}

/** Dice 系数（0–1）：对短标题比 Jaccard 更宽容，适合判断「同题」。 */
function similarity(left: string, right: string): number {
  const a = bigrams(normalize(left));
  const b = bigrams(normalize(right));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const gram of a) {
    if (b.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (a.size + b.size);
}

export function scoreTopic(
  input: TopicScoreInput,
  history: TopicHistory = {},
  weights: TopicScoreWeights = DEFAULT_TOPIC_SCORE_WEIGHTS,
): TopicScoreResult {
  const base =
    clampScore(input.heat) * weights.heat
    + clampScore(input.relevance) * weights.relevance
    + clampScore(input.value) * weights.value;

  const hits: string[] = [];
  const normalizedTitle = normalize(input.title);
  for (const keyword of history.keywords ?? []) {
    const normalizedKeyword = normalize(keyword);
    if (normalizedKeyword.length >= 2 && normalizedTitle.includes(normalizedKeyword)) {
      hits.push(keyword);
    }
  }
  for (const pastTitle of history.titles ?? []) {
    if (similarity(input.title, pastTitle) >= SIMILARITY_THRESHOLD) hits.push(pastTitle);
  }

  const duplicateHits = [...new Set(hits)];
  const penalty = duplicateHits.length > 0 ? weights.duplicatePenalty : 0;
  const score = Math.round(Math.min(10, Math.max(0, base - penalty)) * 10) / 10;

  return {
    score,
    duplicateHits,
    ...(duplicateHits.length > 0
      ? { historyMark: `近 7 天已写：${duplicateHits.slice(0, 3).join('、')}` }
      : {}),
  };
}
