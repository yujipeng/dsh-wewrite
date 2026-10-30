import { describe, expect, it, vi } from 'vitest';
import { WeWriteService } from '@/host/service';
import { WewriteServiceError } from '@/host/service-errors';
import type { LlmService } from '@/host/platform';
import { MemoryDomain, makeCredentials, silentLogger } from './service-harness';

/**
 * 热点结构化分析（选题确认弹层）：
 * - article 模式：抓原文 → LLM 输出「简介 + 角度」两行
 * - title 降级：抓取失败时提示只凭标题、不得虚构
 * - 宽松解析（Markdown 列表/粗体/无前缀兜底）
 * - llm error 透传、超时 analyze-timeout、空输出 analyze-empty、未配模型零调用
 */

const FIXED_NOW = new Date('2026-08-20T12:00:00.000Z');
const ITEM = { rank: 7, title: '某推理引擎开源', url: 'https://blog.example.test/post' };
const LONG_BODY = '该引擎把推理成本降到了原来的三成，并在多卡部署下保持线性扩展。'.repeat(12);

type StreamFactory = (options: Record<string, unknown>) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

function makeScriptedLlm(script: () => AsyncGenerator) {
  const calls: Record<string, unknown>[] = [];
  const stream: StreamFactory = (options) => {
    calls.push(options);
    return script();
  };
  return { llm: { stream } as LlmService, calls };
}

const userTextOf = (options: Record<string, unknown>): string => {
  const messages = options.messages as { content: { text: string }[] }[];
  return String(messages[0].content[0].text);
};

const articleFetch = (html = `<html><body><article>${LONG_BODY}</article></body></html>`) =>
  vi.fn(async (): Promise<Response> => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));

const notFoundFetch = () => vi.fn(async (): Promise<Response> => new Response('not found', { status: 404 }));

async function makeService(
  llm: LlmService,
  options?: { fetchImpl?: typeof fetch; digestTimeoutMs?: number; skipLlmConfig?: boolean },
) {
  const service = await WeWriteService.open({
    domain: new MemoryDomain(),
    credentials: makeCredentials().service,
    llm,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    now: () => FIXED_NOW,
    logger: silentLogger,
    ...(options?.digestTimeoutMs !== undefined ? { digestTimeoutMs: options.digestTimeoutMs } : {}),
  });
  if (!options?.skipLlmConfig) {
    await service.setConfig({ llmDefault: { provider: 'zhipu', model: 'glm-4.5-flash' } });
  }
  return service;
}

async function rejectInfo(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WewriteServiceError) return { code: error.code, message: error.message };
    return { code: `non-coded:${error instanceof Error ? error.message : String(error)}`, message: '' };
  }
  return { code: 'no-error-thrown', message: '' };
}

describe('analyzeHotspot', () => {
  it('article 模式：解析简介/角度，source=article，提示词带正文与两行格式', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'text-delta', index: 0, text: '简介：某推理引擎开源，推理成本降到三成。\n角度：从工程取舍切入，谈小团队的真实收益。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const service = await makeService(llm.llm, { fetchImpl: articleFetch() as unknown as typeof fetch });

    const result = await service.analyzeHotspot(ITEM);

    expect(result).toEqual({
      summary: '某推理引擎开源，推理成本降到三成。',
      angle: '从工程取舍切入，谈小团队的真实收益。',
      source: 'article',
      model: 'glm-4.5-flash',
      generatedAtIso: FIXED_NOW.toISOString(),
    });
    expect(llm.calls).toHaveLength(1);
    const options = llm.calls[0];
    expect(options?.purpose).toBe('wewrite-hotspot-analyze');
    expect(options?.provider).toBe('zhipu');
    expect(options?.model).toBe('glm-4.5-flash');
    expect(options?.maxTokens).toBe(33_000);
    const user = userTextOf(options ?? {});
    expect(user).toContain('热榜条目标题：某推理引擎开源');
    expect(user).toContain('正文节选');
    expect(user).toContain('简介：');
    expect(user).toContain('角度：');
  });

  it('抓取失败：title 降级，提示不得虚构，source=title', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'text-delta', index: 0, text: '简介：一条基于标题的解读。\n角度：一个方向性的角度。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const service = await makeService(llm.llm, { fetchImpl: notFoundFetch() as unknown as typeof fetch });

    const result = await service.analyzeHotspot(ITEM);

    expect(result.source).toBe('title');
    expect(result.summary).toBe('一条基于标题的解读。');
    expect(userTextOf(llm.calls[0] ?? {})).toContain('只有标题与域名可用');
  });

  it('宽松解析：Markdown 列表/粗体被清洗；缺「简介：」时首行兜底', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'text-delta', index: 0, text: '- **简介：** 清洗后的简介。\n- **角度：** 清洗后的角度。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const service = await makeService(llm.llm, { fetchImpl: articleFetch() as unknown as typeof fetch });
    const first = await service.analyzeHotspot(ITEM);
    expect(first).toMatchObject({ summary: '清洗后的简介。', angle: '清洗后的角度。' });

    const fallbackLlm = makeScriptedLlm(async function* () {
      yield { type: 'text-delta', index: 0, text: '没有前缀的简介。\n角度：角度仍在。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const fallbackService = await makeService(fallbackLlm.llm, { fetchImpl: articleFetch() as unknown as typeof fetch });
    const second = await fallbackService.analyzeHotspot(ITEM);
    expect(second).toMatchObject({ summary: '没有前缀的简介。', angle: '角度仍在。' });
  });

  it('空输出：analyze-empty', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const service = await makeService(llm.llm, { fetchImpl: articleFetch() as unknown as typeof fetch });

    const info = await rejectInfo(service.analyzeHotspot(ITEM));

    expect(info.code).toBe('analyze-empty');
  });

  it('超时：注入短超时 + 慢流 → analyze-timeout', async () => {
    const llm = makeScriptedLlm(async function* () {
      for (let index = 0; ; index += 1) {
        yield { type: 'text-delta', index, text: `行${index}` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const service = await makeService(llm.llm, {
      fetchImpl: articleFetch() as unknown as typeof fetch,
      digestTimeoutMs: 30,
    });

    const info = await rejectInfo(service.analyzeHotspot(ITEM));

    expect(info.code).toBe('analyze-timeout');
    expect(info.message).toContain('已取消');
  });

  it('LLM 错误分流：code/message 原样透传', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'context-overflow', message: '上下文超限' } } };
    });
    const service = await makeService(llm.llm, { fetchImpl: articleFetch() as unknown as typeof fetch });

    const info = await rejectInfo(service.analyzeHotspot(ITEM));

    expect(info).toEqual({ code: 'context-overflow', message: '上下文超限' });
  });

  it('未配默认模型：llm-not-configured，零 LLM 调用', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const service = await makeService(llm.llm, { skipLlmConfig: true, fetchImpl: articleFetch() as unknown as typeof fetch });

    const info = await rejectInfo(service.analyzeHotspot(ITEM));

    expect(info.code).toBe('llm-not-configured');
    expect(llm.calls).toHaveLength(0);
  });
});
