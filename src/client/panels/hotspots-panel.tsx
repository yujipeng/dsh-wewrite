import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import type { HotspotFetchView, HotspotItem, SuggestedTopicView, SuggestedTopicsView } from '@/shared/contract';
import { readCachedSuggestions, writeCachedSuggestions } from '../lib/suggested-topics-cache';
import { domainOf, formatTime, hotspotSourceLabel, isHttpUrl } from '../lib/format';
import { describeRpcFailure, WewriteRpcError } from '../lib/rpc';
import { EmptyState, ErrorNote, SkeletonRow } from '../components/bits';
import { HotspotItemDigest } from '../components/HotspotItemDigest';
import { TopicConfirmDialog, type TopicDraft } from '../components/TopicConfirmDialog';
import { Icon } from '../components/Icon';
import { useStore } from '../store';

/**
 * 选题中心（DESIGN §9.2）：左列「我的选题关键词」+ 热门榜，右侧「建议选题」；左 6 右 4。
 * 命中关键词的行底 --ww-accent-subtle；「写这个」先打开确认弹层（来源/链接/AI 分析）。
 * v0.3 R1：行展开区 = 原文链接行 + 逐条 AI 速览块（HotspotItemDigest，懒加载+逐条缓存）。
 */

const KEYWORDS_STORAGE_KEY = 'dsh-wewrite.hotspot-keywords';

function loadKeywords(): string[] {
  try {
    const raw = window.localStorage.getItem(KEYWORDS_STORAGE_KEY);
    if (!raw) return ['DSH 插件'];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type HotspotsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: HotspotItem[]; fetchedAtIso: string; batchId: string };

type SuggestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SuggestedTopicsView; refreshing?: boolean; errorMessage?: string };

interface SuggestFailure {
  title: string;
  hint?: string;
  needSettings: boolean;
}

/** 宿主信封把真实 code 放在 message 前缀（`[internal] [llm-not-configured] …`）：剥掉给用户看正文。 */
function stripCodePrefix(message: string): string {
  return message.replace(/^(\[[^\]]+\]\s*)+/, '').trim();
}

function describeSuggestFailure(message: string): SuggestFailure {
  if (message.includes('llm-not-configured')) {
    return { title: '生成建议选题需要先配置模型。', hint: '到「设置 → 模型」选择供应商与模型后回来刷新。', needSettings: true };
  }
  if (message.includes('suggest-no-hotspots')) {
    return { title: stripCodePrefix(message) || '热榜里没有可用条目。', needSettings: false };
  }
  if (message.includes('suggest-timeout')) {
    return { title: '建议选题生成超时。', hint: '可以重试，或稍后再刷新。', needSettings: false };
  }
  return { title: '建议选题生成失败。', hint: stripCodePrefix(message) || undefined, needSettings: false };
}

export function HotspotsPanel() {
  const store = useStore();
  const { rpc, navigate, t } = store;
  const [state, setState] = useState<HotspotsState>({ status: 'idle' });
  const [suggest, setSuggest] = useState<SuggestState>(() => {
    const cached = readCachedSuggestions();
    return cached ? { status: 'ready', data: cached } : { status: 'idle' };
  });
  const [draft, setDraft] = useState<TopicDraft | null>(null);
  const [keywords, setKeywords] = useState<string[]>(loadKeywords);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [onlyHits, setOnlyHits] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  /** 热点榜/定时候选共用：启动前先确认。 */
  const openHotspotDraft = (item: { title: string; source: string; rank: number; url: string }) => {
    setDraft({
      kind: 'hotspot',
      title: item.title,
      source: item.source,
      sourceRank: item.rank,
      sourceTitle: item.title,
      sourceUrl: item.url,
    });
  };

  const openSuggestedDraft = (topic: SuggestedTopicView) => {
    setDraft({
      kind: 'suggested',
      title: topic.title,
      angle: topic.angle,
      source: topic.source,
      sourceRank: topic.sourceRank,
      sourceTitle: topic.sourceTitle,
      sourceUrl: topic.sourceUrl,
    });
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(KEYWORDS_STORAGE_KEY, JSON.stringify(keywords));
    } catch {
      /* localStorage 不可用时关键词仅存内存 */
    }
  }, [keywords]);

  const fetchHotspots = useCallback(async (refresh = false) => {
    setState({ status: 'loading' });
    try {
      const data = await rpc.call<HotspotFetchView>('hotspots/fetch', {
        limit: 30,
        ...(refresh ? { refresh: true } : {}),
      });
      setState({ status: 'ready', items: data.items, fetchedAtIso: data.fetchedAtIso, batchId: data.batchId });
    } catch (error) {
      setState({ status: 'error', message: error instanceof WewriteRpcError ? error.message : String(error) });
    }
  }, [rpc]);

  const initialFetch = useRef(false);
  useEffect(() => {
    if (initialFetch.current) return;
    initialFetch.current = true;
    void fetchHotspots();
  }, [fetchHotspots]);

  /**
   * 建议选题：热榜批次变化后自动触发（进入页面 / 手动刷新热榜）。
   * 已有结果时保留旧列表并标记 refreshing，避免骨架屏闪烁；失败也保留旧结果。
   * refresh=true 用于同批次强制重算（建议区自己的刷新按钮）；旧的响应由序号丢弃。
   */
  const suggestSeq = useRef(0);
  const loadSuggestions = useCallback(async (refresh = false) => {
    const seq = suggestSeq.current + 1;
    suggestSeq.current = seq;
    setSuggest((prev) =>
      prev.status === 'ready' ? { status: 'ready', data: prev.data, refreshing: true } : { status: 'loading' },
    );
    try {
      const data = await rpc.call<SuggestedTopicsView>('hotspots/suggest', {
        count: 10,
        ...(refresh ? { refresh: true } : {}),
      });
      if (seq !== suggestSeq.current) return;
      writeCachedSuggestions(data);
      setSuggest({ status: 'ready', data });
    } catch (error) {
      if (seq !== suggestSeq.current) return;
      const message = error instanceof WewriteRpcError ? error.message : String(error);
      setSuggest((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', data: prev.data, refreshing: false, errorMessage: message }
          : { status: 'error', message },
      );
    }
  }, [rpc]);

  /** 热榜批次变化 → 立即按新批次生成建议；同批次且已有本地缓存则直接复用（零 RPC）。 */
  const lastSuggestedBatch = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (lastSuggestedBatch.current === state.batchId) return;
    lastSuggestedBatch.current = state.batchId;
    const cached = readCachedSuggestions();
    if (cached && cached.batchId === state.batchId) {
      setSuggest({ status: 'ready', data: cached });
      return;
    }
    void loadSuggestions();
  }, [state, loadSuggestions]);

  const hit = useCallback((item: HotspotItem): boolean => keywords.some((word) => word && item.title.includes(word)), [keywords]);

  const visible = useMemo(() => {
    if (state.status !== 'ready') return [];
    const sorted = [...state.items].sort((a, b) => a.rank - b.rank);
    return onlyHits ? sorted.filter(hit) : sorted;
  }, [state, onlyHits, hit]);

  const failure = state.status === 'error' ? describeRpcFailure(new Error(state.message)) : undefined;
  const candidates = store.snapshot.status === 'ready' ? store.snapshot.data.topicCandidates : [];
  const suggested = suggest.status === 'ready' ? suggest.data : undefined;
  const suggestFailure = suggest.status === 'error' ? describeSuggestFailure(suggest.message) : undefined;
  const suggestRefreshing = suggest.status === 'ready' && suggest.refreshing === true;
  const suggestStale = suggested !== undefined && state.status === 'ready' && suggested.batchId !== state.batchId;
  const suggestRefreshError = suggest.status === 'ready' ? suggest.errorMessage : undefined;

  function addKeyword() {
    const word = keywordDraft.trim();
    if (!word || keywords.includes(word)) return;
    setKeywords((current) => [...current, word]);
    setKeywordDraft('');
  }

  return (
    <div className={store.narrow ? 'ww-hotspots ww-hotspots--narrow' : 'ww-hotspots'}>
      <div className="ww-hotspots__main">
        <section className="ww-hotspots__keywords">
          <h3 className="ww-aside-title">我的选题关键词</h3>
          <div className="ww-keywords">
            {keywords.map((word) => (
              /* P5：Pill 本体不再整删（静态 chip），删除收敛到独立 × 按钮（真 button + aria-label） */
              <span className="ww-keyword" key={word}>
                <Pill>
                  {word}
                  <button
                    type="button"
                    className="ww-keyword__x"
                    aria-label={`移除关键词「${word}」`}
                    data-testid="ww-keyword-remove"
                    onClick={() => setKeywords((current) => current.filter((item) => item !== word))}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </Pill>
              </span>
            ))}
            {keywords.length === 0 ? <p className="ww-aside-empty">还没有订阅关键词。添加后命中的条目会高亮。</p> : null}
          </div>
          <div className="ww-keywords__add">
            <Input
              placeholder="添加关键词"
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addKeyword();
              }}
              aria-label="添加选题关键词"
            />
            <Button variant="outline" size="sm" icon={<Icon name="plus" size={16} />} onClick={addKeyword} aria-label="添加关键词">
              添加
            </Button>
          </div>
          <button type="button" className={onlyHits ? 'ww-filter-toggle ww-filter-toggle--on' : 'ww-filter-toggle'} onClick={() => setOnlyHits((on) => !on)} aria-pressed={onlyHits}>
            <Icon name="filter" size={16} /> 命中筛选：{onlyHits ? '仅显示命中' : '看全部'}
          </button>
        </section>

        <div className="ww-hotspots__board">
        <div className="ww-pagebar">
          {/* Bluewash §4-2：选题域页头识别点（橙） */}
          <span className="ww-pagebar__dot" data-view="topics" />
          <h2 className="ww-pagebar__title">热门榜</h2>
          {state.status === 'ready' ? (
            <>
              <span className="ww-pagebar__count">· {visible.length}</span>
              <span className="ww-pagebar__meta">更新于 {formatTime(state.fetchedAtIso)}</span>
            </>
          ) : null}
          <div className="ww-pagebar__spacer" />
          <Button variant="ghost" size="sm" icon={<Icon name={state.status === 'loading' ? 'loader-circle' : 'refresh-cw'} size={16} className={state.status === 'loading' ? 'ww-spin' : undefined} />} onClick={() => void fetchHotspots(true)}>
            {t('action.refresh')}
          </Button>
        </div>
        {candidates.length > 0 ? (
          <section className="ww-candidates">
            <div className="ww-candidates__head">
              <span className="ww-candidates__title">
                <Icon name="sparkles" size={16} /> 定时选题候选
              </span>
              <span className="ww-candidates__meta">
                更新于 {formatTime(candidates[0].createdAt)} · {candidates.length} 条
              </span>
            </div>
            <ul className="ww-candidates__list">
              {candidates.map((item) => (
                <li key={item.id} className="ww-candidate">
                  <span className="ww-candidate__rank">#{item.rank}</span>
                  <div className="ww-candidate__body">
                    <span className="ww-candidate__title">{item.title}</span>
                    <span className="ww-candidate__meta">
                      {hotspotSourceLabel(item.source)} · {domainOf(item.url)}
                    </span>
                    {item.digest ? <p className="ww-candidate__digest">{item.digest}</p> : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Icon name="pen-line" size={16} />}
                    onClick={() => openHotspotDraft(item)}
                  >
                    {t('action.writeThis')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {state.status === 'idle' || state.status === 'loading' ? (
          <div>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : state.status === 'error' ? (
          <ErrorNote
            title={failure?.title ?? '热榜拉取失败。'}
            hint={failure?.hint}
            action={<Button variant="outline" size="sm" onClick={() => void fetchHotspots(true)}>{t('action.retry')}</Button>}
          />
        ) : visible.length === 0 ? (
          onlyHits ? (
            <EmptyState
              icon={<Icon name="filter" size={20} />}
              title={`没有命中「${keywords.join('、')}」的条目。换个关键词，或关掉筛选看全部。`}
              action={<Button variant="outline" size="sm" onClick={() => setOnlyHits(false)}>关掉筛选</Button>}
            />
          ) : (
            <EmptyState
              icon={<Icon name="inbox" size={20} />}
              subIcon="sparkles"
              title="热榜还没拉取。点击刷新，或检查设置里的数据源配置。"
              action={<Button variant="outline" size="sm" onClick={() => navigate({ kind: 'settings' })}>{t('action.goSettings')}</Button>}
            />
          )
        ) : (
          <ul className="ww-hotspot-list">
            {visible.map((item) => (
              <li key={`${item.source}-${item.rank}-${item.title}`} className={hit(item) ? 'ww-hotspot ww-hotspot--hit' : 'ww-hotspot'}>
                <div className="ww-hotspot__liner">
                  <button
                    type="button"
                    className="ww-hotspot__row"
                    aria-expanded={expanded === item.title}
                    onClick={() => setExpanded(expanded === item.title ? null : item.title)}
                  >
                    <span className={item.rank <= 3 ? 'ww-hotspot__rank ww-hotspot__rank--top' : 'ww-hotspot__rank'}>#{item.rank}</span>
                    <span className="ww-hotspot__title">{item.title}</span>
                    <span className="ww-hotspot__meta">
                      {hotspotSourceLabel(item.source)} · {domainOf(item.url)}
                    </span>
                    <Icon name={expanded === item.title ? 'chevron-down' : 'chevron-right'} size={16} />
                  </button>
                  {/* L5 动作前置：hover/键盘聚焦行时可见「写这个」，单击即以该条目为题启动管线 */}
                  <button
                    type="button"
                    className="ww-hotspot__write"
                    aria-label={`写这个：${item.title}`}
                    onClick={() => openHotspotDraft(item)}
                  >
                    <Icon name="pen-line" size={16} />
                    <span>{t('action.writeThis')}</span>
                  </button>
                </div>
                {expanded === item.title ? (
                  <div className="ww-hotspot__expand">
                    {/* 展开区垂直秩序：原文链接（确定性信息）在上，AI 速览（机器生成）在下 */}
                    <a className="ww-link" href={item.url} target="_blank" rel="noreferrer">
                      <Icon name="external-link" size={16} /> 原文链接（{domainOf(item.url)}）
                    </a>
                    <HotspotItemDigest item={item} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>

      <aside className="ww-hotspots__aside">
        <section className="ww-suggest" data-testid="ww-suggested-topics">
          <div className="ww-suggest__head">
            <h3 className="ww-aside-title">
              <Icon name="sparkles" size={16} /> 建议选题
            </h3>
            {suggested ? (
              <span className="ww-suggest__meta">
                {suggested.topics.length} 条 · {formatTime(suggested.generatedAtIso)}
                {suggestStale ? ' · 上一批' : ''}
              </span>
            ) : null}
            <span className="ww-suggest__spacer" />
            <Button
              variant="ghost"
              size="sm"
              aria-label="重新生成建议选题"
              icon={<Icon name={suggest.status === 'loading' || suggestRefreshing ? 'loader-circle' : 'refresh-cw'} size={16} className={suggest.status === 'loading' || suggestRefreshing ? 'ww-spin' : undefined} />}
              onClick={() => void loadSuggestions(true)}
            >
              {t('action.refresh')}
            </Button>
          </div>

          {suggested && !suggested.profileUsed ? (
            <div className="ww-suggest__notice">
              <span>还没有填写公众号写作要求，本次按热榜可写性筛选；补充后匹配更准。</span>
              <button type="button" className="ww-suggest__link" onClick={() => navigate({ kind: 'settings' })}>
                去设置
              </button>
            </div>
          ) : null}

          {suggestRefreshing ? (
            <p className="ww-suggest__notice ww-suggest__notice--loading">正在按最新热榜生成建议…</p>
          ) : null}
          {suggestRefreshError ? (
            <p className="ww-suggest__notice ww-suggest__notice--error">
              本次更新失败：{stripCodePrefix(suggestRefreshError)}。当前显示上一批结果。
            </p>
          ) : null}

          {suggest.status === 'loading' || suggest.status === 'idle' ? (
            <div className="ww-suggest__skeleton">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : suggest.status === 'error' ? (
            <ErrorNote
              title={suggestFailure?.title ?? '建议选题生成失败。'}
              hint={suggestFailure?.hint}
              action={
                suggestFailure?.needSettings ? (
                  <Button variant="outline" size="sm" onClick={() => navigate({ kind: 'settings' })}>
                    {t('action.goSettings')}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void loadSuggestions(true)}>
                    {t('action.retry')}
                  </Button>
                )
              }
            />
          ) : suggested && suggested.topics.length > 0 ? (
            <ol className="ww-suggest__list">
              {suggested.topics.map((topic, index) => (
                <li key={`${topic.source}-${topic.sourceRank}-${index}`} className="ww-suggest__item">
                  <button
                    type="button"
                    className="ww-suggest__main"
                    aria-label={`写这个：${topic.title}`}
                    onClick={() => openSuggestedDraft(topic)}
                  >
                    <span className="ww-suggest__rank">{index + 1}</span>
                    <span className="ww-suggest__title">{topic.title}</span>
                    <span className="ww-suggest__angle">{topic.angle}</span>
                  </button>
                  {isHttpUrl(topic.sourceUrl) ? (
                    <a className="ww-suggest__source" href={topic.sourceUrl} target="_blank" rel="noreferrer" title={topic.sourceTitle}>
                      源自 {hotspotSourceLabel(topic.source)} #{topic.sourceRank} · {topic.sourceTitle}
                    </a>
                  ) : (
                    <span className="ww-suggest__source">
                      源自 {hotspotSourceLabel(topic.source)} #{topic.sourceRank} · {topic.sourceTitle}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="ww-aside-empty">这次没有筛出合适的选题。刷新热榜或调整写作要求后再试。</p>
          )}
        </section>
      </aside>
      {draft ? (
        <TopicConfirmDialog
          key={`${draft.kind}:${draft.sourceRank}:${draft.title}`}
          draft={draft}
          onClose={() => setDraft(null)}
        />
      ) : null}
    </div>
  );
}
