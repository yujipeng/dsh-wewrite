import { describe, expect, it } from 'vitest';
import { deriveTitle } from '@/host/articles-store';

describe('deriveTitle（v0.5 标题推导 + 图片首行修复）', () => {
  it('首行是图片 Markdown 时，不再把图片当标题（回退 topic）', () => {
    const markdown = '![收银台后面手写的保本线便签](图片待生成)\n\n2023 年 10 月的一个晚上，我蹲在吧台后面按计算器。';
    expect(deriveTitle(markdown, '咖啡店保本线为什么不是一个数字')).toBe('咖啡店保本线为什么不是一个数字');
  });

  it('有 H1 时 H1 优先于 topic', () => {
    expect(deriveTitle('# 真实标题\n\n正文', 'topic')).toBe('真实标题');
  });

  it('无 H1 / 无 topic → 首段非图片正文', () => {
    const markdown = '![图](x)\n\n## 一节\n\n真正的第一段。';
    expect(deriveTitle(markdown)).toBe('真正的第一段。');
  });

  it('清理行内 Markdown 与多余空白', () => {
    expect(deriveTitle('# **加粗** `代码` [链接](https://x)\n')).toBe('加粗 代码 链接');
  });

  it('截断到 40 字', () => {
    expect(deriveTitle(`# ${'字'.repeat(60)}`)).toHaveLength(40);
  });
});
