/**
 * 热点分析当日缓存（localStorage，键 = URL）。
 * 与逐条速览缓存同口径：同日命中直接复用，次日重生成；写失败静默降级为仅内存。
 */

import type { HotspotAnalysis } from '@/shared/contract';

const STORAGE_KEY = 'dsh-wewrite.hotspot-analyses';

type Cache = Record<string, HotspotAnalysis>;

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

function isSameLocalDay(iso: string): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function readCachedAnalysis(url: string): HotspotAnalysis | null {
  const entry = load()[url];
  if (!entry) return null;
  if (
    typeof entry.summary !== 'string'
    || typeof entry.angle !== 'string'
    || (entry.source !== 'article' && entry.source !== 'title')
    || typeof entry.model !== 'string'
    || typeof entry.generatedAtIso !== 'string'
    || !isSameLocalDay(entry.generatedAtIso)
  ) {
    return null;
  }
  return entry;
}

export function writeCachedAnalysis(url: string, analysis: HotspotAnalysis): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), [url]: analysis }));
  } catch {
    /* localStorage 不可用时分析仅存组件内存 */
  }
}
