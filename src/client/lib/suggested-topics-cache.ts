/**
 * 建议选题当日缓存（localStorage）。
 * 切换页签会卸载选题页：进入时先用上次结果占位，避免每次都空白等待 LLM；
 * 随后按当前热榜 batchId 判断：同批次直接复用，不同批次后台更新并替换。
 */

import type { SuggestedTopicsView } from '@/shared/contract';

const STORAGE_KEY = 'dsh-wewrite.suggested-topics';

interface CacheEntry {
  data: SuggestedTopicsView;
  savedAtIso: string;
}

function isSameLocalDay(iso: string): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function readCachedSuggestions(): SuggestedTopicsView | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.savedAtIso !== 'string' || !isSameLocalDay(entry.savedAtIso)) return null;
    const data = entry.data;
    if (
      !data ||
      !Array.isArray(data.topics) ||
      typeof data.batchId !== 'string' ||
      typeof data.generatedAtIso !== 'string' ||
      typeof data.model !== 'string' ||
      typeof data.profileUsed !== 'boolean' ||
      typeof data.totalHotspots !== 'number'
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function writeCachedSuggestions(data: SuggestedTopicsView): void {
  try {
    const entry: CacheEntry = { data, savedAtIso: new Date().toISOString() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* localStorage 不可用时建议仅存组件内存 */
  }
}
