import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { RunDetail, RunSummary } from '@/shared/contract';
import { formatDuration, formatShortDateTime } from '../lib/format';
import { EmptyState, ErrorNote, runStatusBadge, SkeletonBlock, StatusBadge } from '../components/bits';
import { Icon } from '../components/Icon';
import { useStore } from '../store';

/**
 * 任务中心（Task Center）：与写作台/定时页共用 snapshot.runs。
 * - 运行中 / 排队中 / 最近完成 三段，数据不依赖内存 generation，面板重载后可恢复。
 * - 行操作：取消（queued 出队、running abort）、重试（host 复用 paramsSnapshot）、跳转产出文章。
 * - 详情按需调用 run/detail（六步 + 错误），展开期间随全局 snapshot 轮询刷新。
 */

const HISTORY_LIMIT = 50;

const STEP_LABELS: Record<string, string> = {
  topic: '选题分析',
  outline: '研究与提纲',
  draft: '初稿写作',
  gates: '质量门禁',
  render: '排版转换',
  images: '配图生成',
};

function triggerLabel(trigger: RunSummary['trigger']): string {
  if (trigger === 'schedule') return '定时';
  if (trigger === 'chat') return '聊天';
  return '手动';
}

function isActive(run: RunSummary): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function canRetry(run: RunSummary): boolean {
  return run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
}

function topicLabel(run: RunSummary): string {
  return run.topic || '热榜选题';
}

export function TasksPanel() {
  const store = useStore();
  const { snapshot, refreshSnapshot, rpc, toast, t, cancelRun, retryRun, navigate } = store;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runs = snapshot.status === 'ready' ? snapshot.data.runs : undefined;
  const running = runs?.filter((run) => run.status === 'running') ?? [];
  const queued = runs?.filter((run) => run.status === 'queued') ?? [];
  const recent = runs?.filter((run) => !isActive(run)).slice(0, HISTORY_LIMIT) ?? [];
  const activeCount = running.length + queued.length;

  // 展开详情：按需拉 run/detail；active 行随全局 snapshot 轮询一起刷新。
  useEffect(() => {
    if (!expanded) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void rpc
      .call<RunDetail>('run/detail', { runId: expanded })
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((error) => {
        if (cancelled) return;
        setDetail(null);
        toast.push({ kind: 'error', title: '详情读取失败', detail: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, snapshot, rpc, toast]);

  async function handleCancel(run: RunSummary) {
    setBusyId(run.id);
    try {
      await cancelRun(run.id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetry(run: RunSummary) {
    setBusyId(run.id);
    try {
      await retryRun(run.id);
    } finally {
      setBusyId(null);
    }
  }

  function renderRow(run: RunSummary) {
    const badge = runStatusBadge(run.status);
    const isOpen = expanded === run.id;
    return (
      <li key={run.id} className={isActive(run) ? 'ww-task ww-task--active' : 'ww-task'}>
        <div className="ww-task__head">
          <StatusBadge tone={badge.tone} label={badge.label} />
          <span className="ww-task__topic" title={topicLabel(run)}>
            《{topicLabel(run)}》
          </span>
          <span className="ww-task__trigger">{triggerLabel(run.trigger)}</span>
          <span className="ww-task__time">{formatShortDateTime(run.startedAt)}</span>
          <span className="ww-task__duration">{formatDuration(run.startedAt, run.finishedAt)}</span>
        </div>
        {run.error ? <p className="ww-task__error">{run.error.message}</p> : null}
        <div className="ww-task__actions">
          {isActive(run) ? (
            <Button
              variant="ghost"
              size="sm"
              className="ww-danger-ghost"
              data-testid={`ww-task-cancel-${run.id}`}
              icon={<Icon name="x" size={16} />}
              disabled={busyId === run.id}
              onClick={() => void handleCancel(run)}
            >
              取消
            </Button>
          ) : null}
          {canRetry(run) ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`ww-task-retry-${run.id}`}
              icon={<Icon name="rotate-ccw" size={16} />}
              disabled={busyId === run.id}
              onClick={() => void handleRetry(run)}
            >
              重试
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            data-testid={`ww-task-detail-${run.id}`}
            aria-expanded={isOpen}
            icon={<Icon name="list-checks" size={16} />}
            onClick={() => setExpanded(isOpen ? null : run.id)}
          >
            {isOpen ? '收起' : '详情'}
          </Button>
          {run.articleId ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid={`ww-task-article-${run.id}`}
              icon={<Icon name="file-text" size={16} />}
              onClick={() => navigate({ kind: 'article', id: run.articleId as string })}
            >
              查看成稿
            </Button>
          ) : null}
        </div>
        {isOpen ? (
          <div className="ww-task__detail">
            {detailLoading && !detail ? <SkeletonBlock lines={3} /> : null}
            {detail ? (
              <>
                <ol className="ww-task__steps">
                  {detail.steps.map((step) => (
                    <li key={step.name} className={`ww-task__step ww-task__step--${step.status}`}>
                      <span className="ww-task__step-name">{STEP_LABELS[step.name] ?? step.name}</span>
                      <span className="ww-task__step-status">{step.status}</span>
                      {step.error ? <span className="ww-task__step-error">{step.error.message}</span> : null}
                    </li>
                  ))}
                </ol>
                {detail.error ? (
                  <p className="ww-task__error">
                    {detail.error.message} · {detail.error.code}
                  </p>
                ) : null}
              </>
            ) : null}
            {!detailLoading && !detail ? <p className="ww-task__muted">详情暂不可用。</p> : null}
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div className="ww-tasks">
      <div className="ww-pagebar">
        <span className="ww-pagebar__dot" data-view="tasks" />
        <h2 className="ww-pagebar__title">任务</h2>
        {runs ? <span className="ww-pagebar__count">· {activeCount} 进行中</span> : null}
        <div className="ww-pagebar__spacer" />
        <Button variant="ghost" size="sm" icon={<Icon name="rotate-ccw" size={16} />} onClick={() => void refreshSnapshot()}>
          刷新
        </Button>
      </div>

      {snapshot.status === 'loading' ? (
        <SkeletonBlock lines={4} />
      ) : snapshot.status === 'error' ? (
        <ErrorNote
          title="任务读取失败（存储不可用）。"
          action={<Button variant="outline" size="sm" onClick={() => void refreshSnapshot()}>{t('action.retry')}</Button>}
        />
      ) : activeCount === 0 && recent.length === 0 ? (
        <EmptyState
          icon={<Icon name="list-todo" size={20} />}
          subIcon="clock"
          title="还没有任务。开始一篇写作后，运行中、排队中和最近完成都会在这里留痕。"
          action={
            <Button variant="outline" size="sm" icon={<Icon name="pen-line" size={16} />} onClick={() => navigate({ kind: 'home' })}>
              去写作台
            </Button>
          }
        />
      ) : (
        <div className="ww-tasks__groups">
          {running.length > 0 ? (
            <section className="ww-tasks__group">
              <h3 className="ww-tasks__group-title">运行中（{running.length}）</h3>
              <ul className="ww-tasks__list">{running.map(renderRow)}</ul>
            </section>
          ) : null}
          {queued.length > 0 ? (
            <section className="ww-tasks__group">
              <h3 className="ww-tasks__group-title">排队中（{queued.length}）</h3>
              <ul className="ww-tasks__list">{queued.map(renderRow)}</ul>
            </section>
          ) : null}
          {recent.length > 0 ? (
            <section className="ww-tasks__group">
              <h3 className="ww-tasks__group-title">最近完成（{recent.length}）</h3>
              <ul className="ww-tasks__list">{recent.map(renderRow)}</ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
