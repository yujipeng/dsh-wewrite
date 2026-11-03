/**
 * 标题提炼（P4）：成稿通过门禁后，从正文提炼 3 个带判断/冲突的标题候选。
 * brief.title 已给定时不调用（用户标题优先，不覆盖）。
 */

import { streamLlmText, type PipelineLlm } from '../llm';

export interface TitleSuggestionInput {
  readonly topic: string;
  readonly markdown: string;
  readonly llmCall: { readonly provider: string; readonly model: string };
  readonly signal: AbortSignal;
}

const MAX_TITLE_CHARS = 64;
const MAX_CANDIDATES = 3;

export function titleSystemPrompt(): string {
  return [
    '你是公众号编辑，负责给成稿起标题。只输出一个 JSON 对象，不要解释、不要代码围栏。',
    '标题必须基于正文事实，不得夸大、不得编造数字或引语；不要用「震惊」「必看」这类标题党词。',
  ].join('\n');
}

export function titleUserPrompt(topic: string, markdown: string): string {
  return [
    `主题：${topic}`,
    '',
    '请从下面的成稿提炼 3 个标题候选，输出 JSON：',
    '{"titles":["候选1","候选2","候选3"]}',
    '',
    '要求：',
    '- 每个标题不超过 32 个汉字（微信上限 64 字），带明确判断或冲突，能被一眼记住；',
    '- 三个候选角度不同（事实冲突 / 心理机制 / 行动建议），不要只改措辞；',
    '- 不出现引号、书名号、序号，不用问句堆叠。',
    '',
    '成稿：',
    markdown,
  ].join('\n');
}

/** 解析标题候选：兼容 JSON 对象/数组与按行列表，去重、截断超长。 */
export function parseTitleCandidates(raw: string): string[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let list: unknown[] = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { titles?: unknown }).titles)) {
      list = (parsed as { titles: unknown[] }).titles;
    }
  } catch {
    // 纯文本兜底：只接受带列表符号/序号的行，避免把任意一句话当成标题。
    list = text.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.、])\s+\S/.test(line));
  }
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const title = item
      .replace(/^[-*\d.、\s]+/, '')
      .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
      .trim()
      .slice(0, MAX_TITLE_CHARS);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
    if (titles.length >= MAX_CANDIDATES) break;
  }
  return titles;
}

/** 一次 LLM 调用生成标题候选；解析失败重试一次，仍失败返回空数组（沿用推导标题）。 */
export async function suggestTitles(llm: PipelineLlm, input: TitleSuggestionInput): Promise<string[]> {
  const options = {
    purpose: 'wewrite-title',
    system: titleSystemPrompt(),
    user: titleUserPrompt(input.topic, input.markdown),
    provider: input.llmCall.provider,
    model: input.llmCall.model,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await streamLlmText(llm, options, input.signal);
    if (outcome.status !== 'ok') return [];
    const titles = parseTitleCandidates(outcome.text);
    if (titles.length) return titles;
  }
  return [];
}
