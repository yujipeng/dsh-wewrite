/**
 * 图片供应商尺寸能力矩阵（I-02）：
 * 只声明各家实际可请求的尺寸；不支持目标尺寸时选择宽高比最接近的支持尺寸，
 * 再由 images 后处理裁剪到微信目标比例。
 *
 * 保守原则：未确认的 provider 只使用项目原有的 5 个标准尺寸，避免引入 API 400。
 */

import type { ImageProviderId } from '../../shared/image-provider-ids';
import type { ImageSize } from './types';

const STANDARD_SIZES: readonly ImageSize[] = [
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1344x768',
  '768x1344',
];

/** OpenAI / Azure gpt-image 系列只接受这三种尺寸。 */
const OPENAI_SIZES: readonly ImageSize[] = ['1024x1024', '1536x1024', '1024x1536'];

export const PROVIDER_IMAGE_SIZES: Readonly<Record<ImageProviderId, readonly ImageSize[]>> = {
  openai: OPENAI_SIZES,
  azure_openai: OPENAI_SIZES,
  // dashscope 万相：实测 1024×1024 / 1280×720 可提交；1280×720 覆盖正文 16:9，
  // 封面 2.35:1 由后处理裁剪（不直接请求 2048 大尺寸，避免限流/尺寸限制）。
  dashscope: ['1024x1024', '1280x720'],
  doubao: STANDARD_SIZES,
  jimeng: STANDARD_SIZES,
  minimax: STANDARD_SIZES,
  gemini: STANDARD_SIZES,
  openrouter: STANDARD_SIZES,
  replicate: STANDARD_SIZES,
};

export function imageRatio(size: ImageSize): number {
  const [width, height] = size.split('x').map((part) => Number(part));
  return width > 0 && height > 0 ? width / height : 1;
}

/** 目标尺寸不在支持集合时，按宽高比（log 距离）选最接近的可请求尺寸。 */
export function chooseProviderSize(providerId: ImageProviderId, target: ImageSize): ImageSize {
  const supported = PROVIDER_IMAGE_SIZES[providerId] ?? STANDARD_SIZES;
  if (supported.includes(target)) return target;
  const targetRatio = imageRatio(target);
  let best = supported[0] ?? '1024x1024';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const size of supported) {
    const distance = Math.abs(Math.log(imageRatio(size) / targetRatio));
    if (distance < bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
}
