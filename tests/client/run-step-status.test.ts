import { describe, expect, it } from 'vitest';
import { stepStatusText } from '@/client/lib/run-step-status';

describe('stepStatusText（任务详情）', () => {
  it('images 未请求配图 → 已跳过，而不是成功', () => {
    expect(
      stepStatusText({ name: 'images', status: 'succeeded', metrics: { skipped: 'imageCount=0' } }),
    ).toBe('已跳过（未请求配图）');
  });

  it('images 成本超限 → 已跳过（预算）', () => {
    expect(
      stepStatusText({ name: 'images', status: 'succeeded', metrics: { skipped: 'cost-limit' } }),
    ).toBe('已跳过（超出配图预算）');
  });

  it('images 正常成功 → succeeded', () => {
    expect(
      stepStatusText({ name: 'images', status: 'succeeded', metrics: { bodyImageCount: 1 } }),
    ).toBe('succeeded');
  });

  it('非 images 步骤不读取 skipped', () => {
    expect(
      stepStatusText({ name: 'render', status: 'succeeded', metrics: { skipped: 'imageCount=0' } }),
    ).toBe('succeeded');
  });
});
