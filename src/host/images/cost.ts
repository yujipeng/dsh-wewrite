/**
 * I-20 配图成本预估与上限：纯函数，设置未配置时不产生任何限制。
 * 成本按「封面 1 张 + 正文 count 张」估算。
 */

export interface ImageCostSettings {
  readonly imageCostPerImage?: number;
  readonly maxImageCost?: number;
}

export interface ImageBudget {
  readonly skip: boolean;
  readonly estimated: number;
  readonly reason?: string;
}

export function estimateImageCost(count: number, costPerImage?: number): number {
  if (!costPerImage || costPerImage <= 0) return 0;
  return Math.max(0, count + 1) * costPerImage;
}

export function shouldSkipImages(count: number, settings: ImageCostSettings): ImageBudget {
  const estimated = estimateImageCost(count, settings.imageCostPerImage);
  const max = settings.maxImageCost;
  if (!max || max <= 0) return { skip: false, estimated };
  if (estimated > max) {
    return {
      skip: true,
      estimated,
      reason: `配图预估成本 ${estimated.toFixed(2)} 超过上限 ${max.toFixed(2)}`,
    };
  }
  return { skip: false, estimated };
}
