import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDER_IDS } from '@/shared/image-provider-ids';
import { chooseProviderSize, PROVIDER_IMAGE_SIZES } from '@/host/providers/capabilities';

/**
 * 图片供应商尺寸能力矩阵（I-02）：
 * 目标尺寸被支持时直接请求；否则选宽高比最接近的支持尺寸，由后处理裁剪。
 */

describe('provider 尺寸能力矩阵', () => {
  it('dashscope 用 1280x720 覆盖正文，封面同尺寸裁剪', () => {
    expect(chooseProviderSize('dashscope', '1280x545')).toBe('1280x720');
    expect(chooseProviderSize('dashscope', '1280x720')).toBe('1280x720');
  });

  it('openai 不支持目标尺寸时选宽高比最接近的 1536x1024', () => {
    expect(chooseProviderSize('openai', '1280x545')).toBe('1536x1024');
    expect(chooseProviderSize('openai', '1280x720')).toBe('1536x1024');
    expect(chooseProviderSize('azure_openai', '1280x545')).toBe('1536x1024');
  });

  it('所有 provider 的返回尺寸都落在自身支持集合内', () => {
    for (const providerId of IMAGE_PROVIDER_IDS) {
      for (const target of ['1280x545', '1280x720'] as const) {
        const chosen = chooseProviderSize(providerId, target);
        expect(PROVIDER_IMAGE_SIZES[providerId]).toContain(chosen);
      }
    }
  });
});
