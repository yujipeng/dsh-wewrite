import { describe, expect, it } from 'vitest';
import { runQualityGates } from '@/host/pipeline/steps/gates';
import { draftUserPrompt } from '@/host/pipeline/llm';
import { LaunchBriefSchema } from '@/shared/schema-base';

const body = [
  '## 一、账本',
  '房租 6000 元，一天卖 46 杯，具体细节 2026 年。'.repeat(30),
].join('\n\n');

describe('I-22 claims / fact-source 门禁', () => {
  it('LaunchBriefSchema 接受 claims 结构', () => {
    const parsed = LaunchBriefSchema.safeParse({
      claims: [
        { id: 'c1', text: '房租 6000', type: 'fact', sourceIds: ['https://x.example/a'] },
        { id: 'c2', text: '我觉得贵', type: 'opinion' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('fact 缺 sourceIds → 门禁失败并给出可读 issue', () => {
    const { report } = runQualityGates({
      markdown: body,
      claims: [{ id: 'c1', text: '房租 6000', type: 'fact' }],
    });
    expect(report.claims?.passed).toBe(false);
    expect(report.claims?.issues.join('')).toContain('缺少来源');
  });

  it('opinion 无来源 → 通过', () => {
    const { report } = runQualityGates({
      markdown: body,
      claims: [{ id: 'c1', text: '我觉得贵', type: 'opinion' }],
    });
    expect(report.claims?.passed).toBe(true);
  });

  it('fact 来源在 brief.sources 中 → 通过', () => {
    const { report } = runQualityGates({
      markdown: body,
      sources: ['https://x.example/a'],
      claims: [{ id: 'c1', text: '房租 6000', type: 'fact', sourceIds: ['https://x.example/a'] }],
    });
    expect(report.claims?.passed).toBe(true);
  });

  it('fact 引用未提供的来源 → 失败', () => {
    const { report } = runQualityGates({
      markdown: body,
      sources: ['https://x.example/a'],
      claims: [{ id: 'c1', text: '房租 6000', type: 'fact', sourceIds: ['https://x.example/other'] }],
    });
    expect(report.claims?.passed).toBe(false);
    expect(report.claims?.issues.join('')).toContain('未提供的来源');
  });

  it('claims 注入成稿提示词（fact 带来源 / opinion 不带）', () => {
    const prompt = draftUserPrompt('咖啡店账本', '', {
      claims: [
        { id: 'c1', text: '房租 6000', type: 'fact', sourceIds: ['https://x.example/a'] },
        { id: 'c2', text: '我觉得贵', type: 'opinion' },
      ],
    });
    expect(prompt).toContain('事实主张');
    expect(prompt).toContain('[fact] 房租 6000');
    expect(prompt).toContain('https://x.example/a');
    expect(prompt).toContain('[opinion] 我觉得贵');
  });
});
