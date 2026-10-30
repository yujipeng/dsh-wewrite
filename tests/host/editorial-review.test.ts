import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_THRESHOLD,
  judgeEditorialReview,
  parseEditorialReview,
} from '@/host/pipeline/steps/editorial-review';

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
