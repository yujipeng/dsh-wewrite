// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopicConfirmDialog, type TopicDraft } from '@/client/components/TopicConfirmDialog';

/**
 * 选题确认弹层：
 * - 展示标题/推荐角度/来源/原文链接 + hotspots/analyze 的简介与分析角度
 * - 无进行中任务：确认 → startGeneration(background) 并关闭
 * - 有进行中任务：替换当前任务 / 排队生成新任务
 * - 分析失败不阻断确认
 */

const mocks = vi.hoisted(() => ({
  call: vi.fn(async (_endpoint: string, _payload?: unknown): Promise<unknown> => undefined),
  startGeneration: vi.fn(async (_params: Record<string, unknown>, _topic: string, _options?: Record<string, unknown>) => {}),
  enqueueGeneration: vi.fn(),
  replaceGeneration: vi.fn(async (_params: Record<string, unknown>, _topic: string) => {}),
  navigate: vi.fn(),
  generation: null as { topic: string; runId: string } | null,
  activeRun: undefined as { status: string } | undefined,
}));

const ZH: Record<string, string> = { 'action.retry': '重试', 'action.writeThis': '写这个' };

vi.mock('@/client/store', () => ({
  useStore: () => ({
    rpc: { call: mocks.call },
    t: (key: string) => ZH[key] ?? key,
    generation: mocks.generation,
    activeRun: mocks.activeRun,
    startGeneration: mocks.startGeneration,
    enqueueGeneration: mocks.enqueueGeneration,
    replaceGeneration: mocks.replaceGeneration,
    navigate: mocks.navigate,
  }),
}));

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { icon: _icon, variant: _variant, size: _size, className: _className, ...rest } = props;
    return <button type="button" {...rest}>{props.children}</button>;
  },
  Modal: ({ open, title, children, footer }: { open?: boolean; title?: string; children?: ReactNode; footer?: ReactNode }) =>
    open === false ? null : (
      <div data-testid="modal">
        <h2>{title}</h2>
        {children}
        <div data-testid="modal-footer">{footer}</div>
      </div>
    ),
}));

vi.mock('@/client/components/Icon', () => ({
  Icon: ({ name }: { name?: string }) => <span data-icon={name} />,
}));

vi.mock('@/client/components/bits', () => ({
  SkeletonBlock: () => <div data-testid="skeleton" />,
  ErrorNote: ({ title, hint, action }: { title?: string; hint?: string; action?: ReactNode }) => (
    <div data-testid="error-note">
      <p>{title}</p>
      {hint ? <p>{hint}</p> : null}
      {action}
    </div>
  ),
}));

const analysisOk = () => ({
  digest: '这条在讲什么：AI 简介。\n· 要点：成本降到三成',
  angles: ['角度一：从成本结构切入', '角度二：对比闭源方案'],
  source: 'article',
  model: 'glm-4.5-flash',
  generatedAtIso: new Date().toISOString(),
});

const hotspotDraft: TopicDraft = {
  kind: 'hotspot',
  title: '某热点',
  source: 'weibo',
  sourceRank: 3,
  sourceTitle: '某热点原标题',
  sourceUrl: 'https://s.weibo.com/weibo?q=1',
};

const suggestedDraft: TopicDraft = {
  kind: 'suggested',
  title: '建议标题',
  angle: '测试角度',
  source: 'weibo',
  sourceRank: 5,
  sourceTitle: '来源热点',
  sourceUrl: 'https://s.weibo.com/weibo?q=5',
};

const user = userEvent.setup();

beforeEach(() => {
  vi.clearAllMocks();
  // vitest/jsdom 组合下 window.localStorage 可能不可用（Node 未提供 --localstorage-file）；
  // 组件内读写都做了 try/catch 降级，这里同样容错。
  try {
    window.localStorage?.clear();
  } catch {
    /* localStorage 不可用 */
  }
  mocks.generation = null;
  mocks.activeRun = undefined;
  mocks.call.mockImplementation(async () => analysisOk());
});

describe('TopicConfirmDialog', () => {
  it('展示标题、来源、原文链接与来自热门榜速览的内容/分析角度', async () => {
    render(<TopicConfirmDialog draft={hotspotDraft} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/AI 简介/)).toBeTruthy());
    expect(screen.getByText('某热点')).toBeTruthy();
    expect(screen.getByText('角度一：从成本结构切入')).toBeTruthy();
    expect(screen.getByText('角度二：对比闭源方案')).toBeTruthy();
    expect(screen.getByRole('link', { name: /打开原文/ }).getAttribute('href')).toBe(hotspotDraft.sourceUrl);
    expect(mocks.call).toHaveBeenCalledWith('hotspots/digestItem', {
      rank: hotspotDraft.sourceRank,
      title: hotspotDraft.sourceTitle,
      url: hotspotDraft.sourceUrl,
    });
  });

  it('无进行中任务：确认写这个 → 后台启动并关闭', async () => {
    const onClose = vi.fn();
    render(<TopicConfirmDialog draft={hotspotDraft} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/AI 简介/)).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '确认写这个' }));

    expect(mocks.startGeneration).toHaveBeenCalledWith(
      { topicMode: 'fixed', topic: '某热点' },
      '某热点',
      { background: true },
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('建议选题：展示推荐角度，确认时带 brief.title', async () => {
    render(<TopicConfirmDialog draft={suggestedDraft} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/AI 简介/)).toBeTruthy());
    expect(screen.getByText('推荐角度')).toBeTruthy();
    expect(screen.getByText('测试角度')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '确认写这个' }));

    expect(mocks.startGeneration).toHaveBeenCalledWith(
      { topicMode: 'fixed', topic: '建议标题', brief: { title: '建议标题' } },
      '建议标题',
      { background: true },
    );
  });

  it('已有进行中任务：显示冲突提示，排队走 enqueueGeneration', async () => {
    mocks.generation = { topic: '当前任务', runId: 'run_1' };
    mocks.activeRun = { status: 'running' };
    const onClose = vi.fn();

    render(<TopicConfirmDialog draft={hotspotDraft} onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '排队生成新任务' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '排队生成新任务' }));

    expect(mocks.enqueueGeneration).toHaveBeenCalledWith({ topicMode: 'fixed', topic: '某热点' }, '某热点');
    expect(mocks.startGeneration).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('已有进行中任务：替换走 replaceGeneration', async () => {
    mocks.generation = { topic: '当前任务', runId: 'run_1' };
    mocks.activeRun = { status: 'queued' };

    render(<TopicConfirmDialog draft={hotspotDraft} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '替换当前任务' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '替换当前任务' }));

    expect(mocks.replaceGeneration).toHaveBeenCalledWith({ topicMode: 'fixed', topic: '某热点' }, '某热点');
  });

  it('分析失败：显示可行动提示，但不阻断确认', async () => {
    mocks.call.mockImplementation(async () => {
      throw new Error('[internal] [llm-not-configured] 尚未配置默认模型');
    });

    render(<TopicConfirmDialog draft={hotspotDraft} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('生成分析需要先配置模型。')).toBeTruthy());
    expect(screen.getByRole('button', { name: '确认写这个' })).toBeTruthy();
  });
});
