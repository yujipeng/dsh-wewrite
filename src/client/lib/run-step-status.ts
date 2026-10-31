import type { StepView } from '@/shared/view-schemas';

/**
 * 任务详情步骤状态文案：images 步 succeeded 但带 metrics.skipped 时，
 * 说明没有真的产图（未请求/预算跳过），不能显示成普通成功。
 */
export function stepStatusText(step: StepView): string {
  if (step.name === 'images' && step.status === 'succeeded') {
    const skipped = step.metrics?.skipped;
    if (typeof skipped === 'string' && skipped.length > 0) {
      if (skipped.includes('imageCount=0')) return '已跳过（未请求配图）';
      if (skipped.includes('cost-limit')) return '已跳过（超出配图预算）';
      return `已跳过（${skipped}）`;
    }
  }
  return step.status;
}
