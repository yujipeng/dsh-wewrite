// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfiguredBadge } from '@/client/components/ConfiguredBadge';

/**
 * 图片供应商凭据徽标：描述符缺失时必须显示「未配置」，不能静默消失。
 * 背景：qwen_image 曾因后端描述表漏项而没有描述符，界面看起来「没配置上」。
 */

describe('ConfiguredBadge', () => {
  it('描述符缺失 → 回退「未配置」', () => {
    render(<ConfiguredBadge descriptor={undefined} />);
    expect(screen.getByText('未配置')).toBeTruthy();
  });

  it('configured=false → 「未配置」', () => {
    render(<ConfiguredBadge descriptor={{ configured: false, writable: true }} />);
    expect(screen.getByText('未配置')).toBeTruthy();
  });

  it('configured=true → 「已配置」', () => {
    render(<ConfiguredBadge descriptor={{ configured: true, writable: true }} />);
    expect(screen.getByText('已配置')).toBeTruthy();
  });
});
