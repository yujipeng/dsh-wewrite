import { describe, expect, it } from 'vitest';
import { inspectApiKeyInput } from '@/client/lib/api-key-input';

/**
 * API Key 输入体检：把「Base URL 误填进 Key 栏」挡在落库之前。
 * 本机实测过的真实误填形态：https://api.aicodewith.ai/v1。
 */

describe('inspectApiKeyInput', () => {
  it('空值或纯空白 → empty（不覆盖已存 key）', () => {
    expect(inspectApiKeyInput('')).toEqual({ kind: 'empty' });
    expect(inspectApiKeyInput('   \n ')).toEqual({ kind: 'empty' });
  });

  it('URL 形态 → url，并提示填到 Base URL 栏', () => {
    for (const value of ['https://api.aicodewith.ai/v1', 'http://localhost:3000', '  https://x.dev/v1  ']) {
      const verdict = inspectApiKeyInput(value);
      expect(verdict.kind).toBe('url');
      if (verdict.kind === 'url') expect(verdict.message).toContain('Base URL');
    }
  });

  it('含内部空白 → whitespace（提示多粘了内容）', () => {
    const verdict = inspectApiKeyInput('sk-abc def');
    expect(verdict.kind).toBe('whitespace');
    if (verdict.kind === 'whitespace') expect(verdict.message).toContain('空格');
  });

  it('正常 key（允许前后空白）→ ok', () => {
    expect(inspectApiKeyInput('sk-ws-H.YMDXIRD.FPBv')).toEqual({ kind: 'ok' });
    expect(inspectApiKeyInput('  sk-1234567890  ')).toEqual({ kind: 'ok' });
  });
});
