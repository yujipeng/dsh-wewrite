import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAsset } from '@/shared/contract';
import { clearImageAssetCache, loadImageAsset, toDataUrl, type ImageRpc } from '@/client/lib/image-assets';

const asset = (id: string): ImageAsset => ({
  id,
  articleId: 'art_1',
  kind: 'cover',
  mime: 'image/jpeg',
  base64: 'AAA',
  createdAt: '2026-10-30T00:00:00.000Z',
});

describe('loadImageAsset', () => {
  beforeEach(() => clearImageAssetCache());

  it('同一 imageId 只请求一次（并发与后续都命中缓存）', async () => {
    const call = vi.fn().mockResolvedValue(asset('img_1'));
    const rpc = { call } as unknown as ImageRpc;

    const [first, second] = await Promise.all([
      loadImageAsset('img_1', rpc),
      loadImageAsset('img_1', rpc),
    ]);
    await loadImageAsset('img_1', rpc);

    expect(call).toHaveBeenCalledTimes(1);
    expect(first.id).toBe('img_1');
    expect(second.id).toBe('img_1');
  });

  it('失败不缓存，下次可重试', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(asset('img_2'));
    const rpc = { call } as unknown as ImageRpc;

    await expect(loadImageAsset('img_2', rpc)).rejects.toThrow('boom');
    await expect(loadImageAsset('img_2', rpc)).resolves.toMatchObject({ id: 'img_2' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('toDataUrl 生成可直接用于 img src 的 data URL', () => {
    expect(toDataUrl(asset('img_3'))).toBe('data:image/jpeg;base64,AAA');
  });
});
