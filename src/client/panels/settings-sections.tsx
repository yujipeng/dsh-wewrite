import { useState } from 'react';
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ConfigView, CredentialsDescriptor } from '@/shared/contract';
import type { WritingProfile } from '@/shared/schema-base';
import type { WewriteRpc } from '../lib/rpc';
import { describeRpcFailure } from '../lib/rpc';
import { Icon } from '../components/Icon';

/**
 * 设置页分组内容区（DESIGN §9.6）：公众号 / API 代理 / 发布纪律（模型与图片组在 settings-models.tsx）。
 * 凭据只写直通（credentials/set）+ describe 驱动「已配置」徽标（AC-5）；
 * 代理 URL 字段级校验；40164 诊断展示出口 IP 与两条出路（AC-6）。
 */

export type SettingsGroup = 'wechat' | 'llm' | 'images' | 'proxy' | 'discipline';

export interface SectionProps {
  config: ConfigView;
  rpc: WewriteRpc;
  onSaved: () => Promise<void> | void;
}

export function SaveState({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'idle') return null;
  return <span className={state === 'error' ? 'ww-settings__save ww-settings__save--error' : 'ww-settings__save'}>{state === 'saving' ? '保存中…' : state === 'saved' ? '已保存' : '保存失败，重试'}</span>;
}

export function ConfiguredBadge({ descriptor }: { descriptor: CredentialsDescriptor | undefined }) {
  if (!descriptor) return null;
  return descriptor.configured ? (
    <span className="ww-badge ww-badge--ok">
      <Icon name="check" size={16} /> 已配置
    </span>
  ) : (
    <span className="ww-badge">
      <Icon name="circle-alert" size={16} /> 未配置
    </span>
  );
}

/** 公众号接入：AppID/Secret/作者名（代理与测试在 API 代理组，避免重复表单）。 */
export function WechatSection({ config, rpc, onSaved }: SectionProps) {
  const [appId, setAppId] = useState(config.settings.wechatAppId);
  const [author, setAuthor] = useState(config.settings.wechatAuthor);
  const [secret, setSecret] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [profile, setProfile] = useState<WritingProfile>(config.settings.writingProfile);
  const [topicsText, setTopicsText] = useState(config.settings.writingProfile.topics.join('\n'));
  const [blacklistWordsText, setBlacklistWordsText] = useState(config.settings.writingProfile.blacklistWords.join('\n'));
  const [blacklistTopicsText, setBlacklistTopicsText] = useState(config.settings.writingProfile.blacklistTopics.join('\n'));
  const [profileSaveState, setProfileSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  function updateProfile<K extends keyof WritingProfile>(key: K, value: WritingProfile[K]): void {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  async function saveProfile() {
    setProfileSaveState('saving');
    try {
      const payload: WritingProfile = {
        ...profile,
        topics: splitLines(topicsText),
        blacklistWords: splitLines(blacklistWordsText),
        blacklistTopics: splitLines(blacklistTopicsText),
      };
      await rpc.call('config/set', { writingProfile: payload });
      setProfile(payload);
      setProfileSaveState('saved');
      await onSaved();
    } catch {
      setProfileSaveState('error');
    }
  }

  async function save() {
    setSaveState('saving');
    try {
      await rpc.call('config/set', { wechatAppId: appId.trim(), wechatAuthor: author.trim() });
      if (secret.trim().length > 0) {
        await rpc.call('credentials/set', { ref: 'WEWRITE_WECHAT_SECRET', value: secret.trim() });
        setSecret('');
      }
      setSaveState('saved');
      await onSaved();
    } catch {
      setSaveState('error');
    }
  }

  return (
    <div className="ww-settings__section">
      <h3 className="ww-settings__h">公众号接入</h3>
      <label className="ww-field">
        <span className="ww-field__label">AppID</span>
        <Input value={appId} onChange={(event) => setAppId(event.target.value)} aria-label="公众号 AppID" />
      </label>
      <label className="ww-field">
        <span className="ww-field__label">AppSecret <span className="ww-field__hint">仅存本机（credentials 存储，不进 git、不回显）</span></span>
        <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={config.credentials['WEWRITE_WECHAT_SECRET']?.configured ? '已配置——输入新值可覆盖' : '输入 AppSecret'} aria-label="公众号 AppSecret" />
        <ConfiguredBadge descriptor={config.credentials['WEWRITE_WECHAT_SECRET']} />
      </label>
      <label className="ww-field">
        <span className="ww-field__label">作者名（文章 byline）</span>
        <Input value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="作者名" />
      </label>
      <div className="ww-settings__row">
        <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void save()} disabled={saveState === 'saving'}>
          保存
        </Button>
        <SaveState state={saveState} />
      </div>

      <div className="ww-writing-profile">
        <div className="ww-writing-profile__head">
          <h3 className="ww-settings__h">写作要求</h3>
          <p className="ww-field__hint">生成文章时注入大纲与成稿提示词；留空不注入。参考 wechat-article/.wewrite/style.yaml，修改后对下一次生成生效。</p>
        </div>

        <section className="ww-writing-profile__group">
          <h4 className="ww-writing-profile__group-title">账号定位</h4>
          <div className="ww-grid-2">
            <label className="ww-field">
              <span className="ww-field__label">公众号定位</span>
              <Input value={profile.name} onChange={(event) => updateProfile('name', event.target.value)} placeholder="如：社会现象心理分析" aria-label="公众号定位" />
            </label>
            <label className="ww-field">
              <span className="ww-field__label">行业 / 领域</span>
              <Input value={profile.industry} onChange={(event) => updateProfile('industry', event.target.value)} placeholder="如：心理学 / 社会观察" aria-label="行业领域" />
            </label>
          </div>
        </section>

        <section className="ww-writing-profile__group">
          <h4 className="ww-writing-profile__group-title">表达风格</h4>
          <div className="ww-grid-2">
            <label className="ww-field">
              <span className="ww-field__label">语气</span>
              <textarea
                className="ww-textarea"
                rows={2}
                value={profile.tone}
                onChange={(event) => updateProfile('tone', event.target.value)}
                placeholder="像朋友聊天，冷静不贩卖焦虑，给可操作动作"
                aria-label="语气"
              />
            </label>
            <label className="ww-field">
              <span className="ww-field__label">人称与视角</span>
              <textarea
                className="ww-textarea"
                rows={2}
                value={profile.voice}
                onChange={(event) => updateProfile('voice', event.target.value)}
                placeholder="第一人称，边聊边把道理讲清楚"
                aria-label="人称与视角"
              />
            </label>
          </div>
          <div className="ww-grid-3">
            <label className="ww-field">
              <span className="ww-field__label">目标字数</span>
              <Input value={profile.wordCount} onChange={(event) => updateProfile('wordCount', event.target.value)} placeholder="1800-2600" aria-label="目标字数" />
            </label>
            <label className="ww-field">
              <span className="ww-field__label">内容风格</span>
              <Input value={profile.contentStyle} onChange={(event) => updateProfile('contentStyle', event.target.value)} placeholder="干货 / 故事 / 观点" aria-label="内容风格" />
            </label>
            <label className="ww-field">
              <span className="ww-field__label">写作人格</span>
              <Input value={profile.persona} onChange={(event) => updateProfile('persona', event.target.value)} placeholder="如 midnight-friend" aria-label="写作人格" />
            </label>
          </div>
        </section>

        <section className="ww-writing-profile__group">
          <h4 className="ww-writing-profile__group-title">主题与禁忌</h4>
          <label className="ww-field">
            <span className="ww-field__label">主题方向 <span className="ww-field__hint">每行一条</span></span>
            <textarea
              className="ww-textarea"
              rows={Math.min(8, Math.max(3, topicsText.split('\n').length))}
              value={topicsText}
              onChange={(event) => setTopicsText(event.target.value)}
              placeholder={'社会热点背后的心理机制\n人际关系与边界感'}
              aria-label="主题方向"
            />
          </label>
          <div className="ww-grid-2">
            <label className="ww-field">
              <span className="ww-field__label">禁用词 <span className="ww-field__hint">每行一条</span></span>
              <textarea
                className="ww-textarea"
                rows={Math.min(6, Math.max(2, blacklistWordsText.split('\n').length))}
                value={blacklistWordsText}
                onChange={(event) => setBlacklistWordsText(event.target.value)}
                placeholder={'震惊\n必看'}
                aria-label="禁用词"
              />
            </label>
            <label className="ww-field">
              <span className="ww-field__label">不写的话题 <span className="ww-field__hint">每行一条</span></span>
              <textarea
                className="ww-textarea"
                rows={Math.min(6, Math.max(2, blacklistTopicsText.split('\n').length))}
                value={blacklistTopicsText}
                onChange={(event) => setBlacklistTopicsText(event.target.value)}
                placeholder={'诊断他人精神疾病\n政治敏感'}
                aria-label="不写的话题"
              />
            </label>
          </div>
        </section>

        <section className="ww-writing-profile__group">
          <h4 className="ww-writing-profile__group-title">配图</h4>
          <label className="ww-field">
            <span className="ww-field__label">封面风格 <span className="ww-field__hint">可选，供配图参考</span></span>
            <textarea
              className="ww-textarea"
              rows={2}
              value={profile.coverStyle}
              onChange={(event) => updateProfile('coverStyle', event.target.value)}
              placeholder="简洁、留白多，符号化意象，避免夸张人脸"
              aria-label="封面风格"
            />
          </label>
        </section>

        <div className="ww-writing-profile__footer">
          <SaveState state={profileSaveState} />
          <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void saveProfile()} disabled={profileSaveState === 'saving'}>
            保存写作要求
          </Button>
        </div>
      </div>
    </div>
  );
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 模型服务：llm/options 透传宿主 providers/models，写回 llmDefault（provider/model 均可选）。 */
/** API 代理 + 连接测试（wechat/diagnose：reachable / 40164 出口 IP 两条出路）。 */
export function ProxySection({ config, rpc }: SectionProps) {
  const [baseUrl, setBaseUrl] = useState(config.settings.wechatApiBaseUrl);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<'ok' | 'fail' | undefined>();
  const [failure, setFailure] = useState<{ title: string; hint?: string; ip: boolean } | undefined>();

  const urlInvalid = baseUrl.length > 0 && !/^https?:\/\//.test(baseUrl);

  async function save() {
    setSaveState('saving');
    try {
      await rpc.call('config/set', { wechatApiBaseUrl: baseUrl.trim() });
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  async function test() {
    setTesting(true);
    setResult(undefined);
    setFailure(undefined);
    try {
      const diagnose = await rpc.call<{ reachable: boolean; ipWhitelisted?: boolean; errcode?: number; hint?: string }>('wechat/diagnose', {});
      if (diagnose.reachable && diagnose.ipWhitelisted !== false) {
        setResult('ok');
      } else {
        const notice = describeRpcFailure({ errcode: diagnose.errcode, hint: diagnose.hint, message: diagnose.hint ?? '接口不可达' });
        setResult('fail');
        setFailure({ title: notice.title, hint: notice.hint, ip: notice.ipWhitelist || diagnose.errcode === 40164 });
      }
    } catch (error) {
      const notice = describeRpcFailure(error);
      setResult('fail');
      setFailure({ title: notice.title, hint: notice.hint, ip: notice.ipWhitelist });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="ww-settings__section">
      <h3 className="ww-settings__h">API 代理（微信接口统一出口）</h3>
      <p className="ww-field-note">本机 IP 不在微信白名单时必须走代理；所有微信调用统一走该地址，无混合路径（AC-2）。</p>
      <label className="ww-field">
        <span className="ww-field__label">API 代理地址</span>
        <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} aria-label="API 代理地址" className={urlInvalid ? 'ww-input-error' : undefined} />
        {urlInvalid ? <span className="ww-field__error">代理地址必须以 http(s):// 开头</span> : null}
      </label>
      <div className="ww-settings__row">
        <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void save()} disabled={saveState === 'saving' || urlInvalid}>
          保存
        </Button>
        <SaveState state={saveState} />
        <Button variant="outline" size="sm" icon={<Icon name={testing ? 'loader-circle' : 'plug-zap'} size={16} className={testing ? 'ww-spin' : undefined} />} onClick={() => void test()} disabled={testing || urlInvalid}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
      </div>
      {result === 'ok' ? (
        <p className="ww-callout ww-callout--ok">
          <Icon name="circle-check" size={16} /> 草稿箱 API 可达
        </p>
      ) : null}
      {result === 'fail' && failure ? (
        <div className="ww-callout ww-callout--fail" role="alert">
          <p className="ww-callout__title">
            <Icon name="triangle-alert" size={16} /> {failure.title}
          </p>
          {failure.hint ? <p className="ww-callout__hint">{failure.hint}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 发布纪律：草稿箱锁定态（v0.1 无群发调用路径，AC-10）。 */
export function DisciplineSection() {
  return (
    <div className="ww-settings__section">
      <h3 className="ww-settings__h">发布纪律</h3>
      <div className="ww-locked">
        <span className="ww-locked__dot" aria-hidden="true" />
        <div>
          <p className="ww-locked__title">发布目标：草稿箱（锁定）</p>
          <p className="ww-locked__note">群发不可撤回，v0.1 不提供自动群发。定时任务与手动推送一律先落草稿箱，群发动作只能你在微信后台人工执行。</p>
        </div>
        <Pill>锁定</Pill>
      </div>
    </div>
  );
}

export function MenuTrigger({ label, open, onToggle, mono }: { label: string; open: boolean; onToggle: () => void; mono?: boolean }) {
  return (
    <button type="button" className="ww-menu-trigger" aria-expanded={open} aria-haspopup="menu" onClick={onToggle}>
      <span className={mono ? 'ww-menu-trigger__mono' : undefined}>{label}</span>
      <Icon name="chevron-down" size={16} />
    </button>
  );
}
