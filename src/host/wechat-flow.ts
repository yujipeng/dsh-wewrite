/**
 * 微信推送编排（F3 / AC-1 / AC-7）：从 service 拆出（单文件 <=300 行纪律）。
 * 门禁闸门：article.status 未到 rendered/pushed 即拒绝；成功才回填 mediaId（原子化）。
 */

import { convertArticle } from '../render/convert';
import type { ArticleRecord, ImageRecord } from './domain';
import { WewriteServiceError } from './service-errors';
import type { KvTable } from './platform';
import { createWeChatClient, type DiagnoseResult, type WeChatClientDeps } from './wechat/client';
import { preflightPush } from './wechat/preflight';
import { extractKeySections, verifyDraft } from './wechat/verify';

export interface WeChatFlowDeps {
  readonly articles: KvTable<ArticleRecord>;
  readonly images: KvTable<ImageRecord>;
  readonly clientDeps: WeChatClientDeps;
  readonly refreshSecret: () => Promise<void>;
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now: () => Date;
}

export interface PushArticleResult {
  readonly mediaId: string;
  readonly thumbMediaId: string;
  readonly verify: {
    readonly ok: boolean;
    readonly issues: readonly string[];
    readonly checkedAt: string;
  };
}

export async function pushArticleDraft(deps: WeChatFlowDeps, articleId: string): Promise<PushArticleResult> {
  const article = deps.articles.get(articleId);
  if (!article) throw new WewriteServiceError('article-not-found', `文章不存在：${articleId}`);
  if (article.status === 'editing' || article.status === 'failed') {
    throw new WewriteServiceError('gates-not-passed', '质量门禁未过：该文章尚未通过管线门禁，完成管线或修改后再推送');
  }
  if (!article.coverImageId) throw new WewriteServiceError('cover-missing', '缺少封面图：先运行配图步或绑定封面');
  const cover = deps.images.get(article.coverImageId);
  if (!cover) throw new WewriteServiceError('cover-missing', '封面图记录缺失');
  const bodyImages = article.bodyImageIds
    .map((id) => deps.images.get(id))
    .filter((image): image is ImageRecord => Boolean(image));

  // 预检必须发生在任何微信网络调用之前（含 refreshSecret 后的 token 请求）。
  const preflight = preflightPush({
    title: article.title,
    digest: article.digest,
    bodyImageIds: article.bodyImageIds,
    ...(article.coverImageId ? { coverImageId: article.coverImageId } : {}),
    images: [cover, ...bodyImages].map((image) => ({
      id: image.id,
      kind: image.kind,
      bytes: Buffer.byteLength(image.base64, 'base64'),
      mime: image.mime,
    })),
  });
  if (!preflight.ok) {
    throw new WewriteServiceError(
      'push-preflight-failed',
      `推送前检查未通过：${preflight.issues.join('；')}`,
    );
  }

  await deps.refreshSecret();
  const client = createWeChatClient(deps.clientDeps);
  const html = convertArticle({ markdown: article.markdown, theme: article.theme });
  const result = await client.pushDraft({
    title: article.title,
    digest: article.digest,
    contentHtml: html,
    thumbImage: { buffer: Buffer.from(cover.base64, 'base64'), mime: cover.mime },
    contentImages: bodyImages.map((image) => ({ buffer: Buffer.from(image.base64, 'base64'), mime: image.mime })),
  });

  // I-04：推送后回读。回读失败/不一致不回滚已推送事实，只写发布记录并交给 UI 标红。
  const pushedAt = deps.now().toISOString();
  const digestBytes = Buffer.byteLength(article.digest, 'utf8');
  let verify: PushArticleResult['verify'];
  try {
    const draft = await client.getDraft(result.mediaId);
    const item = draft.newsItems[0];
    verify = item
      ? {
          ...verifyDraft(item, {
            title: article.title,
            author: deps.clientDeps.getSettings().author,
            digest: article.digest,
            thumbMediaId: result.thumbMediaId,
            contentImageCount: bodyImages.length,
            keySections: extractKeySections(article.markdown),
            minTextChars: Math.max(50, Math.floor(article.markdown.replace(/\s+/g, '').length * 0.4)),
          }),
          checkedAt: pushedAt,
        }
      : { ok: false, issues: ['回读草稿为空：draft/get 未返回 news_item'], checkedAt: pushedAt };
  } catch (error) {
    verify = {
      ok: false,
      issues: [`回读校验失败：${error instanceof Error ? error.message : String(error)}`],
      checkedAt: pushedAt,
    };
  }

  await deps.serialize(async () => {
    const current = deps.articles.get(articleId);
    if (!current) return;
    await deps.articles.put(articleId, {
      ...current,
      status: 'pushed',
      wechatMediaId: result.mediaId,
      thumbMediaId: result.thumbMediaId,
      pushedAt,
      digestBytes,
      pushVerify: { ...verify, issues: [...verify.issues] },
      updatedAt: deps.now().toISOString(),
    });
  });
  return { ...result, verify };
}

export async function diagnoseWeChat(deps: WeChatFlowDeps): Promise<DiagnoseResult> {
  await deps.refreshSecret();
  return createWeChatClient(deps.clientDeps).diagnose();
}
