import { describe, expect, it } from 'vitest';
import { extractKeySections, verifyDraft } from '@/host/wechat/verify';

/**
 * 推送后回读校验（I-04）：只做确定性比对，失败不回滚推送，只记录 issues。
 */

const expected = {
  title: '标题',
  author: '作者',
  digest: '摘要',
  thumbMediaId: 'thumb_1',
  contentImageCount: 1,
  keySections: ['第一节'],
  minTextChars: 10,
};

const actual = {
  title: '标题',
  author: '作者',
  digest: '摘要',
  thumbMediaId: 'thumb_1',
  content: '<h2>第一节</h2><p>正文内容足够长，能被校验识别。</p><img src="https://mmbiz.test/1.jpg" />',
};

describe('verifyDraft（推送后回读）', () => {
  it('全部一致：ok=true，无 issues', () => {
    expect(verifyDraft(actual, expected)).toEqual({ ok: true, issues: [] });
  });

  it('标题/作者/摘要/封面不一致分别报告', () => {
    const result = verifyDraft(
      { ...actual, title: '另一个标题', author: '另一个作者', digest: '另一个摘要', thumbMediaId: 'thumb_2' },
      expected,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join()).toContain('标题不一致');
    expect(result.issues.join()).toContain('作者不一致');
    expect(result.issues.join()).toContain('摘要不一致');
    expect(result.issues.join()).toContain('thumb_media_id 不一致');
  });

  it('正文图片数不一致报告', () => {
    const result = verifyDraft({ ...actual, content: '<p>正文内容足够长，能被校验识别。</p>' }, expected);
    expect(result.issues.join()).toContain('正文图片数不一致');
  });

  it('缺少 H2 小节与正文过短分别报告', () => {
    const result = verifyDraft(
      { ...actual, content: '<p>短</p><img src="x"/>' },
      expected,
    );
    expect(result.issues.join()).toContain('正文缺少小节：第一节');
    expect(result.issues.join()).toContain('正文长度不足');
  });

  it('标题内联标签导致空白差异时不误报（真实回归修复）', () => {
    const result = verifyDraft(
      {
        ...actual,
        content: '<h2>一、46 杯<span> 是算出来的</span>，也是编出来的</h2><p>正文内容足够长，能被校验识别。</p><img src="x"/>',
      },
      { ...expected, keySections: ['一、46 杯是算出来的，也是编出来的'] },
    );
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('extractKeySections：只提取 H2，忽略代码块中的井号行', () => {
    const markdown = ['# 标题', '## 第一节', '正文', '## 第二节', '```', '## 不是标题', '```'].join('\n');
    expect(extractKeySections(markdown)).toEqual(['第一节', '第二节']);
  });
});
