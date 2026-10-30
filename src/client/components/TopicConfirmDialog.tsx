import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { RunParams } from '@/shared/contract';
import { readCachedDigest, writeCachedDigest, type DigestCacheEntry } from '../lib/hotspot-digest-cache';
import { domainOf, hotspotSourceLabel, isHttpUrl } from '../lib/format';
import { WewriteRpcError } from '../lib/rpc';
import { useStore } from '../store';
import { ErrorNote, SkeletonBlock } from './bits';
import { DigestLine } from './HotspotItemDigest';
import { Icon } from './Icon';

/**
 * 选题确认弹层（热点榜「写这个」/ 建议选题条目共用）：
 * 启动前展示来源、原文链接、AI 简介与分析角度，由用户确认/取消；
 * 已有进行中的生成任务时，改为「替换当前任务 / 排队生成新任务」二选一。
 *
 * AI 分析复用热门榜「AI 速览」（hotspots/digestItem，正文 + 2–4 条角度），
 * 与列表共用当日缓存：已生成过直接展示、不重复调模型；分析失败不阻断确认。
 */

export interface TopicDraft {
  readonly kind: 'hotspot' | 'suggested';
  readonly title: string;
  /** 建议选题自带的后端角度（热点榜无此项）。 */
  readonly angle?: string;
  readonly source: string;
  readonly sourceRank: number;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
}

type AnalysisState =
  | { status: 'loading' }
  | { status: 'ready'; data: DigestCacheEntry }
  | { status: 'error'; message: string };

interface AnalysisFailure {
  title: string;
  hint?: string;
}

/** 剥掉宿主信封的 `[internal] [code] ` 前缀，再按常见错误码给可行动文案。 */
function describeAnalysisFailure(message: string): AnalysisFailure {
  const cleaned = message.replace(/^(\[[^\]]+\]\s*)+/, '').trim();
  if (message.includes('llm-not-configured')) {
    return { title: '生成分析需要先配置模型。', hint: '到「设置 → 模型」选择模型后重试；也可以直接确认写这个。' };
  }
  if (message.includes('digest-timeout')) {
    return { title: 'AI 分析超时。', hint: '可以重试，或直接确认写这个。' };
  }
  return { title: 'AI 分析暂时不可用。', hint: cleaned || '可以直接确认写这个，不影响生成。' };
}

export function TopicConfirmDialog({ draft, onClose }: { draft: TopicDraft; onClose: () => void }) {
  const { rpc, t, generation, activeRun, startGeneration, enqueueGeneration, replaceGeneration } = useStore();
  const [analysis, setAnalysis] = useState<AnalysisState>(() => {
    const cached = readCachedDigest(draft.sourceUrl);
    return cached ? { status: 'ready', data: cached } : { status: 'loading' };
  });
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const loadAnalysis = useCallback(async () => {
    // 与热门榜「AI 速览」共用同一份数据与缓存：已生成过就直接展示，不再重复调模型。
    const cached = readCachedDigest(draft.sourceUrl);
    if (cached) {
      setAnalysis({ status: 'ready', data: cached });
      return;
    }
    setAnalysis({ status: 'loading' });
    try {
      const data = await rpc.call<DigestCacheEntry>('hotspots/digestItem', {
        rank: draft.sourceRank,
        title: draft.sourceTitle,
        url: draft.sourceUrl,
      });
      writeCachedDigest(draft.sourceUrl, data);
      setAnalysis({ status: 'ready', data });
    } catch (error) {
      setAnalysis({ status: 'error', message: error instanceof WewriteRpcError ? error.message : String(error) });
    }
  }, [rpc, draft.sourceRank, draft.sourceTitle, draft.sourceUrl]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void loadAnalysis();
  }, [loadAnalysis]);

  const conflict = generation !== null && activeRun !== undefined && (activeRun.status === 'queued' || activeRun.status === 'running');
  const params: RunParams = draft.kind === 'suggested'
    ? { topicMode: 'fixed', topic: draft.title, brief: { title: draft.title } }
    : { topicMode: 'fixed', topic: draft.title };

  const startNow = async () => {
    setBusy(true);
    await startGeneration(params, draft.title, { background: true });
    setBusy(false);
    onClose();
  };

  const replaceNow = async () => {
    setBusy(true);
    await replaceGeneration(params, draft.title);
    setBusy(false);
    onClose();
  };

  const enqueueNow = () => {
    enqueueGeneration(params, draft.title);
    onClose();
  };

  const failure = analysis.status === 'error' ? describeAnalysisFailure(analysis.message) : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      className="ww-modal ww-topic-dialog"
      contentClassName="ww-topic-dialog__scroll"
      title={draft.kind === 'suggested' ? '确认建议选题' : '确认选题'}
      closeLabel="取消"
      description="确认后转到后台生成，进度显示在右下角。"
      footer={
        conflict ? (
          <>
            <span className="ww-topic-dialog__footer-note">
              当前任务《{generation?.topic ?? ''}》正在生成
            </span>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="outline" size="sm" onClick={() => void replaceNow()} disabled={busy}>
              替换当前任务
            </Button>
            <Button variant="primary" size="sm" className="ww-btn-accent" onClick={enqueueNow} disabled={busy}>
              排队生成新任务
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" className="ww-btn-accent" onClick={() => void startNow()} disabled={busy}>
              {busy ? '启动中…' : '确认写这个'}
            </Button>
          </>
        )
      }
    >
      <div className="ww-topic-dialog__body">
        <section className="ww-topic-dialog__head">
          <h3 className="ww-topic-dialog__title">{draft.title}</h3>
          {draft.angle ? (
            <p className="ww-topic-dialog__angle">
              <span className="ww-topic-dialog__angle-label">推荐角度</span>
              {draft.angle}
            </p>
          ) : null}
          <div className="ww-topic-dialog__meta">
            <span>
              {hotspotSourceLabel(draft.source)} #{draft.sourceRank}
            </span>
            <span aria-hidden="true">·</span>
            <span className="ww-topic-dialog__source-title" title={draft.sourceTitle}>
              {draft.sourceTitle}
            </span>
          </div>
          {isHttpUrl(draft.sourceUrl) ? (
            <a className="ww-link" href={draft.sourceUrl} target="_blank" rel="noreferrer">
              <Icon name="external-link" size={16} /> 打开原文（{domainOf(draft.sourceUrl)}）
            </a>
          ) : null}
        </section>

        <section className="ww-topic-dialog__analysis" aria-live="polite">
          <div className="ww-topic-dialog__analysis-head">
            <Icon name="wand-sparkles" size={16} />
            <span>AI 分析</span>
            {analysis.status === 'ready' ? (
              <>
                <span className="ww-topic-dialog__analysis-source">
                  {analysis.data.source === 'article' ? '读了原文' : '仅凭标题'}
                </span>
                {analysis.data.sourceType ? (
                  <span className="ww-topic-dialog__analysis-type" data-testid="ww-topic-dialog-source-type">
                    {({ hot: '热点', demand: '高频需求', evergreen: '常青' } as const)[analysis.data.sourceType]}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>

          {analysis.status === 'loading' ? (
            <>
              <SkeletonBlock lines={2} />
              <p className="ww-topic-dialog__wait">AI 读取原文并分析中，约 5–10 秒；也可以直接确认写这个。</p>
            </>
          ) : analysis.status === 'error' ? (
            <ErrorNote
              title={failure?.title ?? 'AI 分析暂时不可用。'}
              hint={failure?.hint}
              action={
                <Button variant="outline" size="sm" onClick={() => void loadAnalysis()}>
                  {t('action.retry')}
                </Button>
              }
            />
          ) : (
            <>
              <div className="ww-topic-dialog__block">
                <span className="ww-topic-dialog__label">内容速览</span>
                <div className="ww-topic-dialog__digest">
                  {analysis.data.digest
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0)
                    .map((line, index) => (
                      <DigestLine key={`d${index}`} line={line} />
                    ))}
                </div>
              </div>
              <div className="ww-topic-dialog__block">
                <span className="ww-topic-dialog__label">分析角度</span>
                {analysis.data.angles.length > 0 ? (
                  <ol className="ww-topic-dialog__angles">
                    {analysis.data.angles.map((angle, index) => (
                      <li key={`a${index}`}>{angle}</li>
                    ))}
                  </ol>
                ) : (
                  <p>这次没有给出角度，可以直接写。</p>
                )}
              </div>
              {analysis.data.originUrl ? (
                <p className="ww-topic-dialog__note">
                  <a className="ww-link" href={analysis.data.originUrl} target="_blank" rel="noreferrer">
                    原文报道
                  </a>
                </p>
              ) : null}
              {analysis.data.note ? <p className="ww-topic-dialog__note">{analysis.data.note}</p> : null}
              {analysis.data.source === 'title' ? (
                <p className="ww-topic-dialog__note">未能读取原文，以上为标题解读；可直接确认，或打开原文查看细节。</p>
              ) : null}
            </>
          )}
        </section>

        {conflict ? (
          <p className="ww-topic-dialog__conflict">
            当前任务《{generation?.topic ?? ''}》正在生成：替换会中断它并立即开始新选题；排队会在它结束后自动开始。
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
