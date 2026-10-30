import { describe, expect, it } from 'vitest';
import { deriveDigest } from '@/host/articles-store';

/**
 * 管线派生摘要必须符合微信摘要 120 字节上限（UTF-8），否则推送预检会拒绝。
 */

describe('deriveDigest（微信摘要 120 字节）', () => {
  it('中文长文：按 UTF-8 字节截断到 ≤118 字节，且不切坏多字节字符', () => {
    const digest = deriveDigest(`# 标题\n\n${'中'.repeat(200)}`);
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(118);
    expect(digest.endsWith('中')).toBe(true);
  });

  it('英文/短文本：保留内容并清洗 Markdown 标记', () => {
    expect(deriveDigest('# Hello `world`\n\n- item')).toBe('Hello world item');
  });

  it('空文本：返回空串', () => {
    expect(deriveDigest('   \n# ')).toBe('');
  });
});
