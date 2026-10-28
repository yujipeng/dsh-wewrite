import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ImageProviderConfig } from '@/shared/contract';
import { CREDENTIAL_REFS, DEFAULT_PROVIDER_MODELS, IMAGE_PROVIDER_IDS } from '@/shared/image-provider-ids';
import type { ImageProviderId } from '@/shared/image-provider-ids';
import { CodeChip } from '../components/bits';
import { Icon } from '../components/Icon';
import { ConfiguredBadge, MenuTrigger, SaveState, type SectionProps } from './settings-sections';

/**
 * 模型服务 + 图片供应商两组设置内容（从 settings-sections 拆分以守 300 行纪律）。
 */
export function LlmSection({ config, rpc, onSaved }: SectionProps) {
  const [provider, setProvider] = useState(config.settings.llmDefault.provider ?? '');
  const [model, setModel] = useState(config.settings.llmDefault.model ?? '');
  const [options, setOptions] = useState<{ id: string; models: string[] }[] | undefined>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    rpc
      .call<{ providers: { id: string; models: string[] }[] }>('llm/options', {})
      .then((result) => setOptions(result.providers))
      .catch(() => setOptions(undefined));
  }, [rpc]);

  const providerEntries: MenuEntry[] = (options ?? []).map((item) => ({ id: item.id, label: item.id }));
  const modelEntries: MenuEntry[] =
    (options?.find((item) => item.id === provider)?.models ?? (model ? [model] : [])).map((name) => ({ id: name, label: name }));

  async function save() {
    setSaveState('saving');
    try {
      await rpc.call('config/set', {
        llmDefault: { ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
      });
      setSaveState('saved');
      await onSaved();
    } catch {
      setSaveState('error');
    }
  }

  return (
    <div className="ww-settings__section">
      <h3 className="ww-settings__h">模型服务（复用 DSH 宿主已配供应商）</h3>
      <div className="ww-field-row">
        <div className="ww-field">
          <span className="ww-field__label">供应商</span>
          <Menu
            open={providerOpen}
            anchor={<MenuTrigger label={provider || '选择供应商'} open={providerOpen} onToggle={() => setProviderOpen((v) => !v)} />}
            items={providerEntries}
            selectedId={provider || undefined}
            onSelect={(id) => {
              setProvider(id);
              const first = options?.find((item) => item.id === id)?.models[0];
              if (first) setModel(first);
              setProviderOpen(false);
            }}
            onClose={() => setProviderOpen(false)}
          />
        </div>
        <div className="ww-field">
          <span className="ww-field__label">模型</span>
          <Menu
            open={modelOpen}
            anchor={<MenuTrigger label={model || '选择模型'} open={modelOpen} onToggle={() => setModelOpen((v) => !v)} mono />}
            items={modelEntries}
            selectedId={model || undefined}
            onSelect={(id) => {
              setModel(id);
              setModelOpen(false);
            }}
            onClose={() => setModelOpen(false)}
          />
        </div>
      </div>
      <div className="ww-settings__row">
        <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void save()} disabled={saveState === 'saving'}>
          保存
        </Button>
        <SaveState state={saveState} />
      </div>
    </div>
  );
}

/** 图片供应商：fallback 链排序（上下移）+ 供应商增删 + 每家 model/凭据位。 */
export function ImagesSection({ config, rpc, onSaved }: SectionProps) {
  const [chain, setChain] = useState<ImageProviderConfig[]>(config.imageProviders);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<ImageProviderId | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [providerSaveState, setProviderSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const remaining = useMemo(
    () => IMAGE_PROVIDER_IDS.filter((id) => !chain.some((item) => item.providerId === id)),
    [chain],
  );

  async function save(next: ImageProviderConfig[]) {
    setSaveState('saving');
    try {
      await rpc.call('config/set', { imageProviders: next });
      setChain(next);
      setSaveState('saved');
      await onSaved();
    } catch {
      setSaveState('error');
    }
  }

  function move(index: number, delta: -1 | 1) {
    const next = [...chain];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void save(next);
  }

  /** 展开/收起单家供应商的配置行；每次打开重置草稿（API Key 不回显）。 */
  function openEditor(item: ImageProviderConfig) {
    const providerId = item.providerId as ImageProviderId;
    setEditingId((current) => (current === providerId ? null : providerId));
    setDraftKey('');
    setDraftModel(item.model ?? DEFAULT_PROVIDER_MODELS[providerId] ?? '');
    setDraftBaseUrl(item.baseUrl ?? '');
    setProviderSaveState('idle');
  }

  /** 保存单家：API Key 走 credentials/set（空值不覆盖），model/baseUrl 走 config/set。 */
  async function saveProvider(item: ImageProviderConfig) {
    setProviderSaveState('saving');
    try {
      const key = draftKey.trim();
      if (key) await rpc.call('credentials/set', { ref: item.credentialRef, value: key });
      const model = draftModel.trim();
      const baseUrl = draftBaseUrl.trim();
      const next = chain.map((entry) => {
        if (entry.providerId !== item.providerId) return entry;
        return {
          providerId: entry.providerId,
          credentialRef: entry.credentialRef,
          ...(model ? { model } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        };
      });
      await rpc.call('config/set', { imageProviders: next });
      setChain(next);
      setDraftKey('');
      setProviderSaveState('saved');
      await onSaved();
    } catch {
      setProviderSaveState('error');
    }
  }

  return (
    <div className="ww-settings__section">
      <h3 className="ww-settings__h">图片供应商 fallback 链（gpt-image-2 第一优先）</h3>
      <ol className="ww-provider-chain">
        {chain.map((item, index) => (
          <li key={item.providerId} className={editingId === item.providerId ? 'ww-provider ww-provider--editing' : 'ww-provider'}>
            <span className="ww-provider__order">{index + 1}</span>
            <CodeChip>{item.providerId}</CodeChip>
            <span className="ww-provider__model">{item.model ?? DEFAULT_PROVIDER_MODELS[item.providerId as ImageProviderId] ?? '默认模型'}</span>
            <ConfiguredBadge descriptor={config.credentials[item.credentialRef]} />
            <span className="ww-provider__ops">
              <button type="button" className="ww-icon-btn" aria-label={`配置 ${item.providerId}`} aria-expanded={editingId === item.providerId} onClick={() => openEditor(item)}>
                <Icon name="key-round" size={16} />
              </button>
              <button type="button" className="ww-icon-btn" aria-label={`上移 ${item.providerId}`} onClick={() => move(index, -1)} disabled={index === 0}>
                <Icon name="chevron-down" size={16} className="ww-rotate-180" />
              </button>
              <button type="button" className="ww-icon-btn" aria-label={`下移 ${item.providerId}`} onClick={() => move(index, 1)} disabled={index === chain.length - 1}>
                <Icon name="chevron-down" size={16} />
              </button>
              <button type="button" className="ww-icon-btn" aria-label={`移除 ${item.providerId}`} onClick={() => void save(chain.filter((entry) => entry.providerId !== item.providerId))}>
                <Icon name="x" size={16} />
              </button>
            </span>
            {editingId === item.providerId ? (
              <div className="ww-provider__editor">
                <div className="ww-field-row">
                  <div className="ww-field">
                    <span className="ww-field__label">API Key <span className="ww-field__hint">仅存本机（credentials 存储，不回显）</span></span>
                    <Input
                      type="password"
                      value={draftKey}
                      onChange={(event) => setDraftKey(event.target.value)}
                      placeholder={config.credentials[item.credentialRef]?.configured ? '已配置——输入新值可覆盖' : '输入 API Key'}
                      aria-label={`${item.providerId} API Key`}
                    />
                  </div>
                  <div className="ww-field">
                    <span className="ww-field__label">模型</span>
                    <Input
                      value={draftModel}
                      onChange={(event) => setDraftModel(event.target.value)}
                      placeholder={DEFAULT_PROVIDER_MODELS[item.providerId as ImageProviderId] ?? '默认模型'}
                      aria-label={`${item.providerId} 模型`}
                    />
                  </div>
                  <div className="ww-field">
                    <span className="ww-field__label">Base URL <span className="ww-field__hint">可选</span></span>
                    <Input
                      value={draftBaseUrl}
                      onChange={(event) => setDraftBaseUrl(event.target.value)}
                      placeholder="默认官方地址"
                      aria-label={`${item.providerId} Base URL`}
                    />
                  </div>
                </div>
                <div className="ww-settings__row">
                  <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void saveProvider(item)} disabled={providerSaveState === 'saving'}>
                    保存
                  </Button>
                  <SaveState state={providerSaveState} />
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <Menu
        open={addOpen}
        anchor={
          <Button variant="outline" size="sm" icon={<Icon name="image-plus" size={16} />} onClick={() => setAddOpen((v) => !v)}>
            添加供应商
          </Button>
        }
        items={remaining.map((id) => ({ id, label: id }))}
        onSelect={(id) => {
          setAddOpen(false);
          const providerId = id as ImageProviderId;
          void save([...chain, { providerId, credentialRef: CREDENTIAL_REFS.image(providerId) }]);
        }}
        onClose={() => setAddOpen(false)}
      />
      <div className="ww-settings__row">
        <SaveState state={saveState} />
        <span className="ww-field__hint">生成失败按链降级，全失败可无图推进（AC-9）。</span>
      </div>
    </div>
  );
}

