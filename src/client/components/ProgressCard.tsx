import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useStore } from '../store';
import { Icon } from './Icon';
import { PipelineStepper } from './PipelineStepper';

/**
 * 右下角进度卡（ProgressCard，uiux-workbench-delta §1-5，L3 去全屏化）：
 * 首次提交短暂全屏确认（GenerationLayer）收起/转后台后本卡出现并常驻；
 * bottom = 96 + 48 = 144px 与 Toast 线（96px）垂直错开；收起后顶栏 ProgressDot 仍是常驻锚点。
 * 卡体复用 PipelineStepper 紧凑档（只渲染阶段列表，头/脚由本卡提供）。
 *
 * 恢复语义（任务中心）：面板重载后内存 generation 丢失，此时回落到 snapshot.runs 里
 * 最新的活跃 run（activeRuns[0]），保证进行中的任务仍可见、可取消。
 */

export function ProgressCard({ open, onCollapse }: { open: boolean; onCollapse: () => void }) {
  const store = useStore();
  const { generation, activeRun, retryRun, cancelGeneration, cancelRun, queue, activeRuns, navigate } = store;

  if (!open) return null;
  // 主任务优先；无 generation（重载/重开浮层）时回落到最新的活跃 run。
  const run = generation ? activeRun : activeRuns[0];
  if (!run) return null;

  // 终态语义（delta §1-5）：succeeded/cancelled/interrupted 交 Toast（卡消失）；
  // failed 保留卡片供「重试」，直到用户收起或重试产生新 run。
  const active = run.status === 'queued' || run.status === 'running';
  const failed = run.status === 'failed';
  if (!active && !failed) return null;

  const topic = generation?.topic || run.topic || '未命名任务';
  const otherTaskCount = activeRuns.filter((item) => item.id !== run.id).length;

  return (
    <aside
      className="ww-progress-card"
      role="region"
      aria-label="生成进度"
      data-testid="ww-progress-card"
      id="ww-progress-card"
    >
      <div className="ww-progress-card__head">
        <Icon name="loader-circle" size={16} className="ww-progress-card__state" />
        <span className="ww-progress-card__topic" title={topic}>{topic}</span>
        {queue.length > 0 ? (
          <span className="ww-progress-card__queue" data-testid="ww-progress-card-queue">排队 {queue.length}</span>
        ) : null}
        <button
          type="button"
          className="ww-progress-card__collapse"
          data-testid="ww-progress-card-collapse"
          aria-label="收起进度卡片"
          onClick={onCollapse}
        >
          <Icon name="x" size={20} />
        </button>
      </div>
      <div className="ww-progress-card__body">
        <PipelineStepper run={run} topic={topic} compact />
        {failed && run.error ? <p className="ww-progress-card__error">{run.error.message}</p> : null}
      </div>
      <div className="ww-progress-card__foot">
        {failed ? (
          <Button variant="ghost" size="sm" icon={<Icon name="rotate-ccw" size={16} />} onClick={() => void retryRun(run.id)}>
            重试
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="ww-danger-ghost"
            data-testid="ww-progress-card-cancel"
            icon={<Icon name="x" size={16} />}
            onClick={() => (generation ? void cancelGeneration() : void cancelRun(run.id))}
          >
            取消生成
          </Button>
        )}
        {otherTaskCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="ww-progress-card-tasks"
            icon={<Icon name="list-todo" size={16} />}
            onClick={() => navigate({ kind: 'tasks' })}
          >
            另有 {otherTaskCount} 个任务
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
