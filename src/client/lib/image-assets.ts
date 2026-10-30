import { useEffect, useMemo, useState } from 'react';
import type { ImageAsset } from '@/shared/contract';

/**
 * 工作台看图（image/get 客户端层）。
 * - 按 imageId 懒加载单张图片，全局缓存 Promise（同一张图在预览/配图区只请求一次）。
 * - 缓存上限 24 张，避免多篇文章来回切换时内存无限增长。
 * - 失败不缓存，下次进入可重试。
 */

export interface ImageRpc {
  call<T>(endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<T>;
}

const CACHE_LIMIT = 24;
const cache = new Map<string, Promise<ImageAsset>>();

function remember(imageId: string, pending: Promise<ImageAsset>): void {
  cache.set(imageId, pending);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
}

export function loadImageAsset(imageId: string, rpc: ImageRpc): Promise<ImageAsset> {
  const hit = cache.get(imageId);
  if (hit) {
    cache.delete(imageId);
    cache.set(imageId, hit);
    return hit;
  }
  const pending = rpc.call<ImageAsset>('image/get', { imageId }).catch((error: unknown) => {
    cache.delete(imageId);
    throw error;
  });
  remember(imageId, pending);
  return pending;
}

export function toDataUrl(asset: Pick<ImageAsset, 'mime' | 'base64'>): string {
  return `data:${asset.mime};base64,${asset.base64}`;
}

export function clearImageAssetCache(): void {
  cache.clear();
}

export interface UseImageAssetsResult {
  readonly assets: Record<string, ImageAsset>;
  readonly loading: boolean;
  readonly error?: string;
}

/** 按需加载一组图片；返回 id → ImageAsset 映射与加载状态。 */
export function useImageAssets(
  imageIds: readonly string[],
  rpc: ImageRpc,
): UseImageAssetsResult {
  const idsKey = useMemo(() => imageIds.filter((id) => Boolean(id)).join('|'), [imageIds]);
  const [assets, setAssets] = useState<Record<string, ImageAsset>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    const missing = ids.filter((id) => !assets[id]);
    if (missing.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all(missing.map((id) => loadImageAsset(id, rpc)))
      .then((loaded) => {
        if (cancelled) return;
        setError(undefined);
        setAssets((previous) => {
          const next = { ...previous };
          for (const asset of loaded) next[asset.id] = asset;
          return next;
        });
      })
      .catch((thrown: unknown) => {
        if (!cancelled) setError(thrown instanceof Error ? thrown.message : String(thrown));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey, rpc, assets]);

  return { assets, loading, error };
}
