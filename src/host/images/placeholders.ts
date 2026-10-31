/**
 * 正文配图占位符工具：模型会在正文写 `![alt](图片待生成)`，渲染层把它保留为占位图，
 * 推送时按顺序替换为微信 CDN 图。手动补图时用于统计/补齐占位。
 */

const PLACEHOLDER_RE = /图片待生成/g;

export function countImagePlaceholders(markdown: string): number {
  return (markdown.match(PLACEHOLDER_RE) ?? []).length;
}

/** 保证正文至少有 needed 个占位；不足时在文末追加。 */
export function ensureImagePlaceholders(markdown: string, needed: number): string {
  const current = countImagePlaceholders(markdown);
  if (current >= needed) return markdown;
  const missing = needed - current;
  const block = Array.from({ length: missing }, () => '![正文配图](图片待生成)').join('\n\n');
  return `${markdown.trimEnd()}\n\n${block}\n`;
}
