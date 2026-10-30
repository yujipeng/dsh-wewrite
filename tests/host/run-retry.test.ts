import { describe, expect, it } from 'vitest';
import { WeWriteService } from '@/host/service';
import { RunRecordSchema } from '@/host/domain';
import type { RunParams } from '@/shared/contract';
import { MemoryDomain, makeCredentials, makeFetch, makeLlm, silentLogger } from './service-harness';

/**
 * 任务中心重试（run/retry service 面）：
 * - 终态 run 沿用原 paramsSnapshot（trigger/scheduleId/topic/模型覆盖）重新入队；
 * - 进行中的 run 拒绝重试；未知 runId 报 run-not-found。
 */

const FIXED_NOW = new Date('2026-10-30T02:00:00.000Z');
const PARAMS: RunParams = {
  topicMode: 'fixed',
  topic: '任务中心重试主题',
  theme: 'professional-clean',
  imageCount: 0,
  llm: { provider: 'zhipu', model: 'glm-4.5-flash' },
};

function seedFailedRun(domain: MemoryDomain): void {
  const record = RunRecordSchema.parse({
    v: 1,
    id: 'run_original',
    trigger: 'schedule',
    scheduleId: 'sch_daily',
    paramsSnapshot: PARAMS,
    status: 'failed',
    steps: ['topic', 'outline', 'draft', 'gates', 'render', 'images'].map((name) => ({
      name,
      status: name === 'draft' ? 'failed' : 'succeeded',
    })),
    startedAt: '2026-10-29T02:00:00.000Z',
    finishedAt: '2026-10-29T02:03:00.000Z',
    error: { code: 'gates-failed', message: '门禁未过' },
  });
  void domain.table('runs').put(record.id, record);
}

async function makeService(domain: MemoryDomain): Promise<WeWriteService> {
  const llm = makeLlm();
  const fetch = makeFetch([]);
  return WeWriteService.open({
    domain,
    credentials: makeCredentials({}).service,
    llm: { stream: llm.stream },
    fetchImpl: fetch.fetchImpl,
    now: () => FIXED_NOW,
    logger: silentLogger,
  });
}

function seedTerminalRun(
  domain: MemoryDomain,
  id: string,
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
  trigger: 'manual' | 'schedule' | 'chat',
  topic: string,
): void {
  const record = RunRecordSchema.parse({
    v: 1,
    id,
    trigger,
    paramsSnapshot: { ...PARAMS, topic },
    status,
    steps: ['topic', 'outline', 'draft', 'gates', 'render', 'images'].map((name) => ({ name, status: 'succeeded' })),
    startedAt: '2026-10-29T02:00:00.000Z',
    finishedAt: '2026-10-29T02:03:00.000Z',
    ...(status === 'failed' ? { error: { code: 'gates-failed', message: '门禁未过' } } : {}),
  });
  void domain.table('runs').put(record.id, record);
}

describe('run/retry（任务中心重试）', () => {
  it('终态 run 沿用 paramsSnapshot 重新入队（新 runId、原 trigger/scheduleId/topic）', async () => {
    const domain = new MemoryDomain();
    seedFailedRun(domain);
    const service = await makeService(domain);

    const { runId } = service.retryRun('run_original');
    expect(runId).not.toBe('run_original');

    const detail = service.runDetail({ runId });
    expect(detail.topic).toBe(PARAMS.topic);
    expect(detail.trigger).toBe('schedule');
    expect(detail.scheduleId).toBe('sch_daily');

    await service.runCompletion(runId);
  });

  it('进行中的 run 拒绝重试（run-active），未知 run 报 run-not-found', async () => {
    const domain = new MemoryDomain();
    const service = await makeService(domain);

    const { runId } = service.startRun({ trigger: 'manual', params: PARAMS });
    expect(() => service.retryRun(runId)).toThrowError(/仍在进行中/);
    service.cancelRun(runId);
    await service.runCompletion(runId);

    expect(() => service.retryRun('run_missing')).toThrowError(/运行记录不存在/);
  });

  it('cancelled / interrupted 终态同样可重试（任务页最近完成里的重试入口）', async () => {
    for (const status of ['cancelled', 'interrupted'] as const) {
      const domain = new MemoryDomain();
      seedTerminalRun(domain, 'run_original', status, 'manual', `重试-${status}`);
      const service = await makeService(domain);

      const { runId } = service.retryRun('run_original');
      expect(runId).not.toBe('run_original');
      service.cancelRun(runId);
      await service.runCompletion(runId);
    }
  });

  it('取消 running 后 listRuns 呈现 cancelled（进入任务页最近完成）', async () => {
    const domain = new MemoryDomain();
    const service = await makeService(domain);

    const { runId } = service.startRun({ trigger: 'manual', params: PARAMS });
    service.cancelRun(runId);
    await service.runCompletion(runId);

    const summary = service.listRuns().find((run) => run.id === runId);
    expect(summary?.status).toBe('cancelled');
    expect(summary?.topic).toBe(PARAMS.topic);
  });

  it('listRuns 保留 chat/schedule 来源与 topic（统一任务页来源标注）', async () => {
    const domain = new MemoryDomain();
    seedTerminalRun(domain, 'run_chat', 'succeeded', 'chat', '聊天主题');
    seedTerminalRun(domain, 'run_sched', 'failed', 'schedule', '定时主题');
    const service = await makeService(domain);

    const summaries = service.listRuns();
    expect(summaries.find((run) => run.id === 'run_chat')).toMatchObject({ trigger: 'chat', topic: '聊天主题' });
    expect(summaries.find((run) => run.id === 'run_sched')).toMatchObject({ trigger: 'schedule', topic: '定时主题' });
  });
});
