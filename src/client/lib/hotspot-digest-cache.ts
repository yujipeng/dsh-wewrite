/**
 * 热榜逐条 AI 速览的当日缓存（localStorage，键 = URL）。
 * 列表展开与确认弹层共用同一份数据：正文 + 分析角度，已生成过就直接复用。
 * 旧版本缓存没有 angles 字段——视为过期，重新生成一次以补齐角度。
 */

export type DigestSource = 'article' | 'title';

export interface DigestCacheEntry {
  digest: string;
  angles: string[];
  source: DigestSource;
  model: string;
  generatedAtIso: string;
  /** I-09：原文报道链接 / 来源类型 / 边界说明（旧缓存可缺省）。 */
  originUrl?: string;
  sourceType?: 'hot' | 'demand' | 'evergreen';
  note?: string;
}

const STORAGE_KEY = 'dsh-wewrite.hotspot-item-digests';

type Cache = Record<string, DigestCacheEntry>;

function load(): Cache {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Cache;
  } catch {
    return {};
  }
}

/** 当日有效：缓存条目生成日期与今天不同（本地时区口径）即视为无缓存，次日重生成。 */
function isSameLocalDay(iso: string): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function readCachedDigest(url: string): DigestCacheEntry | null {
  const entry = load()[url];
  if (!entry) return null;
  if (
    typeof entry.digest !== 'string' ||
    !Array.isArray(entry.angles) ||
    !entry.angles.every((angle) => typeof angle === 'string') ||
    (entry.source !== 'article' && entry.source !== 'title') ||
    typeof entry.model !== 'string' ||
    typeof entry.generatedAtIso !== 'string' ||
    (entry.originUrl !== undefined &&
      (typeof entry.originUrl !== 'string' || !/^https?:\/\//.test(entry.originUrl))) ||
    (entry.sourceType !== undefined &&
      !['hot', 'demand', 'evergreen'].includes(entry.sourceType)) ||
    (entry.note !== undefined && typeof entry.note !== 'string') ||
    !isSameLocalDay(entry.generatedAtIso)
  ) {
    return null;
  }
  return { ...entry, angles: entry.angles.slice(0, 4) };
}

export function writeCachedDigest(url: string, entry: DigestCacheEntry): void {
  try {
    const next: Cache = { ...load(), [url]: entry };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可用时速览仅存组件内存 */
  }
}
