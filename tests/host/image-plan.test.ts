import { describe, expect, it } from 'vitest';
import {
  IMAGE_NEGATIVE_PROMPT,
  buildFallbackImagePlan,
  composeImagePrompt,
  parseImagePlan,
  validateImagePlan,
} from '@/host/images/plan';

const plan = {
  visualSystem: '深色纯色背景，单光源，负空间。',
  coverPrompt: '封面：一张成本表。',
  bodyPrompts: ['正文图一：账单结构。', '正文图二：保本线。'],
};

describe('I-18 配图提示词清单', () => {
  it('合法 JSON 通过结构校验', () => {
    expect(validateImagePlan(plan, 2)).toEqual({
      visualSystem: plan.visualSystem,
      coverPrompt: plan.coverPrompt,
      bodyPrompts: plan.bodyPrompts,
    });
  });

  it('缺视觉系统 / 封面 prompt → null', () => {
    expect(validateImagePlan({ ...plan, visualSystem: '' }, 2)).toBeNull();
    expect(validateImagePlan({ ...plan, coverPrompt: undefined }, 2)).toBeNull();
  });

  it('正文 prompt 数量不足 → null', () => {
    expect(validateImagePlan({ ...plan, bodyPrompts: ['只有一张'] }, 2)).toBeNull();
  });

  it('兼容 ```json 围栏', () => {
    const parsed = parseImagePlan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, 2);
    expect(parsed?.coverPrompt).toContain('成本表');
  });

  it('非 JSON 返回 null（调用方降级）', () => {
    expect(parseImagePlan('不是 JSON', 2)).toBeNull();
  });

  it('compose 复写视觉系统与禁用元素', () => {
    const prompt = composeImagePrompt(plan as never, 'cover');
    expect(prompt).toContain(plan.visualSystem);
    expect(prompt).toContain(plan.coverPrompt);
    expect(prompt).toContain(IMAGE_NEGATIVE_PROMPT);
  });

  it('正文 prompt 按 index 取对应条目', () => {
    const prompt = composeImagePrompt(plan as never, 'body', 1);
    expect(prompt).toContain('正文图二');
  });

  it('固定模板降级：封面 + count 张正文，且含视觉系统/禁用词', () => {
    const fallback = buildFallbackImagePlan(2);
    expect(fallback.bodyPrompts).toHaveLength(2);
    const prompt = composeImagePrompt(fallback, 'body', 0);
    expect(prompt).toContain(fallback.visualSystem);
    expect(prompt).toContain(IMAGE_NEGATIVE_PROMPT);
  });
});
