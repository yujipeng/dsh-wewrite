import { describe, expect, it } from 'vitest';
import { auditFactConsistency } from '@/host/pipeline/steps/gates';

/**
 * 事实一致性门禁（v0.5 来源入管线）：
 * 成稿里的年份与引号引语必须能在来源原文中找到——防止把 2024 年旧闻
 * 套进 2026 年的新热搜（本次「罗技」跑题问题的直接防线）。
 */

const SOURCE = [
  {
    url: 'https://news.example.test/a',
    title: '罗技小狗表情包广告引争议',
    text: '2026 年 11 月 2 日，罗技 G 影音旗舰店官方账号发布促销视频。客服回应称：“小狗只是表情包，不是侮辱消费者。”',
  },
];

describe('auditFactConsistency', () => {
  it('年份与引语都能在来源原文中找到 → 通过', () => {
    const markdown = '2026 年 11 月 2 日，罗技客服回应称“小狗只是表情包，不是侮辱消费者”。';
    expect(auditFactConsistency(markdown, SOURCE)).toEqual({ passed: true, issues: [] });
  });

  it('成稿出现来源没有的年份 → 阻断（旧闻套新题）', () => {
    const markdown = '2024 年 7 月，罗技 CEO 在播客里谈到订阅制鼠标。';
    const result = auditFactConsistency(markdown, SOURCE);
    expect(result.passed).toBe(false);
    expect(result.issues.join('；')).toContain('2024');
  });

  it('成稿引语不在来源原文中 → 阻断（疑似虚构引语）', () => {
    const markdown = '罗技回应：“我们绝不会推出订阅制的计划，请用户放心。”';
    const result = auditFactConsistency(markdown, SOURCE);
    expect(result.passed).toBe(false);
    expect(result.issues.join('；')).toContain('引语');
  });

  it('来源完全没提年份时跳过年份规则（短讯场景）', () => {
    const source = [{ url: 'https://news.example.test/b', text: '罗技发布了一条促销视频，客服表示会调查核实。' }];
    expect(auditFactConsistency('2024 年，罗技回应了这条视频。', source).passed).toBe(true);
  });

  it('没有来源原文时门禁不启用（不误伤纯主题写作）', () => {
    expect(auditFactConsistency('2024 年的事情。', []).passed).toBe(true);
  });
});
