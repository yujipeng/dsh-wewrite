import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ImageProviderConfig } from '@/shared/contract';
import { CREDENTIAL_REFS, DEFAULT_PROVIDER_MODELS, IMAGE_PROVIDER_IDS } from '@/shared/image-provider-ids';
import {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_LABELS,
  searchCredentialRef,
  type SearchFreshness,
  type SearchProviderId,
} from '@/shared/search-provider-ids';
import type { ImageProviderId } from '@/shared/image-provider-ids';
import { CodeChip } from '../components/bits';
import { Icon } from '../components/Icon';
import { ImageProviderEditor, type ImageProviderDraft } from './image-provider-editor';
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

  // 设置页可能在别处（另一个窗口 / 旧快照）被改过：链始终跟随服务端真值，
  // 避免用陈旧 chain 覆盖掉刚添加的供应商。
  useEffect(() => {
    setChain(config.imageProviders);
  }, [config.imageProviders]);

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

  function toggleEditor(item: ImageProviderConfig) {
    setEditingId((current) => (current === item.providerId ? null : item.providerId));
  }

  /** 保存单家：API Key 走 credentials/set（空值不覆盖），model/baseUrl 走 config/set。 */
  async function saveProvider(item: ImageProviderConfig, draft: ImageProviderDraft): Promise<void> {
    if (draft.key) await rpc.call('credentials/set', { ref: item.credentialRef, value: draft.key });
    const next = chain.map((entry) => {
      if (entry.providerId !== item.providerId) return entry;
      return {
        providerId: entry.providerId,
        credentialRef: entry.credentialRef,
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
      };
    });
    await rpc.call('config/set', { imageProviders: next });
    setChain(next);
    await onSaved();
  }

  /** 清除误存/过期的 Key：只走 credentials/unset，不动链配置。 */
  async function clearProvider(item: ImageProviderConfig): Promise<void> {
    await rpc.call('credentials/unset', { ref: item.credentialRef });
    await onSaved();
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
              <button type="button" className="ww-icon-btn" aria-label={`配置 ${item.providerId}`} aria-expanded={editingId === item.providerId} onClick={() => toggleEditor(item)}>
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
              <ImageProviderEditor
                key={item.providerId}
                item={item}
                descriptor={config.credentials[item.credentialRef]}
                onSave={(draft) => saveProvider(item, draft)}
                onClear={() => clearProvider(item)}
              />
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

/**
 * 热点原文搜索 API：多供应商 fallback 链（类似图片供应商）。
 * 按链顺序依次尝试，某家失败/无结果自动换下一家；全部失败回退搜狗/Bing 抓取。
 */
export function SearchSection({ config, rpc, onSaved }: SectionProps) {
  const chain = config.settings.searchProviders;
  const [freshness, setFreshness] = useState<SearchFreshness>(config.settings.searchFreshness ?? 'oneWeek');
  const [editingId, setEditingId] = useState<SearchProviderId | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setFreshness(config.settings.searchFreshness ?? 'oneWeek');
  }, [config.settings.searchFreshness]);

  const remaining = SEARCH_PROVIDER_IDS.filter((id) => !chain.some((entry) => entry.providerId === id));

  async function run(save: () => Promise<void>) {
    setSaveState('saving');
    setSaveError(undefined);
    try {
      await save();
      setSaveState('saved');
      await onSaved();
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  function persist(nextChain: typeof chain, nextFreshness: SearchFreshness = freshness) {
    return run(async () => {
      await rpc.call('config/set', { searchProviders: nextChain, searchFreshness: nextFreshness });
    });
  }

  function saveKey(credentialRef: string) {
    const value = (keyDrafts[credentialRef] ?? '').trim();
    if (!value) return;
    return run(async () => {
      await rpc.call('credentials/set', { ref: credentialRef, value });
      setKeyDrafts((prev) => ({ ...prev, [credentialRef]: '' }));
    });
  }

  function clearKey(credentialRef: string) {
    return run(async () => {
      await rpc.call('credentials/unset', { ref: credentialRef });
    });
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    [next[index], next[target]] = [next[target], next[index]];
    void persist(next);
  }

  return (
    <div className="ww-settings__section">
      <h3 className="ww-settings__h">热点原文搜索 API（多供应商回退）</h3>
      <p className="ww-field__hint">
        按链顺序依次尝试，某家失败或没结果自动换下一家；全部失败才回退搜狗微信与抓取式搜索。API Key 仅存本机（credentials 存储，不回显）。
      </p>
      <ol className="ww-provider-chain">
        {chain.map((entry, index) => {
          const label = SEARCH_PROVIDER_LABELS[entry.providerId];
          const descriptor = config.credentials[entry.credentialRef];
          const draft = keyDrafts[entry.credentialRef] ?? '';
          return (
            <li
              key={entry.providerId}
              className={editingId === entry.providerId ? 'ww-provider ww-provider--editing' : 'ww-provider'}
            >
              <span className="ww-provider__order">{index + 1}</span>
              <CodeChip>{label}</CodeChip>
              <ConfiguredBadge descriptor={descriptor} />
              <span className="ww-provider__ops">
                <button
                  type="button"
                  className="ww-icon-btn"
                  aria-label={`配置 ${entry.providerId}`}
                  aria-expanded={editingId === entry.providerId}
                  onClick={() => setEditingId((current) => (current === entry.providerId ? null : entry.providerId))}
                >
                  <Icon name="key-round" size={16} />
                </button>
                <button
                  type="button"
                  className="ww-icon-btn"
                  aria-label={`上移 ${entry.providerId}`}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                >
                  <Icon name="chevron-down" size={16} className="ww-rotate-180" />
                </button>
                <button
                  type="button"
                  className="ww-icon-btn"
                  aria-label={`下移 ${entry.providerId}`}
                  onClick={() => move(index, 1)}
                  disabled={index === chain.length - 1}
                >
                  <Icon name="chevron-down" size={16} />
                </button>
                <button
                  type="button"
                  className="ww-icon-btn"
                  aria-label={`移除 ${entry.providerId}`}
                  onClick={() => void persist(chain.filter((item) => item.providerId !== entry.providerId))}
                >
                  <Icon name="x" size={16} />
                </button>
              </span>
              {editingId === entry.providerId ? (
                <div className="ww-provider__editor">
                  <Input
                    type="password"
                    value={draft}
                    onChange={(event) =>
                      setKeyDrafts((prev) => ({ ...prev, [entry.credentialRef]: event.target.value }))
                    }
                    placeholder={descriptor?.configured ? '已配置——输入新值可覆盖' : `输入 ${label} API Key`}
                    aria-label={`${label} API Key`}
                  />
                  <div className="ww-settings__row">
                    <Button
                      size="sm"
                      variant="primary"
                      className="ww-btn-accent"
                      onClick={() => void saveKey(entry.credentialRef)}
                      disabled={!draft.trim()}
                    >
                      保存 Key
                    </Button>
                    <Button size="sm" onClick={() => void clearKey(entry.credentialRef)} disabled={!descriptor?.configured}>
                      清除
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Menu
        open={addOpen}
        anchor={
          <Button variant="outline" size="sm" icon={<Icon name="search" size={16} />} onClick={() => setAddOpen((v) => !v)}>
            添加供应商
          </Button>
        }
        items={remaining.map((id) => ({ id, label: SEARCH_PROVIDER_LABELS[id] }))}
        onSelect={(id) => {
          setAddOpen(false);
          const providerId = id as SearchProviderId;
          void persist([...chain, { providerId, credentialRef: searchCredentialRef(providerId) }]);
        }}
        onClose={() => setAddOpen(false)}
      />
      <div className="ww-settings__row">
        <SaveState state={saveState} />
        {saveError ? <span className="ww-settings__save ww-settings__save--error">{saveError}</span> : null}
        <span className="ww-field__hint">QVeris 返回的是可调用能力而非文章链接，未纳入此链。</span>
      </div>
      <label className="ww-field">
        <span className="ww-field__label">时效范围</span>
        <select
          value={freshness}
          onChange={(event) => {
            const value = event.target.value as SearchFreshness;
            setFreshness(value);
            void persist(chain, value);
          }}
          aria-label="搜索时效范围"
        >
          <option value="oneDay">一天内</option>
          <option value="oneWeek">一周内</option>
          <option value="oneMonth">一月内</option>
          <option value="noLimit">不限</option>
        </select>
        <span className="ww-field__hint">
          只影响支持时效过滤的供应商（博查 / Tavily）；热点新闻建议一天内或一周内。
        </span>
      </label>
    </div>
  );
}

