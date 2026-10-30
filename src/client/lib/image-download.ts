import type { ArticleDetail, ImageAsset } from '@/shared/contract';

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 配图下载文件名：slug-kind-短id.ext（扩展名按 mime 推断）。 */
export function imageDownloadName(
  article: Pick<ArticleDetail, 'slug'>,
  asset: Pick<ImageAsset, 'id' | 'kind' | 'mime'>,
): string {
  const ext = EXT_BY_MIME[asset.mime] ?? 'img';
  const suffix = asset.id.replace(/^img_/, '').slice(-6);
  return `${article.slug}-${asset.kind}-${suffix}.${ext}`;
}
