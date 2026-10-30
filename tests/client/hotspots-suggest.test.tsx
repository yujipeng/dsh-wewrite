// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotspotsPanel } from '@/client/panels/hotspots-panel';

/**
 * 选题中心「建议选题」栏目：
 * - 进入页面自动请求 hotspots/suggest（count=10），渲染 10 条标题/角度/来源
 * - 点击建议以 fixed + brief.title 启动生成
 * - 未配置模型 / 写作要求缺失两条提示路径
 * - 刷新按钮带 refresh:true 绕过 host 缓存
 */

const mocks = vi.hoisted(() => ({
  call: vi.fn(async (_endpoint: string, _payload?: unknown): Promise<unknown> => undefined),
  startGeneration: vi.fn(async (_params: Record<string, unknown>, _topic: string) => {}),
  navigate: vi.fn(),
  push: vi.fn(),
}));

const ZH: Record<string, string> = {
  'action.goSettings': '去设置',
  'action.retry': '重试',
  'action.refresh': '刷新',
  'action.writeThis': '写这个',
};

vi.mock('@/client/store', () => ({
  useStore: () => ({
    rpc: { call: mocks.call },
    navigate: mocks.navigate,
    startGeneration: mocks.startGeneration,
    toast: { push: mocks.push },
    snapshot: { status: 'ready' as const, data: { topicCandidates: [] } },
    narrow: false,
    t: (key: string) => ZH[key] ?? key,
  }),
}));

// 宿主 primitives 的导入链带 katex CSS（jsdom 装不进），换轻量替身。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { icon: _icon, variant: _variant, size: _size, ...rest } = props;
    return <button type="button" {...rest}>{props.children}</button>;
  },
  Input: () => <input />,
  Pill: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/client/components/Icon', () => ({
  Icon: ({ name }: { name?: string }) => <span data-icon={name} />,
}));

vi.mock('@/client/components/bits', () => ({
  SkeletonRow: () => <div data-testid="skeleton" />,
  ErrorNote: ({ title, hint, action }: { title?: string; hint?: string; action?: ReactNode }) => (
    <div data-testid="error-note">
      <p>{title}</p>
      {hint ? <p>{hint}</p> : null}
      {action}
    </div>
  ),
  EmptyState: ({ title }: { title?: string }) => <div>{title}</div>,
}));

vi.mock('@/client/components/HotspotItemDigest', () => ({ HotspotItemDigest: () => null }));

// 确认弹层单独测试（tests/client/topic-confirm-dialog.test.tsx）；这里只验证入口会打开它。
vi.mock('@/client/components/TopicConfirmDialog', () => ({
  TopicConfirmDialog: ({ draft, onClose }: { draft: { title: string; kind: string }; onClose: () => void }) => (
    <div data-testid="topic-dialog" data-kind={draft.kind}>
      <span>{draft.title}</span>
      <button type="button" onClick={onClose}>关闭弹层</button>
    </div>
  ),
}));

const fetchResponse = (items: unknown[] = [], batchId = 'hb_test_001') => ({
  items,
  batchId,
  fetchedAtIso: '2026-08-20T12:00:00.000Z',
});

const suggestedResponse = (profileUsed = true) => ({
  topics: Array.from({ length: 10 }, (_, index) => ({
    title: `建议标题${index + 1}`,
    angle: `角度${index + 1}`,
    source: 'weibo',
    sourceRank: index + 1,
    sourceTitle: `热点${index + 1}`,
    sourceUrl: `https://s.weibo.com/weibo?q=${index + 1}`,
    ...(index === 0
      ? {
          heat: 9,
          relevance: 8,
          value: 7,
          score: 8.2,
          reason: '推荐理由一',
          sourceType: 'hot',
          historyMark: '近 7 天已写：旧文',
        }
      : {}),
  })),
  generatedAtIso: '2026-08-20T12:00:00.000Z',
  model: 'glm-4.5-flash',
  profileUsed,
  totalHotspots: 30,
  batchId: 'hb_test_001',
  recommendations: ['建议标题1', '建议标题2', '建议标题3'],
  excluded: ['被排除热点'],
});

const suggestCalls = () => mocks.call.mock.calls.filter(([endpoint]) => endpoint === 'hotspots/suggest');

const user = userEvent.setup();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.call.mockImplementation(async (endpoint: string) => {
    if (endpoint === 'hotspots/fetch') return fetchResponse();
    if (endpoint === 'hotspots/suggest') return suggestedResponse();
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
});

describe('HotspotsPanel 建议选题', () => {
  it('进入页面自动请求 count=10，并渲染 10 条建议（标题/角度/来源）', async () => {
    render(<HotspotsPanel />);

    await waitFor(() => expect(screen.getByText('建议标题1')).toBeTruthy());

    expect(screen.getAllByRole('button', { name: /^写这个：/ })).toHaveLength(10);
    expect(screen.getByText('源自 微博 #1 · 热点1')).toBeTruthy();
    expect(screen.getAllByTestId('ww-suggest-rec')[0]?.textContent).toBe('首选');
    expect(screen.getByTestId('ww-suggest-type').textContent).toBe('热点');
    expect(screen.getByTestId('ww-suggest-score').textContent).toBe('8.2');
    expect(screen.getByTestId('ww-suggest-history').textContent).toBe('近 7 天已写：旧文');
    expect(screen.getByTestId('ww-suggest-excluded').textContent).toContain('被排除热点');
    expect(suggestCalls()[0]?.[1]).toEqual({ count: 10 });
  });

  it('点击建议：先打开确认弹层，不直接启动生成', async () => {
    render(<HotspotsPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: '写这个：建议标题1' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '写这个：建议标题1' }));

    expect(screen.getByTestId('topic-dialog').getAttribute('data-kind')).toBe('suggested');
    expect(mocks.startGeneration).not.toHaveBeenCalled();
  });

  it('点击热点「写这个」：同样先打开确认弹层', async () => {
    mocks.call.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'hotspots/fetch') return fetchResponse([{ title: '热点 1', source: 'weibo', rank: 1, url: 'https://x.test/1' }]);
      if (endpoint === 'hotspots/suggest') return suggestedResponse();
      if (endpoint === 'hotspots/digestItem') {
        return { digest: '这条在讲什么：测试热点。', angles: [], source: 'article', model: 'glm-4.5-flash', generatedAtIso: '2026-08-20T12:00:00.000Z' };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    render(<HotspotsPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: '写这个：热点 1' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '写这个：热点 1' }));

    expect(screen.getByTestId('topic-dialog').getAttribute('data-kind')).toBe('hotspot');
    expect(mocks.startGeneration).not.toHaveBeenCalled();
  });

  it('未配置模型：显示可行动提示并提供「去设置」入口', async () => {
    mocks.call.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'hotspots/fetch') return fetchResponse();
      throw new Error('[internal] [llm-not-configured] 尚未配置默认模型');
    });

    render(<HotspotsPanel />);

    await waitFor(() => expect(screen.getByText('生成建议选题需要先配置模型。')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '去设置' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'settings' });
  });

  it('写作要求缺失：profileUsed=false 时顶部显示补充提示与去设置动作', async () => {
    mocks.call.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'hotspots/fetch') return fetchResponse();
      if (endpoint === 'hotspots/suggest') return suggestedResponse(false);
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    render(<HotspotsPanel />);

    await waitFor(() => expect(screen.getByText(/还没有填写公众号写作要求/)).toBeTruthy());
  });

  it('刷新按钮：带 refresh:true 重新请求（绕过 host 缓存）', async () => {
    render(<HotspotsPanel />);
    await waitFor(() => expect(screen.getByText('建议标题1')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '重新生成建议选题' }));

    await waitFor(() => expect(suggestCalls()).toHaveLength(2));
    expect(suggestCalls()[1]?.[1]).toEqual({ count: 10, refresh: true });
  });

  it('热榜刷新：批次变化后自动重新生成建议（无需手动点建议区刷新）', async () => {
    let fetchCount = 0;
    mocks.call.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'hotspots/fetch') {
        fetchCount += 1;
        return fetchResponse([], `hb_batch_${fetchCount}`);
      }
      if (endpoint === 'hotspots/suggest') {
        return { ...suggestedResponse(), batchId: `hb_batch_${fetchCount || 1}` };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    render(<HotspotsPanel />);
    await waitFor(() => expect(screen.getByText('建议标题1')).toBeTruthy());
    expect(suggestCalls()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(suggestCalls()).toHaveLength(2));
    // 热榜触发的自动生成不带 refresh：新批次本身就是新的缓存 key。
    expect(suggestCalls()[1]?.[1]).toEqual({ count: 10 });
  });

  it('热榜刷新重新生成期间：保留上一批建议并提示更新中', async () => {
    let fetchCount = 0;
    let suggestCount = 0;
    let releaseSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    mocks.call.mockImplementation(async (endpoint: string) => {
      if (endpoint === 'hotspots/fetch') {
        fetchCount += 1;
        return fetchResponse([], `hb_batch_${fetchCount}`);
      }
      if (endpoint === 'hotspots/suggest') {
        suggestCount += 1;
        const batchId = `hb_batch_${fetchCount || 1}`;
        if (suggestCount === 1) return { ...suggestedResponse(), batchId };
        await second;
        return { ...suggestedResponse(), batchId };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    render(<HotspotsPanel />);
    await waitFor(() => expect(screen.getByText('建议标题1')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(screen.getByText('正在按最新热榜生成建议…')).toBeTruthy());
    // 旧结果不消失，避免骨架屏闪烁。
    expect(screen.getByText('建议标题1')).toBeTruthy();

    releaseSecond?.();
    await waitFor(() => expect(screen.queryByText('正在按最新热榜生成建议…')).toBeNull());
  });
});
