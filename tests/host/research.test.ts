import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@/host/domain';
import type { RunParams } from '@/shared/contract';
import { createPipelineEngine, type PipelineLlm, type RunStore } from '@/host/pipeline/engine';
import { extractResearchNotes, parseResearchNotes, type ResearchNotes } from '@/host/pipeline/steps/research';
import type { SourceFetcher } from '@/host/pipeline/steps/source';

/**
 * 研究底稿（P1）：
 * - 从原文 JSON 抽取 facts / cannotVerify / boundary / contract；
 * - 解析失败重试一次，仍失败降级；
 * - engine research 步把底稿注入 draft prompt，不阻断管线。
 */

const NOTES: ResearchNotes = {
  facts: [
    {
      text: '11 月 2 日罗技授权店铺发布小狗表情包广告',
      sourceUrl: 'https://mp.weixin.qq.com/s/abc',
      quote: '使用小狗表情包做对比',
    },
  ],
  cannotVerify: ['广告原文完整文案'],
  boundary: ['不判断罗技主观动机'],
  contract: {
    thesis: '爹味是位置问题',
    counterpoint: '玩梗而已',
    audience: { who: '消费者' },
    actions: ['先认责', '再解释', '看第一反应'],
  },
};

const NOTES_JSON = JSON.stringify(NOTES);

class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();
  put(run: RunRecord): void {
    this.runs.set(run.id, run);
  }
  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }
  update(runId: string, patch: (run: RunRecord) => RunRecord): void {
    const current = this.runs.get(runId);
    if (current) this.runs.set(runId, patch(current));
  }
  all(): RunRecord[] {
    return [...this.runs.values()];
  }
}

const baseParams: RunParams = {
  topicMode: 'fixed',
  topic: '罗技广告再被指侮辱用户',
  imageCount: 0,
  llm: { provider: 'test', model: 'test-model' },
};

const okStream = (text: string) =>
  (async function* () {
    yield { type: 'text-delta' as const, index: 0, text };
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
  })();

function makeLlm(texts: readonly string[]) {
  let index = 0;
  return {
    stream: vi.fn(async () => {
      const text = texts[Math.min(index, texts.length - 1)] ?? '';
      index += 1;
      return okStream(text);
    }),
  } as unknown as PipelineLlm;
}

function makeEngine(options: { research?: { run: () => Promise<ResearchNotes | undefined> }; llmText?: string } = {}) {
  const llmStream = vi.fn(async (_options: Record<string, unknown>) => okStream(options.llmText ?? '生成的成稿文本'));
  const store = new MemoryRunStore();
  const sourceFetcher: SourceFetcher = {
    fetch: vi.fn(async (url: string) => ({ url, title: '罗技广告再被指侮辱用户', text: '原文正文'.repeat(200), chars: 800 })),
  };
  const engine = createPipelineEngine({
    llm: { stream: llmStream as unknown as PipelineLlm['stream'] },
    store,
    sourceFetcher,
    ...(options.research ? { research: { run: options.research.run } } : {}),
    gates: { run: async () => ({ passed: true, report: {} }) },
    renderer: { convert: () => '<section>x</section>' },
    images: { generate: async () => ({ bodyImageIds: [] }) },
  });
  return { engine, store, llmStream };
}

describe('parseResearchNotes', () => {
  it('解析完整 JSON（含代码围栏）', () => {
    const notes = parseResearchNotes('```json\n' + NOTES_JSON + '\n```');
    expect(notes?.facts).toHaveLength(1);
    expect(notes?.cannotVerify).toEqual(['广告原文完整文案']);
    expect(notes?.contract?.thesis).toBe('爹味是位置问题');
    expect(notes?.contract?.actions).toHaveLength(3);
  });

  it('非法输出 → undefined', () => {
    expect(parseResearchNotes('不是 JSON')).toBeUndefined();
    expect(parseResearchNotes('{}')).toBeUndefined();
  });
});

describe('extractResearchNotes', () => {
  it('首次非 JSON、第二次有效 → 重试成功', async () => {
    const llm = makeLlm(['不是 JSON', NOTES_JSON]);
    const notes = await extractResearchNotes(llm, {
      topic: '罗技',
      docs: [{ url: 'https://mp.weixin.qq.com/s/abc', title: '罗技', text: '正文'.repeat(400), chars: 800 }],
      llmCall: { provider: 'test', model: 'test-model' },
      signal: new AbortController().signal,
    });
    expect(notes?.facts).toHaveLength(1);
    expect((llm.stream as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('持续非法 → 降级 undefined', async () => {
    const llm = makeLlm(['不是 JSON']);
    const notes = await extractResearchNotes(llm, {
      topic: '罗技',
      docs: [{ url: 'https://mp.weixin.qq.com/s/abc', title: '罗技', text: '正文'.repeat(400), chars: 800 }],
      llmCall: { provider: 'test', model: 'test-model' },
      signal: new AbortController().signal,
    });
    expect(notes).toBeUndefined();
  });
});

describe('engine research 步', () => {
  it('底稿注入 draft prompt：事实 / 未核实项 / 动作都出现', async () => {
    const { engine, store, llmStream } = makeEngine({ research: { run: async () => NOTES } });
    const runId = await engine.start({
      trigger: 'manual',
      params: {
        ...baseParams,
        brief: { sources: ['https://mp.weixin.qq.com/s/abc'], sourceTitle: '罗技广告再被指侮辱用户' },
      },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('succeeded');
    const researchStep = run?.steps.find((step) => step.name === 'research');
    expect((researchStep?.metrics as { facts?: number } | undefined)?.facts).toBe(1);

    const prompts = llmStream.mock.calls.map(
      (call) => (call[0] as { messages: { content: { text: string }[] }[] }).messages[0].content[0].text,
    );
    const draftPrompt = prompts.find((prompt) => prompt.includes('大纲如下')) ?? '';
    expect(draftPrompt).toContain('研究底稿·可核实事实');
    expect(draftPrompt).toContain('11 月 2 日罗技授权店铺发布小狗表情包广告');
    expect(draftPrompt).toContain('研究底稿·未核实项');
    expect(draftPrompt).toContain('广告原文完整文案');
    expect(draftPrompt).toContain('结尾必须给出以下可执行动作');
    expect(draftPrompt).toContain('爹味是位置问题');
    expect(draftPrompt).toContain('玩梗而已');
    expect(draftPrompt).toContain('消费者');

    const outlinePrompt = prompts.find((prompt) => prompt.includes('写作合同')) ?? '';
    expect(outlinePrompt).toContain('核心主张：爹味是位置问题');
    expect(outlinePrompt).toContain('目标读者：读者：消费者');
  });

  it('底稿抽取失败 → 步 degraded，run 仍成功', async () => {
    const { engine, store } = makeEngine({ research: { run: async () => undefined } });
    const runId = await engine.start({
      trigger: 'manual',
      params: { ...baseParams, brief: { sources: ['https://mp.weixin.qq.com/s/abc'] } },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('succeeded');
    const researchStep = run?.steps.find((step) => step.name === 'research');
    expect(researchStep?.status).toBe('succeeded');
    expect(researchStep?.metrics).toEqual({ degraded: true });
  });

  it('未注入 research runner → 步 skipped=disabled', async () => {
    const { engine, store } = makeEngine();
    const runId = await engine.start({
      trigger: 'manual',
      params: { ...baseParams, brief: { sources: ['https://mp.weixin.qq.com/s/abc'] } },
    });
    const researchStep = store.get(runId)?.steps.find((step) => step.name === 'research');
    expect(researchStep?.metrics).toEqual({ skipped: 'disabled' });
  });
});
