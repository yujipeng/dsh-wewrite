import { describe, expect, it } from 'vitest';
import { resolvePreviewImages } from '@/client/lib/preview-images';

describe('resolvePreviewImages', () => {
  it('按顺序把 ww-image-placeholder 替换为 data URL', () => {
    const html =
      '<p>x</p><img alt="a" src="ww-image-placeholder" /><img alt="b" src="ww-image-placeholder" />';
    const output = resolvePreviewImages(html, ['data:image/jpeg;base64,AAA']);

    expect(output).toContain('src="data:image/jpeg;base64,AAA"');
    expect(output.includes('ww-image-placeholder')).toBe(false);
    expect(output).toContain('<p>x</p>');
  });

  it('没有对应正文图时删除占位，不留下空 img', () => {
    expect(resolvePreviewImages('<img src="ww-image-placeholder" />', [])).toBe('');
  });
});
