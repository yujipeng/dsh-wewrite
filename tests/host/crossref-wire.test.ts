import { describe, expect, it, vi } from 'vitest';
import { qualityGatesRunner } from '@/host/pipeline/steps/gates';
import type { CrossrefReport } from '@/host/research/crossref';

const body = [
  '## 一、账本',
  '房租 6000 元，一天卖 46 杯；具体细节 2026 年。'.repeat(30),
].join('\n\n');

const claims = [
  {
    id: 'c1',
    text: '房租 6000',
    type: 'fact' as const,
    sourceIds: ['https://x.example/a'],
    doi: '10.1000/xyz',
  },
];

const response = (status: number, payload: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as Response;

describe('I-23 Crossref 自动接线（gates 内）', () => {
  it('开启：结果写入 report.crossref，且不改变 passed', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { message: { title: ['A study'], volume: '12', page: '34-56' } }),
    ) as unknown as typeof fetch;

    const base = await qualityGatesRunner.run({ markdown: body, claims });
    const wired = await qualityGatesRunner.run({
      markdown: body,
      claims,
      crossref: { enabled: true, fetchImpl },
    });

    expect(wired.passed).toBe(base.passed);
    const report = wired.report as { crossref?: CrossrefReport };
    expect(report.crossref).toMatchObject({
      enabled: true,
      results: [{ claimId: 'c1', doi: '10.1000/xyz', status: 'verified', title: 'A study' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('默认关闭：不发任何请求，报告记录 disabled', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const wired = await qualityGatesRunner.run({
      markdown: body,
      claims,
      crossref: { enabled: false, fetchImpl },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const report = wired.report as { crossref?: CrossrefReport };
    expect(report.crossref).toEqual({ enabled: false, results: [], issues: [] });
  });

  it('404 只记录 issue，不阻断（passed 与未接线一致）', async () => {
    const fetchImpl = vi.fn(async () => response(404)) as unknown as typeof fetch;
    const base = await qualityGatesRunner.run({ markdown: body, claims });
    const wired = await qualityGatesRunner.run({
      markdown: body,
      claims,
      crossref: { enabled: true, fetchImpl },
    });
    expect(wired.passed).toBe(base.passed);
    const report = wired.report as { crossref?: CrossrefReport };
    expect(report.crossref?.issues.join('')).toContain('10.1000/xyz');
  });
});
