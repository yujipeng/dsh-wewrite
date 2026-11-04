import { describe, expect, it, vi } from 'vitest';
import {
  createWebSearcher,
  parseBingResults,
  parseSogouWebResults,
  resolveRedirectUrl,
} from '@/host/pipeline/steps/web-search';

/**
 * 通用搜索兜底：搜狗网页优先，Bing 备用；只保留可抓的原文域名。
 */

const SOGOU_HTML = `<html><body>
<h3 class="vr-title"><a href="https://news.example.test/a">罗技广告再被指侮辱用户</a></h3>
<h3><a href="https://weibo.com/x">微博讨论</a></h3>
<h3><a href="https://www.sogou.com/link?url=abc">搜狗中转</a></h3>
</body></html>`;

const BING_HTML = `<html><body><ol>
<li class="b_algo"><h2><a href="https://finance.example.test/b">罗技客服回应广告争议</a></h2></li>
<li class="b_algo"><h2><a href="https://www.zhihu.com/question/1">知乎讨论</a></h2></li>
</ol></body></html>`;

describe('parseSogouWebResults / parseBingResults', () => {
  it('搜狗网页：解析标题与直链，过滤社交/搜索域名', () => {
    const hits = parseSogouWebResults(SOGOU_HTML);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: '罗技广告再被指侮辱用户',
      url: 'https://news.example.test/a',
      source: 'sogou-web',
    });
  });

  it('Bing：解析 b_algo 结果并过滤知乎', () => {
    const hits = parseBingResults(BING_HTML);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://finance.example.test/b');
    expect(hits[0].source).toBe('bing');
  });
});

describe('resolveRedirectUrl', () => {
  it('百度跳转链 302 → 目标直链', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://news.example.test/c' } }),
    );
    await expect(
      resolveRedirectUrl('https://www.baidu.com/link?url=abc', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe('https://news.example.test/c');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('非跳转链原样返回，不发请求', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveRedirectUrl('https://news.example.test/a', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe('https://news.example.test/a');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('302 指向社交域名 → 保留原链接（不把分享页当原文）', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://weibo.com/x' } }),
    );
    await expect(
      resolveRedirectUrl('https://www.baidu.com/link?url=abc', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe('https://www.baidu.com/link?url=abc');
  });
});

describe('createWebSearcher', () => {
  it('搜狗网页有结果时不请求 Bing', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(SOGOU_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const searcher = createWebSearcher({ fetchImpl: fetchImpl as unknown as typeof fetch, userAgents: ['test-ua'] });
    const hits = await searcher.search('罗技广告', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('sogou-web');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('www.sogou.com/web');
  });

  it('搜狗网页无结果时回退 Bing', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('bing.com') ? BING_HTML : '<html><body>没有找到相关结果</body></html>';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const searcher = createWebSearcher({ fetchImpl: fetchImpl as unknown as typeof fetch, userAgents: ['test-ua'] });
    const hits = await searcher.search('罗技广告', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('bing');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('两个引擎都返回验证码页 → 抛出可读错误', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>请输入验证码</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const searcher = createWebSearcher({ fetchImpl: fetchImpl as unknown as typeof fetch, userAgents: ['test-ua'] });
    await expect(searcher.search('罗技广告', 5)).rejects.toThrow('通用搜索失败');
  });
});
