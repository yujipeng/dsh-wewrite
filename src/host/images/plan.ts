/**
 * I-18：基于正文的配图提示词清单（视觉系统 + 封面/正文 prompt）。
 * 一次 LLM 调用产出；失败/结构不合法时降级为固定模板。所有 prompt 强制复写视觉系统与禁用元素。
 */

import { streamLlmText, type PipelineLlm } from '../pipeline/llm';
import type { HostLogger } from '../platform';

export const IMAGE_NEGATIVE_PROMPT =
  '无文字，无字母，无数字，无 logo，无水印，无清晰人脸';

export interface ImagePromptPlan {
  readonly visualSystem: string;
  readonly coverPrompt: string;
  readonly bodyPrompts: readonly string[];
}

export interface ImagePlanInput {
  readonly topic?: string;
  readonly markdown: string;
  readonly count: number;
}

export interface ImagePlanDeps {
  readonly llm: PipelineLlm;
  readonly provider?: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly logger: HostLogger;
}

export function buildFallbackImagePlan(count: number): ImagePromptPlan {
  return {
    visualSystem:
      '整体视觉系统：克制的深色纯色背景，低饱和冷暖对比配色，单一柔和光源，材质细腻，大面积负空间，信息图式构图。',
    coverPrompt: '为文章生成封面图：用一个单一视觉焦点概括主题，克制、信息密度高。',
    bodyPrompts: Array.from(
      { length: Math.max(0, count) },
      (_, index) => `正文配图 ${index + 1}：克制的信息图风格，单一主题，结构清晰。`,
    ),
  };
}

/** 组装最终 prompt：视觉系统 + 单图 prompt + 禁用元素，保证套图风格一致。 */
export function composeImagePrompt(
  plan: ImagePromptPlan,
  kind: 'cover' | 'body',
  index = 0,
): string {
  const base = kind === 'cover'
    ? plan.coverPrompt
    : plan.bodyPrompts[index] ?? `正文配图 ${index + 1}：克制的信息图风格，单一主题。`;
  return `${plan.visualSystem} ${base} 画面中${IMAGE_NEGATIVE_PROMPT}。`;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** 结构校验：视觉系统/封面 prompt 非空，正文 prompt 数量 ≥ count；不合法返回 null。 */
export function validateImagePlan(value: unknown, count: number): ImagePromptPlan | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const visualSystem = readString(record.visualSystem);
  const coverPrompt = readString(record.coverPrompt);
  if (!visualSystem || !coverPrompt) return null;
  if (!Array.isArray(record.bodyPrompts)) return null;
  const bodyPrompts = record.bodyPrompts
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
  if (bodyPrompts.length < count) return null;
  return { visualSystem, coverPrompt, bodyPrompts: bodyPrompts.slice(0, Math.max(count, 1)) };
}

export function parseImagePlan(text: string, count: number): ImagePromptPlan | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return validateImagePlan(JSON.parse(cleaned.slice(start, end + 1)), count);
  } catch {
    return null;
  }
}

/** 一次 LLM 生成清单；未配模型/失败/非法 JSON 返回 undefined（调用方降级固定模板）。 */
export async function generateImagePlan(
  deps: ImagePlanDeps,
  input: ImagePlanInput,
): Promise<ImagePromptPlan | undefined> {
  const { provider, model } = deps;
  if (!provider || !model) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const outcome = await streamLlmText(
      deps.llm,
      {
        purpose: 'wewrite-image-plan',
        system: '你是公众号视觉编辑。只输出一个 JSON 对象，不要 Markdown 围栏、不要解释。',
        user: [
          input.topic ? `主题：${input.topic}` : '',
          `需要 1 张封面 + ${input.count} 张正文配图。`,
          '请输出 JSON：{"visualSystem":"统一色板/材质/光线/负空间","coverPrompt":"封面画面","bodyPrompts":["正文图 1","正文图 2"]}',
          '所有 prompt 必须共用同一段视觉系统；画面中不得出现文字、字母、数字、logo、水印、清晰人脸。',
          '',
          '正文节选：',
          input.markdown.slice(0, 6000),
        ].filter(Boolean).join('\n'),
        provider,
        model,
        maxTokens: 33_000,
      },
      controller.signal,
    );
    if (outcome.status !== 'ok' || !outcome.text) {
      deps.logger.warn(`image plan 降级：status=${outcome.status}`);
      return undefined;
    }
    const plan = parseImagePlan(outcome.text, input.count);
    if (!plan) deps.logger.warn('image plan 降级：JSON 结构不合法');
    return plan ?? undefined;
  } catch (error) {
    deps.logger.warn(`image plan 降级：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
