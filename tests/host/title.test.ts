import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@/host/domain';
import type { RunParams } from '@/shared/contract';
import { createPipelineEngine, type PipelineLlm, type RunStore } from '@/host/pipeline/engine';
import { parseTitleCandidates, suggestTitles } from '@/host/pipeline/steps/title';

/**
 * 标题提炼（P4）：
 * - 从成稿生成 3 个候选，取第一个写入文章标题；
 * - brief.title 存在时不调用（用户标题优先）；
 * - 解析失败重试一次，仍失败沿用推导标题。
 */

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

function makeEngine(options: {
  titles?: string[];
  onProduced?: (output: { markdown: string; runId: string; title?: string }) => Promise<string | void>;
}) {
  const store = new MemoryRunStore();
  const titleRun = vi.fn(async () => options.titles ?? []);
  const engine = createPipelineEngine({
    llm: { stream: (async () => okStream('## 一\n正文内容足够长。'.repeat(20))) as unknown as PipelineLlm['stream'] },
    store,
    gates: { run: async () => ({ passed: true, report: {} }) },
    titleSuggester: { run: titleRun },
    ...(options.onProduced ? { onProduced: options.onProduced } : {}),
    renderer: { convert: () => '<section>x</section>' },
    images: { generate: async () => ({ bodyImageIds: [] }) },
  });
  return { engine, store, titleRun };
}

describe('parseTitleCandidates', () => {
  it('解析 JSON 对象/数组/代码围栏', () => {
    expect(parseTitleCandidates('{"titles":["标题一","标题二","标题三"]}')).toEqual(['标题一', '标题二', '标题三']);
    expect(parseTitleCandidates('["标题一","标题二"]')).toEqual(['标题一', '标题二']);
    expect(parseTitleCandidates('```json\n{"titles":["标题一"]}\n```')).toEqual(['标题一']);
  });

  it('按行解析兼容纯文本输出，去重并截断超长', () => {
    const long = '长'.repeat(80);
    expect(parseTitleCandidates(`1. 标题一\n2. 标题一\n3. ${long}`)).toEqual(['标题一', '长'.repeat(64)]);
  });

  it('非法输入 → 空数组', () => {
    expect(parseTitleCandidates('')).toEqual([]);
    expect(parseTitleCandidates('{}')).toEqual([]);
  });
});

describe('suggestTitles', () => {
  it('首次非法、第二次有效 → 重试成功', async () => {
    let call = 0;
    const llm = {
      stream: () => {
        call += 1;
        const text = call === 2 ? '{"titles":["标题一","标题二","标题三"]}' : '不是 JSON';
        return okStream(text);
      },
    } as unknown as PipelineLlm;
    const titles = await suggestTitles(llm, {
      topic: '罗技',
      markdown: '正文',
      llmCall: { provider: 'test', model: 'test-model' },
      signal: new AbortController().signal,
    });
    expect(titles).toEqual(['标题一', '标题二', '标题三']);
    expect(call).toBe(2);
  });

  it('持续非法 → 空数组（沿用推导标题）', async () => {
    const llm = { stream: () => okStream('不是 JSON') } as unknown as PipelineLlm;
    const titles = await suggestTitles(llm, {
      topic: '罗技',
      markdown: '正文',
      llmCall: { provider: 'test', model: 'test-model' },
      signal: new AbortController().signal,
    });
    expect(titles).toEqual([]);
  });
});

describe('engine 标题提炼', () => {
  it('brief 未给标题 → 取第一个候选传给落库回调，并记录 metrics', async () => {
    const produced: Array<{ title?: string }> = [];
    const { engine, store } = makeEngine({
      titles: ['候选一', '候选二', '候选三'],
      onProduced: async (output) => {
        produced.push({ ...(output.title ? { title: output.title } : {}) });
        return 'art_1';
      },
    });
    const runId = await engine.start({ trigger: 'manual', params: baseParams });
    expect(produced).toEqual([{ title: '候选一' }]);
    const renderStep = store.get(runId)?.steps.find((step) => step.name === 'render');
    const metrics = renderStep?.metrics as { titleCandidates?: string[]; titleUsed?: string } | undefined;
    expect(metrics?.titleUsed).toBe('候选一');
    expect(metrics?.titleCandidates).toHaveLength(3);
  });

  it('brief.title 已给定 → 不调用标题提炼，不覆盖用户标题', async () => {
    const produced: Array<{ title?: string }> = [];
    const { engine, titleRun } = makeEngine({
      titles: ['候选一'],
      onProduced: async (output) => {
        produced.push({ ...(output.title ? { title: output.title } : {}) });
        return 'art_1';
      },
    });
    await engine.start({ trigger: 'manual', params: { ...baseParams, brief: { title: '用户标题' } } });
    expect(titleRun).not.toHaveBeenCalled();
    expect(produced).toEqual([{}]);
  });
});
