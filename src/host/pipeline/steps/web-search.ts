/**
 * 通用搜索引擎兜底（v0.5 来源增强）。
 *
 * 搜狗微信检索不到、聚合页也抽不出原文直链时，用公开结果页找正规媒体报道：
 * 搜狗网页优先（与微信检索同源），Bing 备用。只消费结果页里的直链，不引入
 * API key；遇到百度/搜狗跳转链时按需解析 302。
 */

import { decodeEntities, stripTags } from './source';

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly source: 'sogou-web' | 'bing' | 'bocha' | 'tavily' | 'jina' | 'exa' | 'metaso';
}

export interface WebSearcher {
  search(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]>;
}

export interface WebSearcherOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** UA 池（测试可注入固定值）。 */
  readonly userAgents?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 15000;

const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
] as const;

/** 不可抓/非原文的站点：社交平台、搜索自身、短视频与问答聚合。 */
const BLOCKED_HOST_SUFFIXES = [
  'weibo.com',
  'weibo.cn',
  't.cn',
  'zhihu.com',
  'douyin.com',
  'kuaishou.com',
  'bilibili.com',
  'xiaohongshu.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'linkedin.com',
  'youtube.com',
  'instagram.com',
  'sogou.com',
  'bing.com',
  'baidu.com',
] as const;

/** 搜索平台的聚合中间页（即使域名不在黑名单里也不是原文）。 */
const BLOCKED_HOST_PREFIXES = ['so.html5.qq.com', 'newsa.html5.qq.com'] as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 跳转链是否需要解析 302：百度结果跳转页（搜狗网页实测均为目标直链）。 */
export function isRedirectLink(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  const host = hostOf(url);
  return (host === 'baidu.com' || host.endsWith('.baidu.com')) && /\/link\b/.test(url);
}

/** 结果链接是否值得抓：http(s)、非社交/搜索域名、非图片资源。 */
export function isUnwantedResultUrl(url: string): boolean {
  if (!isHttpUrl(url)) return true;
  // 跳转链先保留：createWebSearcher 会 resolve 302，再按最终目标判定。
  if (isRedirectLink(url)) return false;
  const host = hostOf(url);
  if (!host) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (BLOCKED_HOST_PREFIXES.some((prefix) => host === prefix || host.endsWith(`.${prefix}`))) return true;
  if (/\.(?:png|jpe?g|gif|webp|svg|mp4|pdf)(?:[?#]|$)/i.test(url)) return true;
  return false;
}

function absoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    return isHttpUrl(url.toString()) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanTitle(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

/** 搜狗网页结果：`<h3 ...><a href="...">标题</a></h3>`。 */
export function parseSogouWebResults(html: string, baseUrl = 'https://www.sogou.com'): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const block of html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)) {
    const anchor = block[1].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = absoluteUrl(decodeEntities(anchor[1].trim()), baseUrl);
    const title = cleanTitle(anchor[2]);
    if (!url || !title || isUnwantedResultUrl(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, source: 'sogou-web' });
  }
  return hits;
}

/** Bing 结果：`<li class="b_algo">...<h2><a href="...">标题</a>`。 */
export function parseBingResults(html: string, baseUrl = 'https://cn.bing.com'): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const block of html.matchAll(/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const anchor = block[1].match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = absoluteUrl(decodeEntities(anchor[1].trim()), baseUrl);
    const title = cleanTitle(anchor[2]);
    if (!url || !title || isUnwantedResultUrl(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, source: 'bing' });
  }
  return hits;
}

/** 是否为搜索风控/验证码页（正常结果页不会同时缺结果又带这些标记）。 */
export function isSearchBlockPage(html: string): boolean {
  if (/class=["'][^"']*(?:b_algo|vrwrap)/i.test(html)) return false;
  return /antispider|请输入验证码|访问过于频繁|安全验证|验证码|unusual traffic/i.test(html);
}

export interface ResolveRedirectOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

/** 跟随一次 302 拿到目标直链；解析失败返回原链接。 */
export async function resolveRedirectUrl(
  url: string,
  options: ResolveRedirectOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  if (!isRedirectLink(url)) return url;
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': options.userAgent ?? UA_POOL[0],
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      const resolved = location ? absoluteUrl(location, url) : undefined;
      if (resolved && !isUnwantedResultUrl(resolved)) return resolved;
    }
  } catch {
    // 反爬/超时：保留原链接，抓取阶段会给出明确失败原因。
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
  return url;
}

interface SearchEngine {
  readonly id: WebSearchHit['source'];
  readonly buildUrl: (query: string) => string;
  readonly parse: (html: string) => WebSearchHit[];
}

const ENGINES: readonly SearchEngine[] = [
  {
    id: 'sogou-web',
    buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}&ie=utf8`,
    parse: (html) => parseSogouWebResults(html),
  },
  {
    id: 'bing',
    buildUrl: (query) => `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: (html) => parseBingResults(html),
  },
];

/** 通用搜索：搜狗网页优先，为空/失败再试 Bing；全部失败才抛错。 */
export function createWebSearcher(options: WebSearcherOptions = {}): WebSearcher {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgents = options.userAgents?.length ? options.userAgents : UA_POOL;

  const request = async (url: string, signal?: AbortSignal): Promise<string> => {
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        signal: controller.signal,
        headers: {
          'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] ?? UA_POOL[0],
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      if (!response.ok) throw new Error(`搜索返回 HTTP ${response.status}：${url}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  };

  return {
    async search(query, limit, signal) {
      const errors: string[] = [];
      for (const engine of ENGINES) {
        if (signal?.aborted) return [];
        try {
          const html = await request(engine.buildUrl(query), signal);
          const hits = engine.parse(html).slice(0, Math.max(1, limit));
          if (hits.length) {
            // 百度/搜狗跳转链先解析 302；解析失败或目标不可抓则丢弃该条。
            const resolved = await Promise.all(
              hits.map(async (hit): Promise<WebSearchHit | undefined> => {
                if (!isRedirectLink(hit.url)) return hit;
                const url = await resolveRedirectUrl(hit.url, { fetchImpl: fetchFn, timeoutMs }, signal);
                if (url === hit.url || isUnwantedResultUrl(url)) return undefined;
                return { ...hit, url };
              }),
            );
            const usable = resolved.filter((hit): hit is WebSearchHit => Boolean(hit));
            if (usable.length) return usable;
          }
          if (isSearchBlockPage(html)) errors.push(`${engine.id} 返回验证码/风控页`);
        } catch (error) {
          errors.push(`${engine.id}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (errors.length) throw new Error(`通用搜索失败：${errors.join('；')}`);
      return [];
    },
  };
}
