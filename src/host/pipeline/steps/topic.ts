/**
 * 热榜聚合步（F5 / AC-3）：多源并行抓取、单源失败隔离、合并排序、limit 截断。
 * 移植自源管线 fetch_hotspots.mjs 的聚合语义（凭据/路径硬编码不搬）：
 * 单源失败永不抛出、永不清空其他源结果；失败信息以 sourceId 标记返回供 UI 呈现。
 */

import type { HotspotItem } from '../../../shared/contract';

export interface HotspotSource {
  readonly id: string;
  fetch(): Promise<readonly HotspotItem[]>;
}

export interface HotspotFailure {
  readonly sourceId: string;
  readonly message: string;
}

export interface HotspotAggregate {
  readonly items: readonly HotspotItem[];
  readonly failures: readonly HotspotFailure[];
}

/** 聚合各源条目：按 rank 升序（跨源稳定合并），截断到 limit。 */
export async function aggregateHotspots(
  sources: readonly HotspotSource[],
  limit: number,
): Promise<HotspotAggregate> {
  const failures: HotspotFailure[] = [];
  const items: HotspotItem[] = [];
  const settled = await Promise.allSettled(sources.map((source) => source.fetch()));
  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        if (item && item.title) items.push(item);
      }
      return;
    }
    const reason = result.reason;
    failures.push({
      sourceId: source.id,
      message: reason instanceof Error ? reason.message : String(reason ?? '未知错误'),
    });
  });
  items.sort((left, right) => left.rank - right.rank || left.title.localeCompare(right.title));
  // 跨源合并后重新编号：各源 rank 都从 1 起，直接展示会出现多个 #1。
  return { items: items.slice(0, Math.max(0, limit)).map((item, index) => ({ ...item, rank: index + 1 })), failures };
}

// ── 内置源适配器（fetch 注入，可测）─────────────────────────────────────────

interface AlgoliaHit {
  readonly title?: string;
  readonly url?: string;
  readonly objectID?: string;
}

/** Hacker News 官方索引（Algolia front_page）——Spec §3 明确只消费 HN 官方 API。 */
export function createHackerNewsSource(fetchImpl: typeof fetch = fetch): HotspotSource {
  return {
    id: 'hackernews',
    async fetch(): Promise<HotspotItem[]> {
      const endpoint = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30';
      const response = await fetchImpl(endpoint, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Hacker News API 返回 HTTP ${response.status}`);
      const data = (await response.json()) as { hits?: AlgoliaHit[] };
      return (data.hits ?? [])
        .filter((hit): hit is AlgoliaHit & { title: string } => Boolean(hit.title))
        .map((hit, index) => ({
          title: hit.title,
          source: 'hackernews',
          rank: index + 1,
          url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID ?? ''}`,
        }));
    },
  };
}

interface AggregatorEntry {
  readonly title?: string;
  readonly url?: string;
  readonly name?: string;
}

/**
 * 用户自备聚合源（DailyHotApi 兼容形态）：URL 来自设置项 hotspotAggregatorUrl。
 * 兼容 [{...}] 与 {data: [{...}]} 两种外壳；条目缺 title 即跳过。
 */
export function createAggregatorSource(baseUrl: string, fetchImpl: typeof fetch = fetch): HotspotSource {
  return {
    id: 'custom-relay',
    async fetch(): Promise<HotspotItem[]> {
      const response = await fetchImpl(baseUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`聚合源返回 HTTP ${response.status}`);
      const payload = (await response.json()) as unknown;
      const entries: AggregatorEntry[] = Array.isArray(payload)
        ? (payload as AggregatorEntry[])
        : Array.isArray((payload as { data?: AggregatorEntry[] }).data)
          ? ((payload as { data: AggregatorEntry[] }).data)
          : [];
      return entries
        .filter((entry) => entry.title && entry.url)
        .map((entry, index) => ({
          title: entry.title ?? '',
          source: entry.name ?? 'custom-relay',
          rank: index + 1,
          url: entry.url ?? '',
        }));
    },
  };
}

// ── 国内热榜源（移植自 wewrite fetch_hotspots：微博 / 头条 / 百度）────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

interface WeiboEntry {
  readonly note?: string;
  readonly word?: string;
}

/** 微博热搜：weibo.com/ajax/side/hotSearch（需 Referer）。 */
export function createWeiboSource(fetchImpl: typeof fetch = fetch): HotspotSource {
  return {
    id: 'weibo',
    async fetch(): Promise<HotspotItem[]> {
      const response = await fetchImpl('https://weibo.com/ajax/side/hotSearch', {
        headers: { ...BROWSER_HEADERS, Referer: 'https://weibo.com/' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`微博热搜返回 HTTP ${response.status}`);
      const data = (await response.json()) as { data?: { realtime?: WeiboEntry[] } };
      return (data.data?.realtime ?? []).flatMap((entry, index): HotspotItem[] => {
        const title = entry.note ?? entry.word;
        if (!title) return [];
        return [{ title, source: 'weibo', rank: index + 1, url: `https://s.weibo.com/weibo?q=%23${encodeURIComponent(title)}%23` }];
      });
    },
  };
}

interface ToutiaoEntry {
  readonly Title?: string;
  readonly Url?: string;
}

/** 今日头条热榜：toutiao.com/hot-event/hot-board。 */
export function createToutiaoSource(fetchImpl: typeof fetch = fetch): HotspotSource {
  return {
    id: 'toutiao',
    async fetch(): Promise<HotspotItem[]> {
      const response = await fetchImpl('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`头条热榜返回 HTTP ${response.status}`);
      const data = (await response.json()) as { data?: ToutiaoEntry[] };
      return (data.data ?? []).flatMap((entry, index): HotspotItem[] => {
        if (!entry.Title) return [];
        return [{ title: entry.Title, source: 'toutiao', rank: index + 1, url: entry.Url ?? '' }];
      });
    },
  };
}

interface BaiduEntry {
  readonly word?: string;
  readonly url?: string;
}

interface BaiduCard {
  readonly content?: { readonly content?: BaiduEntry[] }[];
}

/** 百度热搜：top.baidu.com/api/board（条目嵌在 cards[0].content[0].content）。 */
export function createBaiduSource(fetchImpl: typeof fetch = fetch): HotspotSource {
  return {
    id: 'baidu',
    async fetch(): Promise<HotspotItem[]> {
      const response = await fetchImpl('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`百度热搜返回 HTTP ${response.status}`);
      const data = (await response.json()) as { data?: { cards?: BaiduCard[] } };
      const entries = (data.data?.cards ?? []).flatMap((card) => card.content?.[0]?.content ?? []);
      return entries.flatMap((entry, index): HotspotItem[] => {
        if (!entry.word) return [];
        return [{ title: entry.word, source: 'baidu', rank: index + 1, url: entry.url ?? '' }];
      });
    },
  };
}

/** 按当前设置装配热榜源列表：默认国内三源；HN 需显式启用；聚合源仅在 URL 配置时加入。 */
export type HotspotSourceId = 'weibo' | 'toutiao' | 'baidu' | 'hackernews';

export function buildHotspotSources(options: {
  aggregatorUrl?: string;
  sources?: readonly HotspotSourceId[];
  fetchImpl?: typeof fetch;
}): HotspotSource[] {
  const fetchImpl = options.fetchImpl ?? fetch;
  const enabled = options.sources ?? ['weibo', 'toutiao', 'baidu'];
  const registry: Record<HotspotSourceId, HotspotSource> = {
    weibo: createWeiboSource(fetchImpl),
    toutiao: createToutiaoSource(fetchImpl),
    baidu: createBaiduSource(fetchImpl),
    hackernews: createHackerNewsSource(fetchImpl),
  };
  const sources: HotspotSource[] = enabled.map((id) => registry[id]).filter((source): source is HotspotSource => Boolean(source));
  if (sources.length === 0) sources.push(createHackerNewsSource(fetchImpl));
  const aggregatorUrl = options.aggregatorUrl?.trim();
  if (aggregatorUrl) sources.push(createAggregatorSource(aggregatorUrl, fetchImpl));
  return sources;
}
