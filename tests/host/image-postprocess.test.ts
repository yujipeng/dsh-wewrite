import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { processForWeChat, WECHAT_IMAGE_MAX_BYTES } from '@/host/images/postprocess';

/**
 * 微信图片后处理（I-02 / I-03）：
 * 裁剪到封面 2.35:1 / 正文 16:9，JPEG 压缩到 <1MB；高熵图降分辨率兜底。
 * 使用 sharp 生成固定样本，避免把大图放进仓库。
 */

const smoothPng = async (width = 2048, height = 2048): Promise<Buffer> =>
  sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .blur(16)
    .png()
    .toBuffer();

describe('processForWeChat', () => {
  it(
    '封面：裁剪到 1280×545（2.35:1）并压缩到 <1MB',
    async () => {
      const source = await smoothPng();
      const result = await processForWeChat(source, 'image/png', { width: 1280, height: 545 });

      expect(result.compressed).toBe(true);
      expect(result.mime).toBe('image/jpeg');
      expect(result.width).toBe(1280);
      expect(result.height).toBe(545);
      expect(result.width / result.height).toBeCloseTo(2.349, 2);
      expect(result.bytes).toBeLessThanOrEqual(WECHAT_IMAGE_MAX_BYTES);
      expect(result.buffer.length).toBe(result.bytes);
    },
    30_000,
  );

  it(
    '正文：裁剪到 1280×720（16:9）并压缩到 <1MB',
    async () => {
      const source = await smoothPng();
      const result = await processForWeChat(source, 'image/png', { width: 1280, height: 720 });

      expect(result.width).toBe(1280);
      expect(result.height).toBe(720);
      expect(result.width / result.height).toBeCloseTo(16 / 9, 2);
      expect(result.bytes).toBeLessThanOrEqual(WECHAT_IMAGE_MAX_BYTES);
    },
    30_000,
  );

  it(
    '高熵图：质量梯度仍超限时降分辨率，比例保持不变且 <1MB',
    async () => {
      const source = await sharp(randomBytes(2048 * 2048 * 3), {
        raw: { width: 2048, height: 2048, channels: 3 },
      })
        .png()
        .toBuffer();
      expect(source.length).toBeGreaterThan(1024 * 1024);

      const result = await processForWeChat(source, 'image/png', { width: 1280, height: 545 });

      expect(result.bytes).toBeLessThanOrEqual(WECHAT_IMAGE_MAX_BYTES);
      expect(result.width).toBeLessThanOrEqual(1280);
      expect(result.width / result.height).toBeCloseTo(2.349, 2);
    },
    30_000,
  );

  it('空 buffer：不崩溃，compressed=false，交由预检拒绝', async () => {
    const result = await processForWeChat(Buffer.alloc(0), 'image/png', { width: 1280, height: 545 });
    expect(result).toMatchObject({ bytes: 0, compressed: false });
  });
});
