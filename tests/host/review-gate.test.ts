import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@/host/domain';
import type { RunParams } from '@/shared/contract';
import { createPipelineEngine, type PipelineLlm, type RunStore } from '@/host/pipeline/engine';
import type { EditorialReview } from '@/host/pipeline/steps/editorial-review';

/**
 * 编辑评审参与门禁（P3）：
 * - 不可用时 run 不阻断，但 gates metrics 必须记录原因与尝试次数；
 * - 评审可用且不通过时，run 以 gates-failed 收口。
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
  topic: '测试选题',
  imageCount: 0,
  llm: { provider: 'test', model: 'test-model' },
};

const okStream = (text: string) =>
  (async function* () {
    yield { type: 'text-delta' as const, index: 0, text };
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
  })();

function makeEngine(review: {
  run: () => Promise<{ review: EditorialReview | null; reason?: string; attempts?: number }>;
}) {
  const store = new MemoryRunStore();
  const engine = createPipelineEngine({
    llm: { stream: (async () => okStream('成稿文本，长度足够。')) as unknown as PipelineLlm['stream'] },
    store,
    gates: { run: async () => ({ passed: true, report: {} }) },
    editorialReview: review,
    renderer: { convert: () => '<section>x</section>' },
    images: { generate: async () => ({ bodyImageIds: [] }) },
  });
  return { engine, store };
}

function review(
  dimensions: Record<string, number>,
  blockers: string[] = [],
  majorIssues: string[] = [],
): EditorialReview {
  return {
    dimensions: dimensions as never,
    blockers,
    majorIssues,
    mechanisms: [],
    notes: '',
    model: 'm',
    generatedAtIso: '2026-11-02T00:00:00.000Z',
  };
}

describe('engine 编辑评审门禁', () => {
  it('评审不可用 → gates metrics 记录原因，run 仍成功', async () => {
    const { engine, store } = makeEngine({
      run: async () => ({ review: null, reason: 'LLM 错误：503', attempts: 2 }),
    });
    const runId = await engine.start({ trigger: 'manual', params: baseParams });
    const run = store.get(runId);
    expect(run?.status).toBe('succeeded');
    const gatesStep = run?.steps.find((step) => step.name === 'gates');
    const metrics = gatesStep?.metrics as
      | { review?: { unavailable?: boolean; reason?: string; attempts?: number } }
      | undefined;
    expect(metrics?.review?.unavailable).toBe(true);
    expect(metrics?.review?.reason).toContain('503');
    expect(metrics?.review?.attempts).toBe(2);
  });

  it('评审不通过 → run failed（gates-failed）', async () => {
    const { engine, store } = makeEngine({
      run: async () => ({
        review: review({ accuracy: 2, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 }),
        attempts: 1,
      }),
    });
    const runId = await engine.start({ trigger: 'manual', params: baseParams });
    const run = store.get(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('gates-failed');
  });
});
