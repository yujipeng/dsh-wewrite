import { describe, expect, it } from 'vitest';
import {
  EMPTY_WRITING_PROFILE,
  WritingProfileSchema,
  type WritingProfile,
} from '@/shared/schema-base';
import { draftUserPrompt, outlineUserPrompt, styleGuideLines } from '@/host/pipeline/llm';
import { findExemplarOverlap, runQualityGates } from '@/host/pipeline/steps/gates';

const LEGACY_PROFILE = {
  name: '社会现象心理分析',
  industry: '心理学',
  topics: ['社会热点背后的心理机制'],
  tone: '冷静',
  voice: '第一人称',
  wordCount: '1800-2600',
  contentStyle: '观点',
  persona: 'midnight-friend',
  blacklistWords: ['震惊'],
  blacklistTopics: ['裁员'],
  coverStyle: '',
};

const PROFILE: WritingProfile = {
  ...LEGACY_PROFILE,
  styleGuide: '每段 2–2.5 句；每千字数字 ≥25；禁止连续设问自答。',
  styleExemplars: [
    {
      title: '用事实开场',
      excerpt: '这事得先从一个数字说起。今年 5 月，国家统计局公布了抽样调查公报。',
      learn: '事实开场 / 数据口径',
    },
  ],
};

describe('WritingProfile schema', () => {
  it('旧配置缺 styleGuide / styleExemplars 时按默认值解析（无需迁移）', () => {
    const parsed = WritingProfileSchema.parse(LEGACY_PROFILE);
    expect(parsed.styleGuide).toBe('');
    expect(parsed.styleExemplars).toEqual([]);
  });

  it('空对象也能解析为全默认值', () => {
    const parsed = WritingProfileSchema.parse({});
    expect(parsed.styleGuide).toBe('');
    expect(parsed.styleExemplars).toEqual([]);
  });

  it('styleGuide 超过 4000 字被拒绝', () => {
    expect(() => WritingProfileSchema.parse({ ...LEGACY_PROFILE, styleGuide: '风'.repeat(4001) })).toThrow();
  });

  it('范文超过 3 条或节选超过 2000 字被拒绝', () => {
    const item = { title: 't', excerpt: '正文', learn: '' };
    expect(() =>
      WritingProfileSchema.parse({
        ...LEGACY_PROFILE,
        styleExemplars: [item, item, item, item],
      }),
    ).toThrow();
    expect(() =>
      WritingProfileSchema.parse({
        ...LEGACY_PROFILE,
        styleExemplars: [{ title: 't', excerpt: '范'.repeat(2001), learn: '' }],
      }),
    ).toThrow();
  });
});

describe('styleGuideLines', () => {
  it('空值不注入', () => {
    expect(styleGuideLines(undefined)).toEqual([]);
    expect(styleGuideLines(EMPTY_WRITING_PROFILE)).toEqual([]);
  });

  it('注入风格指南并声明事实优先', () => {
    const text = styleGuideLines(PROFILE).join('\n');
    expect(text).toContain('文风基准');
    expect(text).toContain('与事实冲突时以事实与来源约束为准');
    expect(text).toContain(PROFILE.styleGuide);
  });

  it('范文块带禁止复用声明、标题、学习点与节选', () => {
    const text = styleGuideLines(PROFILE).join('\n');
    expect(text).toContain('风格样例');
    expect(text).toContain('禁止复用其中的观点、句子、数字组合、人物和个人经历');
    expect(text).toContain('【样例 1】用事实开场');
    expect(text).toContain('学习点：事实开场 / 数据口径');
    expect(text).toContain('这事得先从一个数字说起');
  });

  it('过滤空节选，最多注入 3 条', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      title: `样例${index}`,
      excerpt: `第 ${index} 段正文，用来验证条数上限。`,
      learn: '',
    }));
    const lines = styleGuideLines({ ...PROFILE, styleExemplars: [items[0], { title: 'empty', excerpt: '  ', learn: '' }, ...items.slice(1)] });
    expect(lines.join('\n')).toContain('【样例 3】');
    expect(lines.join('\n')).not.toContain('【样例 4】');
    expect(lines.join('\n')).not.toContain('empty');
  });

  it('超长指南与节选按预算截断并标记', () => {
    const text = styleGuideLines({
      ...PROFILE,
      styleGuide: '风'.repeat(4500),
      styleExemplars: [{ title: '长范文', excerpt: '范'.repeat(2500), learn: '' }],
    }).join('\n');
    expect(text).toContain('…（已截断）');
    expect(text).toContain('风'.repeat(4000));
    expect(text).not.toContain('风'.repeat(4001));
    expect(text).toContain('范'.repeat(2000));
    expect(text).not.toContain('范'.repeat(2001));
  });
});

describe('outline / draft prompt 注入', () => {
  it('大纲与成稿提示词都带风格指南与范文', () => {
    const outline = outlineUserPrompt('服务神话为什么搬不动', undefined, undefined, PROFILE);
    const draft = draftUserPrompt('服务神话为什么搬不动', '## 事实\n## 机制', undefined, undefined, undefined, PROFILE);
    for (const text of [outline, draft]) {
      expect(text).toContain('文风基准');
      expect(text).toContain('【样例 1】用事实开场');
    }
  });

  it('空白写作档案不注入风格块', () => {
    const draft = draftUserPrompt('主题', '## 一节', undefined, undefined, undefined, EMPTY_WRITING_PROFILE);
    expect(draft).not.toContain('文风基准');
    expect(draft).not.toContain('风格样例');
  });
});

describe('gates 范文重合检查', () => {
  const excerpt = '永辉调改331家门店跨区域跨层级同一套动作要经过更多层传导';
  const article = [
    '# 标题',
    '',
    '永辉调改 331 家门店，跨区域、跨层级，同一套动作要经过更多层传导。',
    '',
    '这是一段用于门禁测试的正文，包含 2026 年 10 月的具体数据和 331 家门店的调改记录。'.repeat(12),
  ].join('\n');

  it('忽略标点与空白也能识别连续 ≥15 字重合', () => {
    expect(findExemplarOverlap('永辉调改了 331 家门店，跨区域、跨层级，同一套动作要经过更多层传导。', excerpt)).not.toBeNull();
    expect(findExemplarOverlap('这是一段完全无关的正文，只讨论天气和交通。', excerpt)).toBeNull();
  });

  it('重合只写报告，不进入阻断 issues', () => {
    const result = runQualityGates({ markdown: article, styleExemplars: [excerpt] });
    expect(result.report.exemplarOverlap?.passed).toBe(false);
    expect(result.report.exemplarOverlap?.issues.join('')).toContain('与范文 1 连续重合');
    expect(result.report.issues.some((issue) => issue.includes('范文'))).toBe(false);
  });

  it('无重合时报告通过；未提供范文时不生成报告项', () => {
    const clean = runQualityGates({ markdown: article, styleExemplars: ['一段与成稿完全无关的范文内容，用来验证无重合路径。'] });
    expect(clean.report.exemplarOverlap?.passed).toBe(true);
    expect(runQualityGates({ markdown: article }).report.exemplarOverlap).toBeUndefined();
  });
});
