/**
 * 热搜聚合页 → 新闻原文解析（v0.5 来源入管线增强）。
 *
 * 微博/百度/头条的搜索页不是原文：未登录只返回空壳（本机实测 19 字符）。
 * 这里用标题检索搜狗微信（媒体报道/公众号文章），解析 mp.weixin.qq.com
 * 直链，再交给 source 抓取器读正文；检索不到同样按 source-unavailable 暂停。
 */

import { decodeEntities, stripTags } from './source';

export interface SourceSearchHit {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly publisher: string;
}

export interface SourceSearcher {
  search(query: string, limit: number, signal?: AbortSignal): Promise<SourceSearchHit[]>;
  /** 搜狗中转页 → 真实文章直链；解析失败返回原链接。 */
  resolve(url: string, signal?: AbortSignal): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 15000;

const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
] as const;

const AGGREGATOR_HOSTS = new Set(['s.weibo.com', 'm.weibo.cn', 'm.baidu.com', 'www.baidu.com', 'so.toutiao.com', 'weixin.sogou.com']);

/** 是否为「搜索/热搜聚合页」（不是新闻原文）。 */
export function isAggregatorUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!AGGREGATOR_HOSTS.has(host)) return false;
    if (host === 'www.baidu.com' || host === 'm.baidu.com') return parsed.pathname.startsWith('/s');
    if (host === 'weixin.sogou.com') return parsed.pathname.startsWith('/weixin');
    return true;
  } catch {
    return false;
  }
}

/** 解析搜狗微信结果页：标题/链接/摘要/公众号名。 */
export function parseSogouResults(html: string): SourceSearchHit[] {
  const listMatch = html.match(/<ul[^>]*class=["'][^"']*news-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch) return [];
  const items = listMatch[1].split(/<li[^>]*>/i).slice(1);
  const hits: SourceSearchHit[] = [];
  for (const raw of items) {
    const anchor = raw.match(/<h3[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const href = decodeEntities(anchor[1].trim());
    const title = stripTags(anchor[2]).trim();
    if (!href || !title) continue;
    const summaryMatch = raw.match(/<p[^>]*class=["'][^"']*txt-info[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const publisherMatch = raw.match(/<a[^>]*class=["'][^"']*account[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    hits.push({
      title,
      url: href.startsWith('/') ? `https://weixin.sogou.com${href}` : href,
      summary: summaryMatch ? stripTags(summaryMatch[1]).trim() : '',
      publisher: publisherMatch ? stripTags(publisherMatch[1]).trim() : '',
    });
  }
  return hits;
}

function normalizedChars(text: string): string[] {
  return [...text.replace(/[\s\p{P}]/gu, '')];
}

/** 按标题字符重叠度选最匹配的报道（同分取靠前）。 */
export function pickBestHit(hits: readonly SourceSearchHit[], title: string): SourceSearchHit | undefined {
  if (!hits.length) return undefined;
  const target = new Set(normalizedChars(title));
  let best = hits[0];
  let bestScore = -1;
  for (const hit of hits) {
    const chars = new Set(normalizedChars(hit.title));
    let score = 0;
    for (const ch of target) if (chars.has(ch)) score += 1;
    if (score > bestScore) {
      best = hit;
      bestScore = score;
    }
  }
  return best;
}

export interface SogouSearcherOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** UA 池（测试可注入固定值，避免随机导致断言不稳）。 */
  readonly userAgents?: readonly string[];
}

/** 搜狗微信检索器：UA 池 + Referer；检索失败抛错，由管线收口为暂停。 */
export function createSogouWechatSearcher(options: SogouSearcherOptions = {}): SourceSearcher {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgents = options.userAgents?.length ? options.userAgents : UA_POOL;

  const request = async (url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> => {
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  };

  return {
    async search(query, limit, signal) {
      const url = `https://weixin.sogou.com/weixin?query=${encodeURIComponent(query)}&s_from=input&_sug_=n&type=2&page=1&ie=utf8`;
      const response = await request(
        url,
        {
          headers: {
            'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)] ?? UA_POOL[0],
            referer: 'https://weixin.sogou.com/',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        },
        signal,
      );
      if (!response.ok) throw new Error(`搜狗微信检索返回 HTTP ${response.status}`);
      const html = await response.text();
      return parseSogouResults(html).slice(0, Math.max(1, limit));
    },

    async resolve(url, signal) {
      if (!url.includes('weixin.sogou.com')) return url;
      try {
        const response = await request(
          url,
          {
            redirect: 'manual',
            headers: { 'user-agent': UA_POOL[0], referer: 'https://weixin.sogou.com/' },
          },
          signal,
        );
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location') ?? '';
          if (location.includes('mp.weixin.qq.com')) return location;
        }
        if (response.ok) {
          const html = await response.text();
          const joined = [...html.matchAll(/url\s*\+=\s*['"]([^'"]*)['"]/g)].map((match) => match[1]).join('');
          if (joined.includes('mp.weixin.qq.com')) return joined.replace(/@/g, '');
        }
      } catch {
        // 反爬/超时：保留中转链接，后续抓取会给出明确失败原因。
      }
      return url;
    },
  };
}
