import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { verifyImage } from '@/host/images/verify';

const banded = async (width: number, height: number): Promise<Buffer> => {
  const band = Math.floor(height / 3);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="#111111"/>`,
    `<rect y="${band}" width="${width}" height="${band}" fill="#888888"/>`,
    `<rect y="${band * 2}" width="${width}" height="${height - band * 2}" fill="#eeeeee"/>`,
    '</svg>',
  ].join('');
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
};

describe('I-19 量化验图', () => {
  it('正常封面（三段落差、比例正确）通过', async () => {
    const result = await verifyImage(await banded(1280, 545), 'cover');
    expect(result.ok, result.issues.join('；')).toBe(true);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(545);
    expect(result.format).toBe('jpeg');
  });

  it('纯色图不通过（明度标准差过低）', async () => {
    const solid = await sharp({
      create: { width: 1280, height: 545, channels: 3, background: { r: 20, g: 20, b: 20 } },
    })
      .jpeg()
      .toBuffer();
    const result = await verifyImage(solid, 'cover');
    expect(result.ok).toBe(false);
    expect(result.issues.join('')).toContain('纯色');
  });

  it('宽高比错误不通过', async () => {
    const result = await verifyImage(await banded(1280, 720), 'cover');
    expect(result.ok).toBe(false);
    expect(result.issues.join('')).toContain('宽高比');
  });

  it('正常正文（16:9）通过', async () => {
    const result = await verifyImage(await banded(1280, 720), 'body');
    expect(result.ok, result.issues.join('；')).toBe(true);
  });

  it('空 buffer 不通过', async () => {
    const result = await verifyImage(Buffer.alloc(0), 'cover');
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('图片为空');
  });
});
