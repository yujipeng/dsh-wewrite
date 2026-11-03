import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_THRESHOLD,
  judgeEditorialReview,
  parseEditorialReview,
  reviewArticle,
} from '@/host/pipeline/steps/editorial-review';
import type { PipelineLlm } from '@/host/pipeline/llm';
import type { HostLogger } from '@/host/platform';
import type { WritingProfile } from '@/shared/schema-base';

const validJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    dimensions: { accuracy: 4.2, viewpoint: 4, usefulness: 4.5, voice: 3.8, readability: 4.1 },
    blockers: [],
    majorIssues: [],
    notes: '整体成立',
    ...overrides,
  });

describe('parseEditorialReview', () => {
  it('解析合法 JSON 并保留一位小数', () => {
    const review = parseEditorialReview(validJson(), 'glm-4.7', '2026-10-30T00:00:00.000Z');
    expect(review).not.toBeNull();
    expect(review?.dimensions.accuracy).toBe(4.2);
    expect(review?.dimensions.readability).toBe(4.1);
    expect(review?.notes).toBe('整体成立');
  });

  it('兼容 ```json 代码围栏与前后缀文字', () => {
    const review = parseEditorialReview(
      `评审如下：\n\`\`\`json\n${validJson()}\n\`\`\`\n以上。`,
      'glm-4.7',
      '2026-10-30T00:00:00.000Z',
    );
    expect(review?.dimensions.viewpoint).toBe(4);
  });

  it('缺维度按 3 分中性处理；越界分数被 clamp 到 0–5', () => {
    const review = parseEditorialReview(
      JSON.stringify({ dimensions: { accuracy: 9, viewpoint: -2 } }),
      'glm-4.7',
      '2026-10-30T00:00:00.000Z',
    );
    expect(review?.dimensions.accuracy).toBe(5);
    expect(review?.dimensions.viewpoint).toBe(0);
    expect(review?.dimensions.usefulness).toBe(3);
  });

  it('非 JSON / 缺 dimensions → null（调用方降级）', () => {
    expect(parseEditorialReview('不是 JSON', 'm', '2026-10-30T00:00:00.000Z')).toBeNull();
    expect(parseEditorialReview('{"blockers":[]}', 'm', '2026-10-30T00:00:00.000Z')).toBeNull();
  });
});

describe('judgeEditorialReview', () => {
  const review = (dimensions: Record<string, number>, blockers: string[] = [], majorIssues: string[] = []) =>
    parseEditorialReview(
      JSON.stringify({ dimensions, blockers, majorIssues, notes: '' }),
      'm',
      '2026-10-30T00:00:00.000Z',
    )!;

  it('全部维度 ≥ 3.5 → 通过', () => {
    const result = judgeEditorialReview(
      review({ accuracy: 4, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 }),
    );
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('任一维低于阈值 → 不通过', () => {
    const result = judgeEditorialReview(
      review({ accuracy: 3, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 }),
    );
    expect(result.passed).toBe(false);
    expect(result.issues.join('')).toContain('事实准确');
  });

  it('blocker → 不通过；majorIssues 单独不阻断', () => {
    const blocked = judgeEditorialReview(
      review({ accuracy: 4, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 }, ['编造亲历']),
    );
    expect(blocked.passed).toBe(false);
    expect(blocked.issues.join('')).toContain('编造亲历');

    const warned = judgeEditorialReview(
      review({ accuracy: 4, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 }, [], ['可再具体']),
    );
    expect(warned.passed).toBe(true);
  });

  it('阈值可配', () => {
    const result = judgeEditorialReview(
      review({ accuracy: 4, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 }),
      4.5,
    );
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBe(5);
  });

  it('默认阈值常量是 3.5', () => {
    expect(DEFAULT_REVIEW_THRESHOLD).toBe(3.5);
  });

  it('解析 mechanisms（I-14 跨篇已用机制）', () => {
    const review = parseEditorialReview(
      validJson({ mechanisms: ['沉没成本', '损失厌恶'] }),
      'm',
      '2026-10-30T00:00:00.000Z',
    );
    expect(review?.mechanisms).toEqual(['沉没成本', '损失厌恶']);
  });
});

describe('reviewArticle 风格基线注入', () => {
  const logger: HostLogger = { info() {}, warn() {}, error() {} };
  const profile: WritingProfile = {
    name: '社会现象心理分析',
    industry: '心理学',
    topics: [],
    tone: '',
    voice: '',
    wordCount: '',
    contentStyle: '',
    persona: '',
    blacklistWords: [],
    blacklistTopics: [],
    coverStyle: '',
    styleGuide: '每段 2–2.5 句；每千字数字 ≥25。',
    styleExemplars: [{ title: '用事实开场', excerpt: '这事得先从一个数字说起。', learn: '事实开场' }],
  };

  async function captureUserPrompt(styleProfile?: WritingProfile): Promise<string> {
    let user = '';
    const llm = {
      stream(options: Record<string, unknown>) {
        const messages = options.messages as Array<{ content: Array<{ text: string }> }>;
        user = messages[0]?.content[0]?.text ?? '';
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    } as unknown as PipelineLlm;
    await reviewArticle(
      { llm, provider: 'p', model: 'm', timeoutMs: 1000, logger, nowIso: () => '2026-11-01T00:00:00.000Z' },
      { markdown: '正文', ...(styleProfile ? { profile: styleProfile } : {}) },
    );
    return user;
  }

  it('提示词注入风格指南、范文与禁止复用声明', async () => {
    const user = await captureUserPrompt(profile);
    expect(user).toContain('本账号风格基线');
    expect(user).toContain('每段 2–2.5 句');
    expect(user).toContain('禁止复用');
    expect(user).toContain('每千字数字密度');
  });

  it('没有风格基线时不注入基线块', async () => {
    const user = await captureUserPrompt();
    expect(user).not.toContain('本账号风格基线');
  });
});

describe('reviewArticle 重试与不可用原因', () => {
  const logger: HostLogger = { info() {}, warn() {}, error() {} };
  const validJson = () =>
    JSON.stringify({
      dimensions: { accuracy: 4, viewpoint: 4, usefulness: 4, voice: 4, readability: 4 },
      blockers: [],
      majorIssues: [],
      mechanisms: ['沉没成本'],
      notes: '整体成立',
    });

  const deps = (llm: PipelineLlm) => ({
    llm,
    provider: 'p',
    model: 'm',
    timeoutMs: 1000,
    logger,
    nowIso: () => '2026-11-02T00:00:00.000Z',
  });

  it('首次空文本、第二次有效 → 重试一次成功', async () => {
    let call = 0;
    const llm = {
      stream: () => {
        call += 1;
        return (async function* () {
          if (call === 2) yield { type: 'text-delta', index: 0, text: validJson() };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    } as unknown as PipelineLlm;
    const outcome = await reviewArticle(deps(llm), { markdown: '正文' });
    expect(outcome.review).not.toBeNull();
    expect(outcome.attempts).toBe(2);
  });

  it('持续失败 → 返回 unavailable 原因', async () => {
    const llm = {
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    } as unknown as PipelineLlm;
    const outcome = await reviewArticle(deps(llm), { markdown: '正文' });
    expect(outcome.review).toBeNull();
    expect(outcome.reason).toContain('空文本');
    expect(outcome.attempts).toBe(2);
  });

  it('未配置模型 → attempts=0 且带原因', async () => {
    const llm = { stream: () => (async function* () {})() } as unknown as PipelineLlm;
    const outcome = await reviewArticle({ ...deps(llm), provider: '', model: '' }, { markdown: '正文' });
    expect(outcome.review).toBeNull();
    expect(outcome.reason).toContain('未配置评审模型');
    expect(outcome.attempts).toBe(0);
  });
});
