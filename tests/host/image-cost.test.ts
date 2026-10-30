import { describe, expect, it } from 'vitest';
import { estimateImageCost, shouldSkipImages } from '@/host/images/cost';

describe('I-20 配图成本预估与上限', () => {
  it('未配置单价 → 0，且不产生限制', () => {
    expect(estimateImageCost(2)).toBe(0);
    expect(shouldSkipImages(2, {})).toEqual({ skip: false, estimated: 0 });
  });

  it('按「封面 + 正文张数」估算', () => {
    expect(estimateImageCost(2, 0.5)).toBe(1.5);
    expect(estimateImageCost(0, 1)).toBe(1);
  });

  it('未配置上限 → 只估算不跳过', () => {
    expect(shouldSkipImages(2, { imageCostPerImage: 1 })).toEqual({ skip: false, estimated: 3 });
  });

  it('超过上限 → 跳过并给出原因', () => {
    const result = shouldSkipImages(2, { imageCostPerImage: 0.5, maxImageCost: 1 });
    expect(result.skip).toBe(true);
    expect(result.estimated).toBe(1.5);
    expect(result.reason).toContain('超过上限');
  });

  it('恰好等于上限 → 不跳过', () => {
    expect(shouldSkipImages(1, { imageCostPerImage: 0.5, maxImageCost: 1 }).skip).toBe(false);
  });

  it('上限为 0 → 视为未配置', () => {
    expect(shouldSkipImages(5, { imageCostPerImage: 1, maxImageCost: 0 }).skip).toBe(false);
  });
});
