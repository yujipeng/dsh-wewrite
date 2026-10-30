import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunParams, SnapshotResponse } from '@/shared/contract';
import type { Translate } from './lib/context';
import type { WewriteRpc } from './lib/rpc';
import type { Route } from './lib/router';
import { normalizeRoute } from './lib/router';
import type { ToastApi, ToastMessage } from './components/Toast';

/**
 * 面板状态中枢：路由 + snapshot 订阅刷新 + Toast + 生成态 + 面板宽度断点。
 * 不引状态库（纪律）：单个 context provider 足够面板级状态量。
 */

export type SnapshotState =
  | { status: 'loading' }
  | { status: 'ready'; data: SnapshotResponse }
  | { status: 'error'; message: string };

export interface GenerationState {
  runId: string;
  topic: string;
  overlayOpen: boolean;
}

/** 排队中的生成任务（当前 run 终态后自动开始，不再弹全屏进度）。 */
export interface QueuedGeneration {
  readonly id: number;
  readonly params: RunParams;
  readonly topic: string;
}

export interface WewriteStore {
  rpc: WewriteRpc;
  t: Translate;
  route: Route;
  navigate(route: Route): void;
  snapshot: SnapshotState;
  refreshSnapshot(): Promise<void>;
  toast: ToastApi;
  toastMessages: readonly ToastMessage[];
  dismissToast(id: number): void;
  generation: GenerationState | null;
  /** 排队生成的任务（当前任务结束后按 FIFO 自动开始）。 */
  queue: readonly QueuedGeneration[];
  startGeneration(params: RunParams, topic: string, options?: { background?: boolean }): Promise<void>;
  /** 加入队列，等当前任务终态后自动开始。 */
  enqueueGeneration(params: RunParams, topic: string): void;
  /** 取消当前任务并立即开始新任务（队列保留）。 */
  replaceGeneration(params: RunParams, topic: string): Promise<void>;
  retryGeneration(): Promise<void>;
  cancelGeneration(): Promise<void>;
  /** 任务中心：按 runId 取消（queued 出队 / running abort），与 generation 解耦。 */
  cancelRun(runId: string): Promise<void>;
  /** 任务中心：按 runId 重试（host 复用 paramsSnapshot 重新入队）。 */
  retryRun(runId: string): Promise<void>;
  setGenerationOverlay(open: boolean): void;
  activeRun: SnapshotResponse['runs'][number] | undefined;
  /** 全部排队中/运行中的 run（来自 snapshot.runs，面板重载后可恢复）。 */
  activeRuns: SnapshotResponse['runs'];
  narrow: boolean;
}

const StoreContext = createContext<WewriteStore | null>(null);

export function useStore(): WewriteStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore 必须在 WewriteProvider 内使用');
  return store;
}

export function WewriteProvider({ rpc, t, narrow, children }: { rpc: WewriteRpc; t: Translate; narrow: boolean; children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ kind: 'home' });
  const [snapshot, setSnapshot] = useState<SnapshotState>({ status: 'loading' });
  const [toastMessages, setToastMessages] = useState<readonly ToastMessage[]>([]);
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [queue, setQueue] = useState<readonly QueuedGeneration[]>([]);
  const queueSeq = useRef(0);
  const autoStartedRun = useRef<string | null>(null);
  const toastSeq = useRef(0);
  const lastGenerationParams = useRef<{ params: RunParams; topic: string } | null>(null);

  const dismissToast = useCallback((id: number) => {
    setToastMessages((messages) => messages.filter((message) => message.id !== id));
  }, []);

  const toast = useMemo<ToastApi>(
    () => ({
      push(message) {
        toastSeq.current += 1;
        const id = toastSeq.current;
        setToastMessages((messages) => [...messages.slice(-3), { ...message, id }]);
      },
      dismiss: dismissToast,
    }),
    [dismissToast],
  );

  const refreshSnapshot = useCallback(async () => {
    try {
      const data = await rpc.call<SnapshotResponse>('snapshot', {});
      setSnapshot({ status: 'ready', data });
    } catch (error) {
      setSnapshot({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [rpc]);

  // v0.2：旧 /articles 路由一律重写为 home（delta §1-8 兼容壳，老书签不断）。
  const navigate = useCallback((next: Route) => setRoute(normalizeRoute(next)), []);

  const startGeneration = useCallback(
    async (params: RunParams, topic: string, options?: { background?: boolean }) => {
      try {
        const { runId } = await rpc.call<{ runId: string }>('run/start', { params });
        lastGenerationParams.current = { params, topic };
        // 弹层确认后直接转后台：不打开全屏生成视图，只在右下进度卡展示。
        setGeneration({ runId, topic, overlayOpen: options?.background !== true });
        void refreshSnapshot();
      } catch (error) {
        toast.push({
          kind: 'error',
          title: '未能启动生成',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [rpc, refreshSnapshot, toast],
  );

  /** 排队：当前任务终态后由下方 effect 自动开始队首。 */
  const enqueueGeneration = useCallback(
    (params: RunParams, topic: string) => {
      queueSeq.current += 1;
      setQueue((items) => [...items, { id: queueSeq.current, params, topic }]);
      toast.push({
        kind: 'info',
        title: '已加入生成队列',
        detail: `《${topic}》会在当前任务结束后自动开始。`,
      });
    },
    [toast],
  );

  /** 替换：取消当前 run（已终态则忽略）后立即开始新任务；已排队任务保留。 */
  const replaceGeneration = useCallback(
    async (params: RunParams, topic: string) => {
      const current = generation;
      if (current) {
        try {
          await rpc.call<{ ok: boolean }>('run/cancel', { runId: current.runId });
        } catch {
          // 当前 run 可能刚好终态/已被宿主清理：替换仍按新任务继续。
        }
      }
      await startGeneration(params, topic, { background: true });
    },
    [generation, rpc, startGeneration],
  );

  const retryGeneration = useCallback(async () => {
    const last = lastGenerationParams.current;
    if (!last) return;
    await startGeneration(last.params, last.topic, { background: true });
  }, [startGeneration]);

  const cancelGeneration = useCallback(async () => {
    const current = generation;
    if (!current) return;
    try {
      await rpc.call<{ ok: boolean }>('run/cancel', { runId: current.runId });
    } catch (error) {
      toast.push({ kind: 'error', title: '取消失败', detail: error instanceof Error ? error.message : String(error) });
      void refreshSnapshot();
      return;
    }
    toast.push({ kind: 'info', title: '已取消生成' });
    setGeneration(null);
    // 手动取消后队列继续：立即开始队首（后台进度，不弹全屏）。
    const next = queue[0];
    if (next) {
      setQueue((items) => items.slice(1));
      void startGeneration(next.params, next.topic, { background: true });
    }
    void refreshSnapshot();
  }, [generation, queue, rpc, refreshSnapshot, startGeneration, toast]);

  const setGenerationOverlay = useCallback((open: boolean) => {
    setGeneration((current) => (current ? { ...current, overlayOpen: open } : current));
  }, []);

  /** 任务中心：按 runId 取消；若取消的是当前主任务则收起全屏/卡片（不动前端排队队列）。 */
  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        await rpc.call<{ ok: boolean }>('run/cancel', { runId });
        setGeneration((current) => (current?.runId === runId ? null : current));
        toast.push({ kind: 'info', title: '已取消任务' });
      } catch (error) {
        toast.push({ kind: 'error', title: '取消失败', detail: error instanceof Error ? error.message : String(error) });
      }
      void refreshSnapshot();
    },
    [rpc, refreshSnapshot, toast],
  );

  /** 任务中心：按 runId 重试；新 run 成为主任务（不重新弹全屏确认）。 */
  const retryRun = useCallback(
    async (runId: string) => {
      try {
        const { runId: nextRunId } = await rpc.call<{ runId: string }>('run/retry', { runId });
        const source = snapshot.status === 'ready' ? snapshot.data.runs.find((run) => run.id === runId) : undefined;
        setGeneration({ runId: nextRunId, topic: source?.topic || '未命名任务', overlayOpen: false });
        toast.push({ kind: 'info', title: '已重新排队', detail: source?.topic });
        void refreshSnapshot();
      } catch (error) {
        toast.push({ kind: 'error', title: '重试失败', detail: error instanceof Error ? error.message : String(error) });
      }
    },
    [rpc, refreshSnapshot, snapshot, toast],
  );

  const activeRun = useMemo(() => {
    if (snapshot.status !== 'ready' || !generation) return undefined;
    return snapshot.data.runs.find((run) => run.id === generation.runId);
  }, [snapshot, generation]);

  /** 任务中心数据源：所有 queued/running run（面板重载后仍可从 snapshot 恢复）。 */
  const activeRuns = useMemo<SnapshotResponse['runs']>(() => {
    if (snapshot.status !== 'ready') return [];
    return snapshot.data.runs.filter((run) => run.status === 'queued' || run.status === 'running');
  }, [snapshot]);

  // 当前 run 到终态后自动开始队首任务（后台启动，不弹全屏）；autoStartedRun 防同一终态重复触发。
  useEffect(() => {
    if (!generation || queue.length === 0) return;
    if (autoStartedRun.current === generation.runId) return;
    if (snapshot.status !== 'ready') return;
    const run = snapshot.data.runs.find((item) => item.id === generation.runId);
    if (!run) return;
    if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'interrupted') return;
    const next = queue[0];
    if (!next) return;
    autoStartedRun.current = generation.runId;
    setQueue((items) => items.slice(1));
    void startGeneration(next.params, next.topic, { background: true });
  }, [generation, queue, snapshot, startGeneration]);

  const value = useMemo<WewriteStore>(
    () => ({
      rpc,
      t,
      route,
      navigate,
      snapshot,
      refreshSnapshot,
      toast,
      toastMessages,
      dismissToast,
      generation,
      queue,
      startGeneration,
      enqueueGeneration,
      replaceGeneration,
      retryGeneration,
      cancelGeneration,
      cancelRun,
      retryRun,
      setGenerationOverlay,
      activeRun,
      activeRuns,
      narrow,
    }),
    [
      rpc,
      t,
      route,
      navigate,
      snapshot,
      refreshSnapshot,
      toast,
      toastMessages,
      dismissToast,
      generation,
      queue,
      startGeneration,
      enqueueGeneration,
      replaceGeneration,
      retryGeneration,
      cancelGeneration,
      cancelRun,
      retryRun,
      setGenerationOverlay,
      activeRun,
      activeRuns,
      narrow,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
