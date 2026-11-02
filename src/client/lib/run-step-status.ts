import type { StepView } from '@/shared/view-schemas';

/**
 * 任务详情步骤状态文案：images / source 步 succeeded 但带 metrics.skipped 时，
 * 说明对应动作没有真的执行（未请求配图/未提供来源），不能显示成普通成功。
 */
export function stepStatusText(step: StepView): string {
  if (step.status === 'succeeded') {
    const skipped = step.metrics?.skipped;
    if (typeof skipped === 'string' && skipped.length > 0) {
      if (step.name === 'images') {
        if (skipped.includes('imageCount=0')) return '已跳过（未请求配图）';
        if (skipped.includes('cost-limit')) return '已跳过（超出配图预算）';
        return `已跳过（${skipped}）`;
      }
      if (step.name === 'source') {
        if (skipped === 'no-source') return '已跳过（未提供来源）';
        return `已跳过（${skipped}）`;
      }
    }
  }
  return step.status;
}
