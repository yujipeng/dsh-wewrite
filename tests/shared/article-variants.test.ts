import { describe, expect, it } from 'vitest';
import { deriveArticleVariants, stripContainerMarkers } from '@/shared/article-variants';

const markdown = [
  '## 标题',
  '',
  ':::steps',
  '1. 第一步',
  '2. 第二步',
  ':::',
  '',
  ':::summary',
  '总结。',
  ':::',
  '',
  '正文段落。',
].join('\n');

describe('I-17 三稿派生', () => {
  it('正文稿去掉 ::: 标记，保留容器内容', () => {
    const body = stripContainerMarkers(markdown);
    expect(body).not.toContain(':::');
    expect(body).toContain('第一步');
    expect(body).toContain('总结。');
    expect(body).toContain('正文段落。');
  });

  it('排版稿保留原文容器标记', () => {
    const { layout } = deriveArticleVariants(markdown);
    expect(layout).toContain(':::steps');
    expect(layout).toContain(':::summary');
  });

  it('发布稿当前与排版稿一致（图片 URL 在推送时替换）', () => {
    const { layout, publish } = deriveArticleVariants(markdown);
    expect(publish).toBe(layout);
  });

  it('同一正文三次派生结果稳定', () => {
    const first = deriveArticleVariants(markdown);
    const second = deriveArticleVariants(markdown);
    const third = deriveArticleVariants(markdown);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('普通正文（无容器）三稿一致', () => {
    const plain = '## 标题\n\n普通正文。';
    const variants = deriveArticleVariants(plain);
    expect(variants.body).toBe(plain);
    expect(variants.layout).toBe(plain);
    expect(variants.publish).toBe(plain);
  });
});
