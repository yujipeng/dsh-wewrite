import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDER_IDS } from '@/shared/image-provider-ids';
import { chooseProviderSize, PROVIDER_IMAGE_SIZES } from '@/host/providers/capabilities';

/**
 * 图片供应商尺寸能力矩阵（I-02）：
 * 目标尺寸被支持时直接请求；否则选宽高比最接近的支持尺寸，由后处理裁剪。
 */

describe('provider 尺寸能力矩阵', () => {
  it('dashscope 直接请求微信目标尺寸', () => {
    expect(chooseProviderSize('dashscope', '2048x871')).toBe('2048x871');
    expect(chooseProviderSize('dashscope', '2048x1152')).toBe('2048x1152');
  });

  it('openai 不支持目标尺寸时选宽高比最接近的 1536x1024', () => {
    expect(chooseProviderSize('openai', '2048x871')).toBe('1536x1024');
    expect(chooseProviderSize('openai', '2048x1152')).toBe('1536x1024');
    expect(chooseProviderSize('azure_openai', '2048x871')).toBe('1536x1024');
  });

  it('所有 provider 的返回尺寸都落在自身支持集合内', () => {
    for (const providerId of IMAGE_PROVIDER_IDS) {
      for (const target of ['2048x871', '2048x1152'] as const) {
        const chosen = chooseProviderSize(providerId, target);
        expect(PROVIDER_IMAGE_SIZES[providerId]).toContain(chosen);
      }
    }
  });
});
