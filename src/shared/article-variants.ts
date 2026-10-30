/**
 * I-17 三稿派生（纯函数）：正文稿是唯一真源，排版稿/发布稿按需派生，不落库。
 * - 正文稿：去掉 `:::` 容器标记，保留容器内容（公众号纯正文）。
 * - 排版稿：原文（含容器），渲染 `:::` 卡片。
 * - 发布稿：排版稿 + 图片路径替换；图片 URL 在推送时上传后替换，预览层用 data URL。
 */

export type ArticleVariant = 'body' | 'layout' | 'publish';

export const ARTICLE_VARIANT_LABELS: Readonly<Record<ArticleVariant, string>> = {
  body: '正文稿',
  layout: '排版稿',
  publish: '发布稿',
};

export interface ArticleVariants {
  readonly body: string;
  readonly layout: string;
  readonly publish: string;
}

const CONTAINER_MARKER = /^:::(?:steps|summary|highlight)\s*$|^:::\s*$/;

/** 去掉容器标记行，保留容器内的正文。 */
export function stripContainerMarkers(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !CONTAINER_MARKER.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function deriveArticleVariants(markdown: string): ArticleVariants {
  const layout = markdown.trim();
  return {
    body: stripContainerMarkers(layout),
    layout,
    // 图片路径替换发生在推送上传之后；这里保持排版稿，避免预览与推送字节漂移。
    publish: layout,
  };
}
