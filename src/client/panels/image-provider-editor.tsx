import { useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import type { CredentialsDescriptor, ImageProviderConfig } from '@/shared/contract';
import { DEFAULT_PROVIDER_MODELS } from '@/shared/image-provider-ids';
import type { ImageProviderId } from '@/shared/image-provider-ids';
import { inspectApiKeyInput } from '../lib/api-key-input';
import { SaveState } from './settings-sections';

/**
 * 单家图片供应商的编辑行（API Key / 模型 / Base URL）。
 *
 * 草稿由父组件按 providerId 重新挂载（key）来重置——API Key 永不回显。
 * 保存前先做输入体检：把 Base URL 误填进 Key 栏的情况挡在落库之前。
 */
export interface ImageProviderDraft {
  readonly key: string;
  readonly model: string;
  readonly baseUrl: string;
}

export interface ImageProviderEditorProps {
  readonly item: ImageProviderConfig;
  readonly descriptor: CredentialsDescriptor | undefined;
  readonly onSave: (draft: ImageProviderDraft) => Promise<void>;
  readonly onClear: () => Promise<void>;
}

export function ImageProviderEditor({ item, descriptor, onSave, onClear }: ImageProviderEditorProps) {
  const providerId = item.providerId as ImageProviderId;
  const [key, setKey] = useState('');
  const [model, setModel] = useState(item.model ?? DEFAULT_PROVIDER_MODELS[providerId] ?? '');
  const [baseUrl, setBaseUrl] = useState(item.baseUrl ?? '');
  const [keyError, setKeyError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function submit() {
    const verdict = inspectApiKeyInput(key);
    if (verdict.kind === 'url' || verdict.kind === 'whitespace') {
      setKeyError(verdict.message);
      setSaveState('idle');
      return;
    }
    setKeyError('');
    setSaveState('saving');
    try {
      await onSave({ key: key.trim(), model: model.trim(), baseUrl: baseUrl.trim() });
      setKey('');
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  async function clear() {
    setKeyError('');
    setSaveState('saving');
    try {
      await onClear();
      setKey('');
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  return (
    <div className="ww-provider__editor">
      <div className="ww-field-row">
        <div className="ww-field">
          <span className="ww-field__label">
            API Key <span className="ww-field__hint">仅存本机（credentials 存储，不回显）</span>
          </span>
          <Input
            type="password"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setKeyError('');
            }}
            placeholder={descriptor?.configured ? '已配置——输入新值可覆盖' : '输入 API Key'}
            aria-label={`${item.providerId} API Key`}
          />
          {keyError ? (
            <span className="ww-field__hint ww-field__hint--error" role="alert">
              {keyError}
            </span>
          ) : null}
        </div>
        <div className="ww-field">
          <span className="ww-field__label">模型</span>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={DEFAULT_PROVIDER_MODELS[providerId] ?? '默认模型'}
            aria-label={`${item.providerId} 模型`}
          />
        </div>
        <div className="ww-field">
          <span className="ww-field__label">
            Base URL <span className="ww-field__hint">可选</span>
          </span>
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="默认官方地址"
            aria-label={`${item.providerId} Base URL`}
          />
        </div>
      </div>
      <div className="ww-settings__row">
        <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void submit()} disabled={saveState === 'saving'}>
          保存
        </Button>
        {descriptor?.configured ? (
          <Button variant="outline" size="sm" onClick={() => void clear()} disabled={saveState === 'saving'}>
            清除已存 Key
          </Button>
        ) : null}
        <SaveState state={saveState} />
      </div>
    </div>
  );
}
