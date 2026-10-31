import { describe, expect, it } from 'vitest';
import { countImagePlaceholders, ensureImagePlaceholders } from '@/host/images/placeholders';

describe('正文配图占位符', () => {
  it('统计图片占位符数量', () => {
    const markdown = '开头\n\n![图1](图片待生成)\n\n正文\n\n![图2](图片待生成)';
    expect(countImagePlaceholders(markdown)).toBe(2);
  });

  it('占位符足够时不改动正文', () => {
    const markdown = '![图1](图片待生成)\n\n正文';
    expect(ensureImagePlaceholders(markdown, 1)).toBe(markdown);
  });

  it('不足时在文末补齐缺失数量', () => {
    const markdown = '![图1](图片待生成)\n\n正文';
    const next = ensureImagePlaceholders(markdown, 3);
    expect(countImagePlaceholders(next)).toBe(3);
    expect(next.endsWith('图片待生成)\n')).toBe(true);
  });

  it('完全没有占位符时追加', () => {
    const next = ensureImagePlaceholders('正文', 2);
    expect(countImagePlaceholders(next)).toBe(2);
    expect(next).toContain('正文\n\n![正文配图](图片待生成)');
  });
});
