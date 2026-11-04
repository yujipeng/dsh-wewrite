/**
 * 搜索 API 供应商常量（类似图片供应商：可配置多家、按链顺序依次回退）。
 *
 * 说明：QVeris 不属于网页/新闻搜索（它返回的是可调用的 API 能力，不是文章链接），
 * 因此没有纳入这条「找原文」的链。后续若要接它的能力发现，应单独做一层工具路由。
 */

export const SEARCH_PROVIDER_IDS = ['bocha', 'tavily', 'jina', 'exa', 'metaso'] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export const SEARCH_PROVIDER_LABELS: Readonly<Record<SearchProviderId, string>> = {
  bocha: '博查 Bocha',
  tavily: 'Tavily',
  jina: 'Jina Search',
  exa: 'Exa',
  metaso: '秘塔 Metaso',
};

/** 搜索时效过滤（各家用各自的参数名映射）。 */
export const SEARCH_FRESHNESS_VALUES = ['oneDay', 'oneWeek', 'oneMonth', 'noLimit'] as const;

export type SearchFreshness = (typeof SEARCH_FRESHNESS_VALUES)[number];

/** 每家默认凭据键；可被配置项里的 credentialRef 覆盖。 */
export function searchCredentialRef(providerId: SearchProviderId): string {
  return `WEWRITE_SEARCH_${providerId.toUpperCase()}`;
}

export function isSearchProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}
