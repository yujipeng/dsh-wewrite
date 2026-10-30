import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPIC_SCORE_WEIGHTS,
  scoreTopic,
  type TopicScoreInput,
} from '@/host/pipeline/steps/topic-score';

const input = (overrides: Partial<TopicScoreInput> = {}): TopicScoreInput => ({
  title: '小城咖啡店的账本',
  heat: 8,
  relevance: 8,
  value: 8,
  ...overrides,
});

describe('scoreTopic（I-07 确定性打分）', () => {
  it.each([
    ['三项满分 → 10', { heat: 10, relevance: 10, value: 10 }, 10],
    ['三项全零 → 0', { heat: 0, relevance: 0, value: 0 }, 0],
    ['5/10/5 → 7', { heat: 5, relevance: 10, value: 5 }, 7],
    ['8/6/4 → 6', { heat: 8, relevance: 6, value: 4 }, 6],
    ['越界与 NaN 被 clamp', { heat: 99, relevance: -5, value: Number.NaN }, 3],
    ['小数四舍五入到一位', { heat: 7, relevance: 8, value: 9 }, 8],
  ])('%s', (_name, scores, expected) => {
    expect(scoreTopic(input(scores)).score).toBe(expected);
  });

  it('无历史：不加不减', () => {
    expect(scoreTopic(input(), { titles: [], keywords: [] })).toEqual({
      score: 8,
      duplicateHits: [],
    });
  });

  it('历史关键词命中：扣 3 分并给出 historyMark', () => {
    const result = scoreTopic(input({ title: '小城咖啡店保本账本' }), { keywords: ['咖啡店'] });
    expect(result.score).toBe(5);
    expect(result.duplicateHits).toEqual(['咖啡店']);
    expect(result.historyMark).toContain('近 7 天已写');
  });

  it('近 7 天标题高度相似：判为同题并扣分', () => {
    const result = scoreTopic(input({ title: '小城咖啡店保本账本' }), {
      titles: ['小城咖啡店保本账本：一天 46 杯'],
    });
    expect(result.score).toBe(5);
    expect(result.duplicateHits).toHaveLength(1);
  });

  it('不相似的历史标题：不扣分', () => {
    const result = scoreTopic(input({ title: '小城咖啡店保本账本' }), {
      titles: ['美联储再次加息'],
    });
    expect(result.score).toBe(8);
    expect(result.historyMark).toBeUndefined();
  });

  it('多个历史命中：只扣一次', () => {
    const result = scoreTopic(input({ title: '小城咖啡店保本账本' }), {
      titles: ['小城咖啡店保本账本', '小城咖啡店保本账本：一天 46 杯'],
      keywords: ['咖啡店'],
    });
    expect(result.score).toBe(5);
    expect(result.duplicateHits.length).toBe(3);
  });

  it('扣分后低于 0：clamp 到 0', () => {
    const result = scoreTopic(input({ heat: 1, relevance: 1, value: 1, title: '咖啡店账本' }), {
      keywords: ['咖啡店'],
    });
    expect(result.score).toBe(0);
  });

  it('短于 2 字的关键词忽略', () => {
    const result = scoreTopic(input({ title: '咖啡店账本' }), { keywords: ['店'] });
    expect(result.score).toBe(8);
    expect(result.duplicateHits).toEqual([]);
  });

  it('标点/大小写归一后仍能命中', () => {
    const result = scoreTopic(input({ title: 'AI 引擎！' }), { keywords: ['ai引擎'] });
    expect(result.score).toBe(5);
    expect(result.duplicateHits).toEqual(['ai引擎']);
  });

  it('自定义权重：去重惩罚可配', () => {
    const result = scoreTopic(
      input({ title: '咖啡店账本', heat: 10, relevance: 10, value: 10 }),
      { keywords: ['咖啡店'] },
      { ...DEFAULT_TOPIC_SCORE_WEIGHTS, duplicatePenalty: 5 },
    );
    expect(result.score).toBe(5);
  });

  it('并列分：不同标题返回相同分数', () => {
    const left = scoreTopic(input({ title: '标题甲', heat: 6, relevance: 6, value: 6 }));
    const right = scoreTopic(input({ title: '标题乙', heat: 6, relevance: 6, value: 6 }));
    expect(left.score).toBe(right.score);
    expect(left.score).toBe(6);
  });
});
