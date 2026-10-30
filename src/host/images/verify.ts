/**
 * I-19 量化验图：不依赖模型读图，用确定性指标判断图片是否可用。
 * 格式 / 目标比例误差 / 最小宽度 / 明度标准差 / 三段明度差。
 * sharp 不可用时降级为「跳过验图」，不阻断成稿。
 */

export type ImageKind = 'cover' | 'body';

export interface ImageVerifyResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
}

const TARGETS: Readonly<Record<ImageKind, { readonly width: number; readonly height: number; readonly minWidth: number }>> = {
  // 与 images.ts 的 COVER_TARGET / BODY_TARGET 保持一致（1280 宽满足微信封面建议）。
  cover: { width: 1280, height: 545, minWidth: 1200 },
  body: { width: 1280, height: 720, minWidth: 1200 },
};
const RATIO_TOLERANCE = 0.02;
const MIN_BRIGHTNESS_STD = 8;
const MIN_SEGMENT_DIFF = 4;

type SharpFactory = typeof import('sharp')['default'];

let sharpPromise: Promise<SharpFactory | null> | undefined;

async function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((module) => module.default)
      .catch(() => null);
  }
  return sharpPromise;
}

export async function verifyImage(buffer: Buffer, kind: ImageKind): Promise<ImageVerifyResult> {
  const sharp = await loadSharp();
  if (buffer.length === 0) {
    return { ok: false, issues: ['图片为空'] };
  }
  if (!sharp) {
    // 依赖不可用：交由推送预检兜底，验图本身不阻断。
    return { ok: true, issues: ['sharp 不可用，跳过验图'] };
  }
  try {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const format = metadata.format ?? '';
    const target = TARGETS[kind];
    const issues: string[] = [];

    if (!['jpeg', 'png', 'webp'].includes(format)) issues.push(`不支持的图片格式：${format || 'unknown'}`);
    if (width <= 0 || height <= 0) issues.push('无法读取图片尺寸');
    if (width < target.minWidth) issues.push(`图片宽度不足：${width} < ${target.minWidth}`);
    if (width > 0 && height > 0) {
      const expected = target.width / target.height;
      const actual = width / height;
      if (Math.abs(actual - expected) > RATIO_TOLERANCE) {
        issues.push(`宽高比偏差过大：${actual.toFixed(3)} vs ${expected.toFixed(3)}`);
      }
    }

    const stats = await sharp(buffer).stats();
    const brightnessStd = Math.max(...stats.channels.map((channel) => channel.stdev));
    if (brightnessStd < MIN_BRIGHTNESS_STD) issues.push('图片近似纯色，缺少视觉信息');

    // 三段明度差：上/中/下三段的平均亮度差，防单点构图。
    // 注意：sharp.stats() 在 extract 之后返回的是整图统计（实测），这里用 raw 像素自行计算。
    const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const rawWidth = raw.info.width;
    const rawHeight = raw.info.height;
    const channels = raw.info.channels;
    const bandHeight = Math.max(1, Math.floor(rawHeight / 3));
    const means: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const start = Math.min(index * bandHeight, rawHeight);
      const end = Math.min(rawHeight, start + bandHeight);
      let sum = 0;
      let count = 0;
      for (let y = start; y < end; y += 1) {
        for (let x = 0; x < rawWidth; x += 1) {
          const offset = (y * rawWidth + x) * channels;
          const pixelChannels = Math.min(3, channels);
          let value = 0;
          for (let channel = 0; channel < pixelChannels; channel += 1) value += raw.data[offset + channel] ?? 0;
          sum += value / pixelChannels;
          count += 1;
        }
      }
      means.push(count > 0 ? sum / count : 0);
    }
    if (means.length === 3 && Math.max(...means) - Math.min(...means) < MIN_SEGMENT_DIFF) {
      issues.push('三段明度差过小，构图过于单一');
    }

    return {
      ok: issues.length === 0,
      issues,
      width,
      height,
      format,
    };
  } catch {
    return { ok: true, issues: ['验图失败（sharp 异常），跳过'] };
  }
}
