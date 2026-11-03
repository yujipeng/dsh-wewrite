/**
 * 研究底稿（v0.5 来源入管线增强）：
 * 从抓取到的新闻原文里抽取可核实事实、未核实项、表述边界与写作合同，
 * 注入 outline/draft 提示词；模型输出不可解析时降级（返回 undefined），不阻断管线。
 */

import { streamLlmText, type PipelineLlm } from '../llm';
import type { SourceDocument } from './source';

export interface ResearchFact {
  readonly text: string;
  readonly sourceUrl?: string;
  readonly quote?: string;
}

export interface ResearchContract {
  readonly thesis?: string;
  readonly counterpoint?: string;
  readonly audience?: { readonly who?: string; readonly context?: string; readonly question?: string };
  readonly actions?: readonly string[];
}

export interface ResearchNotes {
  readonly facts: readonly ResearchFact[];
  readonly cannotVerify: readonly string[];
  readonly boundary: readonly string[];
  readonly contract?: ResearchContract;
}

export interface ResearchInput {
  readonly topic: string;
  readonly docs: readonly SourceDocument[];
  readonly llmCall: { readonly provider: string; readonly model: string };
  readonly signal: AbortSignal;
}

const MAX_FACTS = 10;
const MAX_CANNOT_VERIFY = 8;
const MAX_BOUNDARY = 5;
const MAX_ACTIONS = 3;
const MAX_EXCERPT_CHARS = 2500;

export function researchSystemPrompt(): string {
  return [
    '你是公众号写作的事实编辑。只输出一个 JSON 对象：不要解释、不要代码围栏。',
    '事实必须来自给定原文；原文没有的时间、人物、事件、数字、引语一律不得添加。',
  ].join('\n');
}

export function researchUserPrompt(topic: string, docs: readonly SourceDocument[]): string {
  const excerpts = docs.map((doc, index) =>
    [`【原文 ${index + 1}】${doc.title || '未命名'} ${doc.url}`, doc.text.slice(0, MAX_EXCERPT_CHARS)].join('\n'),
  );
  return [
    `主题：${topic}`,
    '',
    '请从下面的新闻原文里整理研究底稿，输出 JSON：',
    '{',
    '  "facts": [{"text": "可核实的事实（一句话）", "sourceUrl": "原文 URL", "quote": "原文中的依据片段"}],',
    '  "cannotVerify": ["原文没提供、不能写的信息"],',
    '  "boundary": ["这篇不写什么 / 不判断什么"],',
    '  "contract": {',
    '    "thesis": "一句话核心主张",',
    '    "counterpoint": "最强反方及回应",',
    '    "audience": {"who": "读者", "context": "场景", "question": "关心的问题"},',
    '    "actions": ["三个可执行动作"]',
    '  }',
    '}',
    '',
    '要求：',
    '- facts 只写原文明确支持的内容，每条附原句；没有依据就不要写。',
    '- cannotVerify 列出原文缺失、但读者可能会问的信息（如广告原文、内部决策、财报数字）。',
    '- boundary 写本文的表述边界（不判断动机、不煽动抵制等）。',
    '- contract.actions 必须 3 条，可执行、具体。',
    '',
    ...excerpts,
  ].join('\n');
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

/** 解析研究底稿 JSON；容忍代码围栏与缺字段，完全不可用时返回 undefined。 */
export function parseResearchNotes(raw: string): ResearchNotes | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;

  const facts: ResearchFact[] = Array.isArray(record.facts)
    ? record.facts
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' && String((item as Record<string, unknown>).text).trim()),
        )
        .slice(0, MAX_FACTS)
        .map((item) => ({
          text: String(item.text).trim(),
          ...(typeof item.sourceUrl === 'string' && item.sourceUrl.trim() ? { sourceUrl: item.sourceUrl.trim() } : {}),
          ...(typeof item.quote === 'string' && item.quote.trim() ? { quote: item.quote.trim() } : {}),
        }))
    : [];

  const cannotVerify = stringList(record.cannotVerify, MAX_CANNOT_VERIFY);
  const boundary = stringList(record.boundary, MAX_BOUNDARY);

  let contract: ResearchContract | undefined;
  if (record.contract && typeof record.contract === 'object') {
    const rawContract = record.contract as Record<string, unknown>;
    const rawAudience =
      rawContract.audience && typeof rawContract.audience === 'object'
        ? (rawContract.audience as Record<string, unknown>)
        : undefined;
    const audience = rawAudience
      ? {
          ...(typeof rawAudience.who === 'string' && rawAudience.who.trim() ? { who: rawAudience.who.trim() } : {}),
          ...(typeof rawAudience.context === 'string' && rawAudience.context.trim() ? { context: rawAudience.context.trim() } : {}),
          ...(typeof rawAudience.question === 'string' && rawAudience.question.trim() ? { question: rawAudience.question.trim() } : {}),
        }
      : undefined;
    const actions = stringList(rawContract.actions, MAX_ACTIONS);
    contract = {
      ...(typeof rawContract.thesis === 'string' && rawContract.thesis.trim() ? { thesis: rawContract.thesis.trim() } : {}),
      ...(typeof rawContract.counterpoint === 'string' && rawContract.counterpoint.trim()
        ? { counterpoint: rawContract.counterpoint.trim() }
        : {}),
      ...(audience && Object.keys(audience).length ? { audience } : {}),
      ...(actions.length ? { actions } : {}),
    };
    if (!Object.keys(contract).length) contract = undefined;
  }

  if (!facts.length && !cannotVerify.length && !boundary.length && !contract) return undefined;
  return { facts, cannotVerify, boundary, ...(contract ? { contract } : {}) };
}

/** 一次 LLM 调用生成研究底稿；解析失败重试一次，仍失败返回 undefined（降级）。 */
export async function extractResearchNotes(llm: PipelineLlm, input: ResearchInput): Promise<ResearchNotes | undefined> {
  const options = {
    purpose: 'wewrite-research',
    system: researchSystemPrompt(),
    user: researchUserPrompt(input.topic, input.docs),
    provider: input.llmCall.provider,
    model: input.llmCall.model,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await streamLlmText(llm, options, input.signal);
    if (outcome.status !== 'ok') return undefined;
    const notes = parseResearchNotes(outcome.text);
    if (notes) return notes;
  }
  return undefined;
}
