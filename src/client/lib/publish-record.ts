/**
 * 发布记录导出（I-05）：与外部流程同形的纯文本，供复制/留档。
 * 未推送的文章也能导出，明确标注「未推送」而不是编造时间。
 */

import type { ArticleDetail } from '@/shared/contract';

export function formatPublishRecord(article: ArticleDetail): string {
  const digestBytes = article.digestBytes ?? new TextEncoder().encode(article.digest).length;
  const lines = [
    `标题：${article.title}`,
    `media_id：${article.wechatMediaId ?? '（未推送）'}`,
    `thumb_media_id：${article.thumbMediaId ?? '（无）'}`,
    `推送时间：${article.pushedAt ?? '（未推送）'}`,
    `摘要字节：${digestBytes}`,
  ];
  if (article.pushVerify) {
    lines.push(`回读校验：${article.pushVerify.ok ? '通过' : '未通过'}（${article.pushVerify.checkedAt}）`);
    if (!article.pushVerify.ok) {
      lines.push(...article.pushVerify.issues.map((issue) => `- ${issue}`));
    }
  } else {
    lines.push('回读校验：（无记录）');
  }
  return lines.join('\n');
}
