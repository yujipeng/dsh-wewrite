/**
 * 热点结构化分析（选题确认弹层）：抓原文 → LLM 一次产出「简介 + 可写角度」。
 * 与逐条 AI 速览（hotspot-digest）分开：速览是行内展开阅读的多要点文本，
 * 这里是启动写作前的两字段决策信息，输出更短、更聚焦。
 */

import type { HotspotAnalysis, HotspotDigestItem } from '../shared/contract';
import { fetchArticleText } from './hotspot-digest';
import { streamLlmText, type LlmStepOutcome, type PipelineLlm } from './pipeline/llm';
import type { HostLogger } from './platform';
import { WewriteServiceError } from './service-errors';

export interface HotspotAnalyzeDeps {
  readonly llm: PipelineLlm;
  /** settings.llmDefault 透传；缺省即 llm-not-configured。 */
  readonly provider?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger: HostLogger;
  /** 单次 LLM 调用超时毫秒（默认复用速览的 45s；测试注入缩短值验证 abort 分支）。 */
  readonly timeoutMs: number;
  readonly nowIso: () => string;
}

const SUMMARY_MAX_CHARS = 2000;
const ANGLE_MAX_CHARS = 500;
const MAX_TOKENS = 33_000;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const SYSTEM_PROMPT = [
  '你是一位中文公众号选题编辑，替作者判断一条热榜值不值得写。',
  '只输出中文纯文本，严格两行：以「简介：」开头的一行、以「角度：」开头的一行；不要表头、解释或 Markdown。',
  '简介落到具体事实，角度要可执行，不写套话与空转词。',
].join('');

function userPrompt(title: string, domain: string, body: string | null): string {
  if (body !== null) {
    return [
      `热榜条目标题：${title}`,
      `来源域名：${domain}`,
      '',
      '正文节选：',
      body,
      '',
      '请严格输出两行：',
      '简介：一句话说清这条在讲什么（不超过 80 字，落到具体事实）',
      '角度：一个适合公众号写作的具体切入角度（不超过 60 字）',
      '事实只能来自给定正文，不得补充外部信息，不得虚构数字与结论。',
    ].join('\n');
  }
  return [
    `热榜条目标题：${title}`,
    `来源域名：${domain}`,
    '',
    '只有标题与域名可用：不得虚构原文没有的事实。',
    '请严格输出两行：',
    '简介：基于标题的一句话解读（不超过 80 字）',
    '角度：一个方向性的写作角度（不超过 60 字，不提具体功能、数字或参数）',
  ].join('\n');
}

/**
 * 解析两行输出：容忍 Markdown 列表符/粗体与「摘要/可写角度」等同义前缀。
 * 找不到「简介：」时把第一行当作简介（宽松兜底）；角度缺失返回空串。
 */
export function parseHotspotAnalysis(text: string): { summary: string; angle: string } {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => raw.replace(/^\s*[-*·]\s*/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line.length > 0);

  let summary = '';
  let angle = '';
  for (const line of lines) {
    const summaryMatch = line.match(/^(?:简介|摘要|这条在讲什么)\s*[:：]\s*(.+)$/);
    if (summaryMatch) {
      summary = summaryMatch[1]?.trim() ?? '';
      continue;
    }
    const angleMatch = line.match(/^(?:分析角度|可写角度|写作角度|角度)\s*[:：]\s*(.+)$/);
    if (angleMatch) angle = angleMatch[1]?.trim() ?? '';
  }
  if (!summary) summary = lines[0] ?? '';
  return {
    summary: summary.slice(0, SUMMARY_MAX_CHARS),
    angle: angle.slice(0, ANGLE_MAX_CHARS),
  };
}

export async function analyzeHotspot(deps: HotspotAnalyzeDeps, item: HotspotDigestItem): Promise<HotspotAnalysis> {
  const startedAt = Date.now();
  const { provider, model } = deps;
  if (!provider || !model) {
    throw new WewriteServiceError('llm-not-configured', '尚未配置默认模型：请先到「设置」里选择 AI 供应商与模型，再分析选题');
  }

  const body = await fetchArticleText(item.url, deps.fetchImpl ?? fetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    let outcome: LlmStepOutcome;
    try {
      outcome = await streamLlmText(
        deps.llm,
        {
          purpose: 'wewrite-hotspot-analyze',
          system: SYSTEM_PROMPT,
          user: userPrompt(item.title, hostOf(item.url), body),
          provider,
          model,
          maxTokens: MAX_TOKENS,
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }

    if (outcome.status === 'aborted') {
      throw new WewriteServiceError('analyze-timeout', `选题分析超时（${Math.round(deps.timeoutMs / 1000)} 秒），已取消，请重试`);
    }
    // 供应商错误码/文案原样透传（与速览/改写同口径）
    if (outcome.status === 'error') throw new WewriteServiceError(outcome.code, outcome.message);
    if (!outcome.text) throw new WewriteServiceError('analyze-empty', '模型没有返回分析内容，请重试');

    const parsed = parseHotspotAnalysis(outcome.text);
    if (!parsed.summary) throw new WewriteServiceError('analyze-empty', '模型没有返回可用的简介，请重试');
    const source = body !== null ? 'article' : 'title';
    deps.logger.info(
      `hotspot analyze ok：rank=${item.rank} source=${source} model=${model} body=${body?.length ?? 0} ${Date.now() - startedAt}ms`,
    );
    return {
      summary: parsed.summary,
      angle: parsed.angle,
      source,
      model,
      generatedAtIso: deps.nowIso(),
    };
  } catch (error) {
    const code = error instanceof WewriteServiceError ? error.code : 'unknown';
    deps.logger.warn(`hotspot analyze failed（rank=${item.rank} ${code}）：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
