import { describe, expect, it, vi } from 'vitest';
import { createChainedApiSearcher } from '@/host/pipeline/steps/search-providers';

/**
 * 多供应商搜索链：各家接口形态 + 顺序回退。
 */

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

const mockFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => impl(String(input), init));

describe('搜索供应商适配', () => {
  it('Tavily：POST /search，Bearer 鉴权，topic=news', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ results: [{ title: 'Tavily 结果', url: 'https://news.example.test/t' }] }));
    const chain = createChainedApiSearcher([{ providerId: 'tavily', apiKey: 'tvly-key' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const hits = await chain.search('罗技广告', 5);

    expect(hits).toEqual([{ title: 'Tavily 结果', url: 'https://news.example.test/t', source: 'tavily' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tvly-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: '罗技广告', max_results: 5, topic: 'news' });
  });

  it('Jina：GET s.jina.ai，Bearer + Accept JSON', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ code: 200, data: [{ title: 'Jina 结果', url: 'https://news.example.test/j' }] }));
    const chain = createChainedApiSearcher([{ providerId: 'jina', apiKey: 'jina-key' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const hits = await chain.search('罗技广告', 5);

    expect(hits[0]).toMatchObject({ title: 'Jina 结果', source: 'jina' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://s.jina.ai/?q=');
    expect(new Headers(init?.headers).get('accept')).toBe('application/json');
  });

  it('Exa：x-api-key + category=news', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ results: [{ title: 'Exa 结果', url: 'https://news.example.test/e' }] }));
    const chain = createChainedApiSearcher([{ providerId: 'exa', apiKey: 'exa-key' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const hits = await chain.search('罗技广告', 5);

    expect(hits[0]).toMatchObject({ title: 'Exa 结果', source: 'exa' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('exa-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: '罗技广告', numResults: 5, category: 'news' });
  });

  it('Metaso：解析 webpages[].link', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ webpages: [{ title: '秘塔结果', link: 'https://news.example.test/m' }] }),
    );
    const chain = createChainedApiSearcher([{ providerId: 'metaso', apiKey: 'metaso-key' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const hits = await chain.search('罗技广告', 5);

    expect(hits).toEqual([{ title: '秘塔结果', url: 'https://news.example.test/m', source: 'metaso' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://metaso.cn/api/v1/search');
    expect(JSON.parse(String(init?.body))).toMatchObject({ q: '罗技广告', scope: 'webpage', size: 5 });
  });
});

describe('搜索链回退', () => {
  it('第一家失败自动换下一家', async () => {
    const fetchImpl = mockFetch(async (url) => {
      if (url.includes('tavily')) return new Response('boom', { status: 500 });
      return jsonResponse({ results: [{ title: 'Exa 结果', url: 'https://news.example.test/e' }] });
    });
    const chain = createChainedApiSearcher(
      [
        { providerId: 'tavily', apiKey: 'a' },
        { providerId: 'exa', apiKey: 'b' },
      ],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const hits = await chain.search('罗技广告', 5);

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('exa');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('全部失败 → 抛错并带每家原因', async () => {
    const fetchImpl = mockFetch(async () => new Response('unauthorized', { status: 401 }));
    const chain = createChainedApiSearcher(
      [
        { providerId: 'tavily', apiKey: 'a' },
        { providerId: 'exa', apiKey: 'b' },
      ],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await expect(chain.search('罗技广告', 5)).rejects.toThrow('搜索 API 全部失败');
  });

  it('结果里的社交域名被过滤', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({
        results: [
          { title: '微博', url: 'https://m.weibo.cn/status/1' },
          { title: '正常报道', url: 'https://news.example.test/ok' },
        ],
      }),
    );
    const chain = createChainedApiSearcher([{ providerId: 'tavily', apiKey: 'a' }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const hits = await chain.search('罗技广告', 5);

    expect(hits).toEqual([{ title: '正常报道', url: 'https://news.example.test/ok', source: 'tavily' }]);
  });
});
