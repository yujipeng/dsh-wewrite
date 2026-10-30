/**
 * 推送后回读校验（I-04）：只做确定性比对，不做语义判断。
 * 回读失败/不一致不回滚已推送事实，只把 issues 写入文章发布记录并在 UI 标红。
 */

export interface DraftVerifyExpected {
  readonly title: string;
  readonly author: string;
  readonly digest: string;
  readonly thumbMediaId: string;
  readonly contentImageCount: number;
  readonly keySections: readonly string[];
  readonly minTextChars?: number;
}

export interface DraftVerifyActual {
  readonly title: string;
  readonly author: string;
  readonly digest: string;
  readonly content: string;
  readonly thumbMediaId: string;
}

export interface DraftVerifyResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从正文 Markdown 提取 H2 小节名（用于回读后确认关键段落没被吞）。 */
export function extractKeySections(markdown: string): string[] {
  const withoutFences = markdown.replace(/(```|~~~)[\s\S]*?\1/g, '');
  return [...withoutFences.matchAll(/^##\s+(.+)$/gm)]
    .map((match) => (match[1] ?? '').trim())
    .filter((section) => section.length > 0);
}

export function verifyDraft(actual: DraftVerifyActual, expected: DraftVerifyExpected): DraftVerifyResult {
  const issues: string[] = [];

  if (actual.title !== expected.title) {
    issues.push(`标题不一致：期望「${expected.title}」，回读「${actual.title}」`);
  }
  if (expected.author && actual.author !== expected.author) {
    issues.push(`作者不一致：期望「${expected.author}」，回读「${actual.author}」`);
  }
  if (actual.digest !== expected.digest) {
    issues.push(`摘要不一致：期望「${expected.digest}」，回读「${actual.digest}」`);
  }
  if (actual.thumbMediaId !== expected.thumbMediaId) {
    issues.push('封面 thumb_media_id 不一致');
  }

  const imageCount = (actual.content.match(/<img\b/gi) ?? []).length;
  if (imageCount !== expected.contentImageCount) {
    issues.push(`正文图片数不一致：期望 ${expected.contentImageCount} 张，回读 ${imageCount} 张`);
  }

  const text = stripHtml(actual.content);
  if (expected.minTextChars && text.length < expected.minTextChars) {
    issues.push(`正文长度不足：回读 ${text.length} 字，低于下限 ${expected.minTextChars} 字`);
  }
  for (const section of expected.keySections) {
    if (!text.includes(section)) {
      issues.push(`正文缺少小节：${section}`);
    }
  }

  return { ok: issues.length === 0, issues };
}
