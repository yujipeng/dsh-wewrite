import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ArticleDetail, ImageAsset } from '@/shared/contract';
import { toDataUrl } from '../../lib/image-assets';
import { imageDownloadName } from '../../lib/image-download';

/**
 * 文章管理「配图」区：展示封面与正文图（尺寸/大小/下载）。
 * 图片按需通过 image/get 读取，避免 snapshot 携带 base64。
 */

function formatBytes(asset: ImageAsset): string {
  const bytes = asset.bytes ?? Math.round((asset.base64.length * 3) / 4);
  return `${bytes.toLocaleString('zh-Hans-CN')} B`;
}

export function ArticleImagesModal({
  open,
  onClose,
  article,
  images,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  article: ArticleDetail;
  images: Record<string, ImageAsset>;
  loading: boolean;
  error?: string;
}) {
  const cover = article.coverImageId ? images[article.coverImageId] : undefined;
  const body = article.bodyImageIds
    .map((id) => images[id])
    .filter((asset): asset is ImageAsset => Boolean(asset));
  const all = cover ? [cover, ...body] : body;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`配图 · ${article.title}`}
      closeLabel="关闭配图"
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {loading ? <p className="ww-modal-note">加载配图…</p> : null}
      {error ? <p className="ww-image-gallery__error">{error}</p> : null}
      {!loading && all.length === 0 ? (
        <p className="ww-modal-note">这篇文章还没有配图。运行配图步或在写作台重新生成后会出现在这里。</p>
      ) : null}
      {all.length > 0 ? (
        <div className="ww-image-gallery" data-testid="ww-image-gallery">
          {all.map((asset) => {
            const dataUrl = toDataUrl(asset);
            const label = asset.kind === 'cover' ? '封面' : '正文图';
            return (
              <figure className="ww-image-gallery__item" key={asset.id} data-testid="ww-image-gallery-item">
                <img src={dataUrl} alt={`${label}：${article.title}`} loading="lazy" />
                <figcaption className="ww-image-gallery__meta">
                  <strong>{label}</strong>
                  <span>
                    {asset.width && asset.height ? `${asset.width}×${asset.height}` : '尺寸未知'} ·{' '}
                    {formatBytes(asset)}
                  </span>
                  <a
                    className="ww-image-gallery__download"
                    href={dataUrl}
                    download={imageDownloadName(article, asset)}
                    data-testid={`ww-image-download-${asset.kind}`}
                  >
                    下载
                  </a>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
