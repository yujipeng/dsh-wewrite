/**
 * 聚合页 → 原文报道链接抽取（速览与管线共用）。
 *
 * 热搜/搜索页不是原文：从抓到的 HTML 里找 canonical / og:url 或首个可信外链，
 * 交给 source 抓取器读正文。两处调用必须共用同一套判定，避免「速览说读到原文、
 * 管线却说没有原文」的口径分裂。
 */

/** 从条目 URL 提取来源域名；非 URL 原样返回（热榜源可能给相对串或纯标识）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 社交分享域名：指向这些域名的外链不是「原文报道」，跳过。 */
const SHARE_HOSTS = new Set([
  'weibo.com',
  't.cn',
  'twitter.com',
  'x.com',
  'facebook.com',
  'linkedin.com',
  'qq.com',
  'douyin.com',
  'weixin.qq.com',
  'youtube.com',
  'instagram.com',
]);

export function readAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1] ?? null;
}

export function absoluteHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 候选链接是否可当作「原文报道」：http(s)、非同一站点、非分享域名、非图片资源。 */
export function isOriginCandidate(url: string, baseHost: string): boolean {
  const host = hostOf(url).toLowerCase();
  if (!host || host === baseHost.toLowerCase()) return false;
  if ([...SHARE_HOSTS].some((share) => host === share || host.endsWith(`.${share}`))) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg)(?:[?#]|$)/i.test(url)) return false;
  return true;
}

/**
 * 从抓取到的 HTML 里抽取原文报道链接。
 * 优先 canonical / og:url（且 host 与当前页不同）；否则取首个不同 host 的外链。
 * 只接受 http(s)，社交分享域名与图片资源跳过。
 */
export function extractOriginUrl(html: string, baseUrl: string): string | undefined {
  const baseHost = hostOf(baseUrl).toLowerCase();
  const declared: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if ((readAttr(tag, 'rel') ?? '').toLowerCase() !== 'canonical') continue;
    const href = readAttr(tag, 'href');
    if (href) declared.push(href);
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((readAttr(tag, 'property') ?? '').toLowerCase() !== 'og:url') continue;
    const content = readAttr(tag, 'content');
    if (content) declared.push(content);
  }
  for (const candidate of declared) {
    const url = absoluteHttpUrl(candidate, baseUrl);
    if (url && isOriginCandidate(url, baseHost)) return url;
  }

  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = readAttr(tag, 'href');
    if (!href) continue;
    const url = absoluteHttpUrl(href, baseUrl);
    if (!url) continue;
    if (!isOriginCandidate(url, baseHost)) continue;
    return url;
  }
  return undefined;
}
