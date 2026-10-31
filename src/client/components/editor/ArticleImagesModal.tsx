import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ArticleDetail, ImageAsset } from '@/shared/contract';
import { toDataUrl } from '../../lib/image-assets';
import { imageDownloadName } from '../../lib/image-download';

/**
 * 文章管理「配图」区：
 * - 首图 / 内图各一张操作卡（状态 + 说明 + 生成/替换按钮）；
 * - 图库独立成区，展示封面与正文图的缩略图、尺寸、大小和下载；
 * - 图片按需通过 image/get 读取，避免 snapshot 携带 base64。
 */

function formatBytes(asset: ImageAsset): string {
  const bytes = asset.bytes ?? Math.round((asset.base64.length * 3) / 4);
  return `${bytes.toLocaleString('zh-Hans-CN')} B`;
}

function countPlaceholders(markdown: string): number {
  return (markdown.match(/图片待生成/g) ?? []).length;
}

export function ArticleImagesModal({
  open,
  onClose,
  article,
  images,
  loading,
  error,
  generationError,
  onGenerate,
  generating,
}: {
  open: boolean;
  onClose: () => void;
  article: ArticleDetail;
  images: Record<string, ImageAsset>;
  loading: boolean;
  error?: string;
  generationError?: string;
  onGenerate: (kind: 'cover' | 'body') => void | Promise<void>;
  generating?: 'cover' | 'body';
}) {
  const cover = article.coverImageId ? images[article.coverImageId] : undefined;
  const body = article.bodyImageIds
    .map((id) => images[id])
    .filter((asset): asset is ImageAsset => Boolean(asset));
  const all = cover ? [cover, ...body] : body;
  const placeholderCount = countPlaceholders(article.markdown);
  const bodyLimit = Math.min(3, Math.max(1, placeholderCount));

  const coverMeta = cover
    ? `${cover.width && cover.height ? `${cover.width}×${cover.height}` : '尺寸未知'} · ${formatBytes(cover)}`
    : '尚未生成；用于公众号封面（2.35:1），生成后自动裁切压缩。';
  const bodyMeta = article.bodyImageIds.length
    ? `已生成 ${article.bodyImageIds.length} 张${placeholderCount ? ` · 正文 ${placeholderCount} 处占位` : ''}；替换会覆盖现有内图。`
    : placeholderCount
      ? `正文有 ${placeholderCount} 处占位，按最多 ${bodyLimit} 张生成。`
      : '正文暂无占位；生成时会自动在文末追加占位。';

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="ww-modal ww-image-modal"
      title="配图"
      description={article.title}
      closeLabel="关闭配图"
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="ww-image-manager">
        {loading ? <p className="ww-modal-note">加载配图…</p> : null}
        {error ? <p className="ww-image-gallery__error">{error}</p> : null}
        {generationError ? (
          <div className="ww-image-manager__alert" role="alert" data-testid="ww-image-generate-error">
            <strong>配图生成失败</strong>
            <span>{generationError}</span>
          </div>
        ) : null}

        <div className="ww-image-manager__actions">
          <section className="ww-image-action">
            <div className="ww-image-action__head">
              <span className="ww-image-action__title">首图</span>
              <span className={cover ? 'ww-badge ww-badge--ok' : 'ww-badge'}>
                {cover ? '已生成' : '未生成'}
              </span>
            </div>
            <p className="ww-image-action__desc">{coverMeta}</p>
            <Button
              variant={cover ? 'outline' : 'primary'}
              size="sm"
              className={cover ? 'ww-image-action__button' : 'ww-image-action__button ww-btn-accent'}
              data-testid="ww-image-generate-cover"
              disabled={Boolean(generating)}
              onClick={() => void onGenerate('cover')}
            >
              {generating === 'cover' ? '生成中…' : cover ? '替换首图' : '生成首图'}
            </Button>
          </section>

          <section className="ww-image-action">
            <div className="ww-image-action__head">
              <span className="ww-image-action__title">内图</span>
              <span className={article.bodyImageIds.length ? 'ww-badge ww-badge--ok' : 'ww-badge'}>
                {article.bodyImageIds.length ? `${article.bodyImageIds.length} 张` : '未生成'}
              </span>
            </div>
            <p className="ww-image-action__desc">{bodyMeta}</p>
            <Button
              variant={article.bodyImageIds.length ? 'outline' : 'primary'}
              size="sm"
              className={
                article.bodyImageIds.length
                  ? 'ww-image-action__button'
                  : 'ww-image-action__button ww-btn-accent'
              }
              data-testid="ww-image-generate-body"
              disabled={Boolean(generating)}
              onClick={() => void onGenerate('body')}
            >
              {generating === 'body'
                ? '生成中…'
                : article.bodyImageIds.length
                  ? '替换内图'
                  : '生成内图'}
            </Button>
          </section>
        </div>

        <div className="ww-image-manager__gallery-head">
          <h4>已有配图</h4>
          <span>{all.length} 张</span>
        </div>

        {!loading && all.length === 0 ? (
          <div className="ww-image-manager__empty">
            还没有配图。点上方「生成首图」或「生成内图」开始。
          </div>
        ) : null}

        {all.length > 0 ? (
          <div className="ww-image-gallery" data-testid="ww-image-gallery">
            {all.map((asset) => {
              const dataUrl = toDataUrl(asset);
              const bodyIndex = asset.kind === 'body' ? article.bodyImageIds.indexOf(asset.id) + 1 : 0;
              const label = asset.kind === 'cover' ? '封面' : `正文图${bodyIndex > 0 ? ` ${bodyIndex}` : ''}`;
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
      </div>
    </Modal>
  );
}
