/**
 * 博查 Web Search API（国内热点新闻/原文检索）。
 *
 * 有 API key 时优先于抓取式搜索：官方接口直接返回标题/链接/摘要/发布时间，
 * 不受搜狗风控与结果页改版影响，也不用解析 HTML。
 *
 * 接口：POST https://api.bochaai.com/v1/web-search
 * 鉴权：Authorization: Bearer <key>
 */

import { isUnwantedResultUrl, type WebSearchHit, type WebSearcher } from './web-search';

export type BochaFreshness = 'oneDay' | 'oneWeek' | 'oneMonth' | 'noLimit';

export interface BochaSearcherOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** 时效过滤：默认 oneWeek（热点新闻覆盖足够，又不至于只有当天）。 */
  readonly freshness?: BochaFreshness;
  /** 自建代理/镜像的 base URL（默认官方地址）。 */
  readonly baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ENDPOINT = 'https://api.bochaai.com/v1/web-search';

interface BochaWebPage {
  readonly name?: string;
  readonly url?: string;
  readonly summary?: string;
  readonly snippet?: string;
  readonly siteName?: string;
  readonly datePublished?: string;
}

interface BochaResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: {
    readonly webPages?: {
      readonly value?: readonly BochaWebPage[];
    };
  };
}

/** 解析博查响应：只保留可抓的 http(s) 原文链接，按 URL 去重。 */
export function parseBochaResponse(payload: unknown): WebSearchHit[] {
  const response = payload as BochaResponse | null;
  if (!response || typeof response !== 'object') return [];
  if (typeof response.code === 'number' && response.code !== 200) {
    throw new Error(`博查搜索返回 code=${response.code}${response.msg ? `：${response.msg}` : ''}`);
  }
  const pages = response.data?.webPages?.value ?? [];
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const title = (page.name ?? '').trim();
    const url = (page.url ?? '').trim();
    if (!title || !url || isUnwantedResultUrl(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, source: 'bocha' });
  }
  return hits;
}

/** 博查搜索器：网络/鉴权失败抛错，由管线记录并回退到抓取式搜索。 */
export function createBochaSearcher(options: BochaSearcherOptions): WebSearcher {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const freshness = options.freshness ?? 'oneWeek';
  const endpoint = (options.baseUrl?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');

  return {
    async search(query, limit, signal) {
      if (!options.apiKey.trim()) throw new Error('搜索 API 未配置 API Key');
      const controller = new AbortController();
      const forward = () => controller.abort();
      signal?.addEventListener('abort', forward, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            query,
            freshness,
            summary: true,
            count: Math.max(1, Math.min(limit, 50)),
          }),
        });
        if (!response.ok) throw new Error(`博查搜索返回 HTTP ${response.status}`);
        const payload: unknown = await response.json();
        return parseBochaResponse(payload).slice(0, Math.max(1, limit));
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`博查搜索超时（>${timeoutMs}ms）`);
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
      }
    },
  };
}
