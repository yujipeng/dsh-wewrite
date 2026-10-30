/**
 * I-21 research 底稿（可选 agent 工具）：围绕主题产出已核实事实、解释机制、
 * 写作合同 mustInclude / boundary。不调用时管线行为完全不变。
 */

import { streamLlmText, type PipelineLlm } from './pipeline/llm';
import type { HostLogger } from './platform';
import { WewriteServiceError } from './service-errors';

export interface ResearchInput {
  readonly topic: string;
  readonly sources?: readonly string[];
}

export interface ResearchResult {
  readonly facts: string;
  readonly mechanisms: string;
  readonly mustInclude: readonly string[];
  readonly boundary: string;
  readonly model: string;
  readonly generatedAtIso: string;
}

export interface ResearchDeps {
  readonly llm: PipelineLlm;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly logger: HostLogger;
  readonly nowIso: () => string;
}

const SYSTEM_PROMPT = [
  '你是一位严谨的中文资料研究员，为一篇公众号文章准备事实底稿。',
  '只输出一个 JSON 对象，不要 Markdown 代码围栏、不要解释。',
  '事实必须有来源支撑；没有把握的内容放到 boundary（不能写成什么），不要编造。',
].join('');

function userPrompt(input: ResearchInput): string {
  return [
    `主题：${input.topic}`,
    input.sources?.length ? `候选来源：\n${input.sources.map((source) => `- ${source}`).join('\n')}` : '',
    '请输出 JSON：',
    '{"facts":"已核实的事实/数据（分条）","mechanisms":"可复用的解释机制（分条）","mustInclude":["必须出现在正文的事实或机制"],"boundary":"不能写什么/表述边界"}',
    'facts 与 mechanisms 都要落到具体事实、数字或机制名；不要写套话。',
  ].filter(Boolean).join('\n');
}

function readStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function parseResearchOutput(
  text: string,
): { facts: string; mechanisms: string; mustInclude: string[]; boundary: string } | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const facts = typeof parsed.facts === 'string' ? parsed.facts.trim() : '';
    const mechanisms = typeof parsed.mechanisms === 'string' ? parsed.mechanisms.trim() : '';
    const boundary = typeof parsed.boundary === 'string' ? parsed.boundary.trim() : '';
    if (!facts && !mechanisms) return null;
    return {
      facts,
      mechanisms,
      mustInclude: readStringArray(parsed.mustInclude, 10),
      boundary,
    };
  } catch {
    return null;
  }
}

export async function researchTopic(deps: ResearchDeps, input: ResearchInput): Promise<ResearchResult> {
  const { provider, model } = deps;
  if (!provider || !model) {
    throw new WewriteServiceError('llm-not-configured', '尚未配置默认模型：请先到「设置」里选择模型再生成研究底稿');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const outcome = await streamLlmText(
      deps.llm,
      {
        purpose: 'wewrite-research',
        system: SYSTEM_PROMPT,
        user: userPrompt(input),
        provider,
        model,
        maxTokens: 33_000,
      },
      controller.signal,
    );
    if (outcome.status === 'aborted') {
      throw new WewriteServiceError('research-timeout', `研究底稿生成超时（${Math.round(deps.timeoutMs / 1000)} 秒），请重试`);
    }
    if (outcome.status === 'error') throw new WewriteServiceError(outcome.code, outcome.message);
    const parsed = outcome.text ? parseResearchOutput(outcome.text) : null;
    if (!parsed) {
      throw new WewriteServiceError('research-parse-failed', '研究底稿格式不符合要求，请重试');
    }
    deps.logger.info(`research ok：topic=${input.topic.slice(0, 30)} facts=${parsed.facts.length} mechanisms=${parsed.mechanisms.length}`);
    return { ...parsed, model, generatedAtIso: deps.nowIso() };
  } finally {
    clearTimeout(timer);
  }
}
