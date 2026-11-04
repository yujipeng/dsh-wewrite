/**
 * 搜索 API 供应商适配 + 链式回退（类似图片供应商 fallback 链）。
 *
 * 支持的供应商：博查 / Tavily / Jina Search / Exa / 秘塔 Metaso。
 * 每个适配器只负责「调用官方接口 → 统一成 {title,url,source}」，
 * 结果统一过滤社交/聚合域名；某家失败或无结果时自动轮到下一家。
 */

import {
  SEARCH_PROVIDER_LABELS,
  type SearchFreshness,
  type SearchProviderId,
} from '../../../shared/search-provider-ids';
import { createBochaSearcher } from './bocha-search';
import { isUnwantedResultUrl, type WebSearchHit, type WebSearcher } from './web-search';

const DEFAULT_TIMEOUT_MS = 15000;

export interface ApiSearchInput {
  readonly apiKey: string;
  readonly query: string;
  readonly limit: number;
  readonly freshness?: SearchFreshness;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ApiSearchEntry {
  readonly providerId: SearchProviderId;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface ApiSearchChainOptions {
  readonly freshness?: SearchFreshness;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

type RawHit = {
  readonly title?: string;
  readonly url?: string;
  readonly link?: string;
  readonly href?: string;
};

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 50));
}

function trimBase(baseUrl: string | undefined, fallback: string): string {
  const value = (baseUrl ?? '').trim();
  return (value || fallback).replace(/\/+$/, '');
}

function collectHits(items: readonly RawHit[] | undefined, source: WebSearchHit['source']): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const item of items ?? []) {
    const title = (item.title ?? '').trim();
    const url = (item.url ?? item.link ?? item.href ?? '').trim();
    if (!title || !url || isUnwantedResultUrl(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, source });
  }
  return hits;
}

async function requestJson(url: string, init: RequestInit, input: ApiSearchInput): Promise<unknown> {
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const forward = () => controller.abort();
  input.signal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（>${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', forward);
  }
}

/** Tavily：POST /search，Bearer 鉴权，topic=news。 */
async function searchTavily(input: ApiSearchInput): Promise<WebSearchHit[]> {
  const endpoint = `${trimBase(input.baseUrl, 'https://api.tavily.com')}/search`;
  const payload = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: input.query,
        max_results: clampLimit(input.limit),
        search_depth: 'basic',
        topic: 'news',
        include_published_date: true,
      }),
    },
    input,
  );
  const results = (payload as { results?: RawHit[] } | null)?.results;
  return collectHits(results, 'tavily');
}

/** Jina Search：GET s.jina.ai/?q=...，Bearer 鉴权，Accept JSON。 */
async function searchJina(input: ApiSearchInput): Promise<WebSearchHit[]> {
  const endpoint = `${trimBase(input.baseUrl, 'https://s.jina.ai')}/?q=${encodeURIComponent(input.query)}`;
  const payload = await requestJson(
    endpoint,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: 'application/json',
        'x-respond-with': 'json',
      },
    },
    input,
  );
  const data = Array.isArray(payload)
    ? payload
    : ((payload as { data?: RawHit[] } | null)?.data ?? []);
  return collectHits(data, 'jina');
}

/** Exa：POST /search，x-api-key 鉴权。 */
async function searchExa(input: ApiSearchInput): Promise<WebSearchHit[]> {
  const endpoint = `${trimBase(input.baseUrl, 'https://api.exa.ai')}/search`;
  const payload = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: { 'x-api-key': input.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: input.query,
        numResults: clampLimit(input.limit),
        type: 'auto',
        category: 'news',
      }),
    },
    input,
  );
  const results = (payload as { results?: RawHit[] } | null)?.results;
  return collectHits(results, 'exa');
}

/** 秘塔 Metaso：POST /api/v1/search，Bearer 鉴权；响应外壳做宽松兼容。 */
async function searchMetaso(input: ApiSearchInput): Promise<WebSearchHit[]> {
  const endpoint = `${trimBase(input.baseUrl, 'https://metaso.cn')}/api/v1/search`;
  const payload = await requestJson(
    endpoint,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        q: input.query,
        scope: 'webpage',
        includeSummary: false,
        size: clampLimit(input.limit),
      }),
    },
    input,
  );
  const body = payload as
    | { webpages?: RawHit[]; data?: RawHit[]; results?: RawHit[] }
    | null;
  const items = body?.webpages ?? body?.data ?? body?.results ?? [];
  return collectHits(items, 'metaso');
}

async function searchBocha(input: ApiSearchInput): Promise<WebSearchHit[]> {
  return createBochaSearcher({
    apiKey: input.apiKey,
    ...(input.freshness ? { freshness: input.freshness } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  }).search(input.query, input.limit, input.signal);
}

export const API_SEARCH_PROVIDERS: Readonly<Record<SearchProviderId, (input: ApiSearchInput) => Promise<WebSearchHit[]>>> = {
  bocha: searchBocha,
  tavily: searchTavily,
  jina: searchJina,
  exa: searchExa,
  metaso: searchMetaso,
};

/** 按配置顺序依次尝试；全部失败/无结果时抛错（带每家原因），由管线回退抓取式搜索。 */
export function createChainedApiSearcher(entries: readonly ApiSearchEntry[], options: ApiSearchChainOptions = {}): WebSearcher {
  return {
    async search(query, limit, signal) {
      const errors: string[] = [];
      for (const entry of entries) {
        if (signal?.aborted) return [];
        const label = SEARCH_PROVIDER_LABELS[entry.providerId] ?? entry.providerId;
        try {
          const hits = await API_SEARCH_PROVIDERS[entry.providerId]({
            apiKey: entry.apiKey,
            query,
            limit,
            ...(options.freshness ? { freshness: options.freshness } : {}),
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(signal ? { signal } : {}),
          });
          if (hits.length) return hits;
          errors.push(`${label} 无结果`);
        } catch (error) {
          errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (errors.length) throw new Error(`搜索 API 全部失败：${errors.join('；')}`);
      return [];
    },
  };
}
