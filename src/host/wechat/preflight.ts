/**
 * 推送前预检（I-01）：把微信硬限制集中在校验层，纯函数、零网络调用。
 * 任意一项不过即拒绝推送，避免把超限内容发给 API 后才拿到不可读错误。
 */

export const WECHAT_LIMITS = {
  /** 微信草稿标题上限（字符数，非字节）。 */
  titleMaxChars: 64,
  /** 摘要上限（UTF-8 字节数）。 */
  digestMaxBytes: 120,
  /** 正文图片张数上限。 */
  bodyImageMax: 10,
  /** 单图上限（uploadimg / add_material 均要求 < 1MB）。 */
  imageMaxBytes: 1024 * 1024,
} as const;

export interface PreflightImage {
  readonly id: string;
  readonly kind: 'cover' | 'body';
  readonly bytes: number;
  readonly mime: string;
}

export interface PreflightInput {
  readonly title: string;
  readonly digest: string;
  readonly bodyImageIds: readonly string[];
  readonly coverImageId?: string;
  readonly images: readonly PreflightImage[];
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function preflightPush(input: PreflightInput): PreflightResult {
  const issues: string[] = [];
  const titleChars = [...input.title].length;
  if (!input.title.trim()) {
    issues.push('标题为空');
  } else if (titleChars > WECHAT_LIMITS.titleMaxChars) {
    issues.push(`标题 ${titleChars} 字，超过微信上限 ${WECHAT_LIMITS.titleMaxChars} 字`);
  }

  const digestBytes = Buffer.byteLength(input.digest, 'utf8');
  if (digestBytes > WECHAT_LIMITS.digestMaxBytes) {
    issues.push(`摘要 ${digestBytes} 字节，超过微信上限 ${WECHAT_LIMITS.digestMaxBytes} 字节`);
  }

  if (input.bodyImageIds.length > WECHAT_LIMITS.bodyImageMax) {
    issues.push(`正文图 ${input.bodyImageIds.length} 张，超过微信上限 ${WECHAT_LIMITS.bodyImageMax} 张`);
  }

  if (!input.coverImageId) {
    issues.push('缺少封面图');
  }

  const byId = new Map(input.images.map((image) => [image.id, image]));
  const checked = new Set<string>();
  if (input.coverImageId) {
    const cover = byId.get(input.coverImageId);
    if (!cover) issues.push(`封面图记录缺失：${input.coverImageId}`);
    else checked.add(cover.id);
  }
  for (const id of input.bodyImageIds) {
    const image = byId.get(id);
    if (!image) {
      issues.push(`正文图记录缺失：${id}`);
      continue;
    }
    checked.add(id);
  }

  for (const id of checked) {
    const image = byId.get(id);
    if (!image) continue;
    if (!image.mime.startsWith('image/')) {
      issues.push(`图片 ${id} 类型不是 image/*（${image.mime || '未知'}）`);
    }
    if (image.bytes <= 0) {
      issues.push(`图片 ${id} 内容为空`);
    } else if (image.bytes >= WECHAT_LIMITS.imageMaxBytes) {
      issues.push(`图片 ${id} ${(image.bytes / 1024 / 1024).toFixed(2)}MB，超过单图 1MB 上限`);
    }
  }

  return { ok: issues.length === 0, issues };
}
