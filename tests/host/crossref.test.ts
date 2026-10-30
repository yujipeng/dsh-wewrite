import { describe, expect, it, vi } from 'vitest';
import { lookupDoi, verifyClaimDois } from '@/host/research/crossref';

const response = (status: number, body: unknown = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('I-23 Crossref 核对', () => {
  it('200 → verified，解析题名/卷期页', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { message: { title: ['A study'], volume: '12', page: '34-56' } }),
    );
    const result = await lookupDoi('10.1000/xyz', { fetchImpl });
    expect(result).toMatchObject({ status: 'verified', title: 'A study', volume: '12', page: '34-56' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.crossref.org/works/10.1000%2Fxyz',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('404 → not-found', async () => {
    const fetchImpl = vi.fn(async () => response(404));
    expect((await lookupDoi('10.1000/missing', { fetchImpl })).status).toBe('not-found');
  });

  it('网络错误 → error，不抛异常', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    expect((await lookupDoi('10.1000/x', { fetchImpl })).status).toBe('error');
  });

  it('超时 → error（abort）', async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await lookupDoi('10.1000/slow', { fetchImpl, timeoutMs: 20 });
    expect(result.status).toBe('error');
  });

  it('默认关闭：不发任何请求', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const report = await verifyClaimDois([{ id: 'c1', doi: '10.1/a' }], { enabled: false, fetchImpl });
    expect(report).toEqual({ enabled: false, results: [], issues: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('开启：逐条核对，未找到只记录 issue，不阻断', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('missing') ? response(404) : response(200, { message: { title: ['ok'] } }),
    );
    const report = await verifyClaimDois(
      [
        { id: 'c1', doi: '10.1/found' },
        { id: 'c2', doi: '10.1/missing' },
        { id: 'c3' },
      ],
      { enabled: true, fetchImpl },
    );
    expect(report.enabled).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual(['verified', 'not-found']);
    expect(report.issues.join('')).toContain('10.1/missing');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
