import { describe, expect, it, vi } from 'vitest';
import { createBochaSearcher, parseBochaResponse } from '@/host/pipeline/steps/bocha-search';

/**
 * 博查搜索：官方 API，返回 title/url；只保留可抓原文域名。
 */

const PAYLOAD = {
  code: 200,
  data: {
    webPages: {
      value: [
        {
          name: '罗技广告再被指侮辱用户，客服回应',
          url: 'https://news.example.test/a',
          summary: '11 月 2 日……',
          siteName: '澎湃新闻',
        },
        { name: '微博讨论', url: 'https://m.weibo.cn/status/1' },
        { name: '没有链接的条目', url: '' },
      ],
    },
  },
};

describe('parseBochaResponse', () => {
  it('解析标题/链接，过滤社交域名与空链接', () => {
    const hits = parseBochaResponse(PAYLOAD);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: '罗技广告再被指侮辱用户，客服回应',
      url: 'https://news.example.test/a',
      source: 'bocha',
    });
  });

  it('code 非 200 → 抛出可读错误', () => {
    expect(() => parseBochaResponse({ code: 403, msg: 'invalid api key' })).toThrow('invalid api key');
  });
});

describe('createBochaSearcher', () => {
  it('请求体带 query/freshness/count，Bearer 鉴权', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const searcher = createBochaSearcher({
      apiKey: 'test-key',
      freshness: 'oneDay',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const hits = await searcher.search('罗技广告', 5);

    expect(hits).toHaveLength(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(String(init.method)).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ query: '罗技广告', freshness: 'oneDay', count: 5 });
  });

  it('HTTP 非 2xx → 抛出可读错误（由管线回退抓取式搜索）', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const searcher = createBochaSearcher({ apiKey: 'bad', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(searcher.search('罗技广告', 5)).rejects.toThrow('HTTP 401');
  });

  it('未配置 key → 直接抛错，不发生请求', async () => {
    const fetchImpl = vi.fn();
    const searcher = createBochaSearcher({ apiKey: '  ', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(searcher.search('罗技广告', 5)).rejects.toThrow('未配置 API Key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
