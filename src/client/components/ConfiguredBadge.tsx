import type { CredentialsDescriptor } from '@/shared/contract';
import { Icon } from './Icon';

/**
 * 凭据状态徽标：描述符缺失（例如新增供应商还没被后端描述）也渲染「未配置」，
 * 避免徽标静默消失、被误读成「没配置上」。
 */
export function ConfiguredBadge({ descriptor }: { descriptor: CredentialsDescriptor | undefined }) {
  if (descriptor?.configured) {
    return (
      <span className="ww-badge ww-badge--ok">
        <Icon name="check" size={16} /> 已配置
      </span>
    );
  }
  return (
    <span className="ww-badge">
      <Icon name="circle-alert" size={16} /> 未配置
    </span>
  );
}
