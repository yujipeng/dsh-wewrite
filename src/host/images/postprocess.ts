/**
 * 微信图片后处理（I-02 / I-03）：
 * 裁剪到目标比例 → JPEG 质量梯度压缩到 <1MB → 仍超限时按比例降分辨率。
 * sharp 为 optionalDependency：加载失败时原样返回（compressed=false），由推送预检兜底报错。
 */

export interface TargetSize {
  readonly width: number;
  readonly height: number;
}

export interface ProcessedImage {
  readonly buffer: Buffer;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly compressed: boolean;
}

/** 留 8% 编码余量，目标 ≤0.92MB。 */
export const WECHAT_IMAGE_MAX_BYTES = Math.floor(0.92 * 1024 * 1024);

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

export async function processForWeChat(
  buffer: Buffer,
  mime: string,
  target: TargetSize,
  maxBytes = WECHAT_IMAGE_MAX_BYTES,
): Promise<ProcessedImage> {
  const sharp = await loadSharp();
  if (!sharp || buffer.length === 0) {
    return { buffer, mime, width: 0, height: 0, bytes: buffer.length, compressed: false };
  }

  const render = async (width: number, height: number, quality: number): Promise<Buffer> =>
    sharp(buffer)
      .rotate()
      .resize(width, height, { fit: 'cover', position: 'centre' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

  try {
    // 1) 目标尺寸 + 质量梯度
    for (const quality of [90, 86, 82, 80]) {
      const out = await render(target.width, target.height, quality);
      if (out.length <= maxBytes) {
        return {
          buffer: out,
          mime: 'image/jpeg',
          width: target.width,
          height: target.height,
          bytes: out.length,
          compressed: true,
        };
      }
    }

    // 2) 仍超限：保持目标比例降分辨率，再降质量
    for (const width of [1600, 1280, 1024]) {
      const height = Math.max(1, Math.round((width * target.height) / target.width));
      for (const quality of [80, 76, 72]) {
        const out = await render(width, height, quality);
        if (out.length <= maxBytes) {
          return { buffer: out, mime: 'image/jpeg', width, height, bytes: out.length, compressed: true };
        }
      }
    }

    // 3) 高熵极值图兜底：返回最小尺寸结果；若仍超限，推送预检会拒绝并给出可读错误。
    const width = 1024;
    const height = Math.max(1, Math.round((width * target.height) / target.width));
    const out = await render(width, height, 72);
    return { buffer: out, mime: 'image/jpeg', width, height, bytes: out.length, compressed: true };
  } catch {
    // 压缩/裁剪失败不阻断成稿：原样返回并标记 compressed=false，由推送预检兜底。
    return { buffer, mime, width: 0, height: 0, bytes: buffer.length, compressed: false };
  }
}
