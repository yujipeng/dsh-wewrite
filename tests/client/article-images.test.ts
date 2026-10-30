import { describe, expect, it } from 'vitest';
import { imageDownloadName } from '@/client/lib/image-download';

describe('imageDownloadName', () => {
  it('jpeg → jpg，文件名带 slug / kind / 短 id', () => {
    expect(
      imageDownloadName(
        { slug: 'test-article' },
        { id: 'img_abcdef123456', kind: 'cover', mime: 'image/jpeg' },
      ),
    ).toBe('test-article-cover-123456.jpg');
  });

  it('png / webp 按 mime 选择扩展名', () => {
    expect(
      imageDownloadName({ slug: 'a' }, { id: 'img_1', kind: 'body', mime: 'image/png' }),
    ).toBe('a-body-1.png');
    expect(
      imageDownloadName({ slug: 'b' }, { id: 'img_2', kind: 'cover', mime: 'image/webp' }),
    ).toBe('b-cover-2.webp');
  });

  it('未知 mime 回退为 img', () => {
    expect(
      imageDownloadName({ slug: 'c' }, { id: 'img_3', kind: 'body', mime: 'image/avif' }),
    ).toBe('c-body-3.img');
  });
});
