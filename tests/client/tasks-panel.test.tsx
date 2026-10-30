// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TasksPanel } from '@/client/panels/tasks-panel';

/**
 * 任务中心（TasksPanel）交互面：
 * - 三段分组：运行中 / 排队中 / 最近完成；
 * - 来源标注：手动 / 定时 / 聊天；
 * - 取消/重试按 runId 调用 store；
 * - 详情展开按需 run/detail 并渲染六步。
 */

const mocks = vi.hoisted(() => {
  const runs = [
    {
      id: 'run_running',
      trigger: 'manual' as const,
      status: 'running' as const,
      topic: '运行中的主题',
      startedAt: '2026-10-30T02:00:00.000Z',
    },
    {
      id: 'run_queued',
      trigger: 'schedule' as const,
      status: 'queued' as const,
      topic: '排队中的主题',
      startedAt: '2026-10-30T02:01:00.000Z',
    },
    {
      id: 'run_failed',
      trigger: 'chat' as const,
      status: 'failed' as const,
      topic: '失败的主题',
      startedAt: '2026-10-30T01:00:00.000Z',
      finishedAt: '2026-10-30T01:03:00.000Z',
      error: { code: 'gates-failed', message: '质量门禁未通过' },
    },
  ];
  const state = {
    snapshot: { status: 'ready' as const, data: { runs } },
    refreshSnapshot: vi.fn(async () => {}),
    rpc: { call: vi.fn(async () => ({})) },
    toast: { push: vi.fn() },
    t: (key: string) => key,
    cancelRun: vi.fn(async () => {}),
    retryRun: vi.fn(async () => {}),
    navigate: vi.fn(),
  };
  return { runs, state };
});

vi.mock('@/client/store', () => ({
  useStore: () => mocks.state,
}));

// 宿主 UI primitives 的导入链带 katex CSS（node 环境 vitest 装不进），Button/StateDot 换轻量替身。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { icon: _icon, variant: _variant, size: _size, ...rest } = props;
    return <button type="button" {...rest}>{props.children}</button>;
  },
  StateDot: (props: Record<string, unknown>) => <span data-state-dot {...props} />,
}));

const user = userEvent.setup();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TasksPanel：分组 / 来源 / 操作', () => {
  it('三段分组与手动/定时/聊天来源标签同页可见', () => {
    render(<TasksPanel />);

    expect(screen.getByText('运行中（1）')).toBeTruthy();
    expect(screen.getByText('排队中（1）')).toBeTruthy();
    expect(screen.getByText('最近完成（1）')).toBeTruthy();
    expect(screen.getByText('《运行中的主题》')).toBeTruthy();
    expect(screen.getByText('《排队中的主题》')).toBeTruthy();
    expect(screen.getByText('手动')).toBeTruthy();
    expect(screen.getByText('定时')).toBeTruthy();
    expect(screen.getByText('聊天')).toBeTruthy();
  });

  it('取消与重试按 runId 调用 store', async () => {
    render(<TasksPanel />);

    await user.click(screen.getByTestId('ww-task-cancel-run_running'));
    expect(mocks.state.cancelRun).toHaveBeenCalledWith('run_running');

    await user.click(screen.getByTestId('ww-task-retry-run_failed'));
    expect(mocks.state.retryRun).toHaveBeenCalledWith('run_failed');
  });

  it('展开详情按需调用 run/detail 并渲染六步', async () => {
    mocks.state.rpc.call.mockResolvedValueOnce({
      id: 'run_failed',
      trigger: 'chat',
      status: 'failed',
      topic: '失败的主题',
      startedAt: '2026-10-30T01:00:00.000Z',
      finishedAt: '2026-10-30T01:03:00.000Z',
      error: { code: 'gates-failed', message: '质量门禁未通过' },
      steps: [
        { name: 'topic', status: 'succeeded' },
        { name: 'draft', status: 'failed', error: { code: 'gates-failed', message: '门禁未过' } },
      ],
    });
    render(<TasksPanel />);

    await user.click(screen.getByTestId('ww-task-detail-run_failed'));

    await waitFor(() => expect(mocks.state.rpc.call).toHaveBeenCalledWith('run/detail', { runId: 'run_failed' }));
    expect(await screen.findByText('初稿写作')).toBeTruthy();
    expect(screen.getByText('选题分析')).toBeTruthy();
    expect(screen.getByText('门禁未过')).toBeTruthy();
  });
});
