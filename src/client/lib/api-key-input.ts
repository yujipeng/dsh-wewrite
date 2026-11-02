/**
 * API Key 输入体检（设置页「图片供应商」编辑器）。
 *
 * 云厂商的 API Key 不会是 URL、也不含空白；把 Base URL 误粘进 Key 栏会让
 * 供应商在运行期报 AUTH，而回显面仍显示「已配置」。这里在落库前拦住这类
 * 低级错误，并给出可行动提示。
 */

export type ApiKeyInputVerdict =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'url'; readonly message: string }
  | { readonly kind: 'whitespace'; readonly message: string };

/** 任意 scheme 的 URL 形态（http/https 是实际会误填进来的；其余一并拦下更稳）。 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export function inspectApiKeyInput(raw: string): ApiKeyInputVerdict {
  const value = raw.trim();
  if (value.length === 0) return { kind: 'empty' };
  if (URL_PATTERN.test(value)) {
    return { kind: 'url', message: '这看起来是 Base URL，不是 API Key：请填到右侧 Base URL 栏。' };
  }
  if (/\s/.test(value)) {
    return { kind: 'whitespace', message: 'API Key 里不能有空格或换行（可能多粘了内容）。' };
  }
  return { kind: 'ok' };
}
