import { useMemo, useState } from 'react';
import { Button, Input, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import { buildRrule, describeRrule, parseRruleForm } from '../lib/format';
import { CodeChip } from './bits';
import { Icon, type IconName } from './Icon';

/**
 * 新建/改期定时任务弹层（DESIGN §9.5 Modal）：
 * 任务类型（草稿箱 / 生成文章 / 选题）→ 计划（时刻 + 重复 + RRULE 预览）→ 内容摘要。
 * 发布目标始终不含群发；类型说明与字段按选择动态切换。
 */

export type ScheduleFormAction = 'draft' | 'article' | 'topics';

export interface ScheduleFormRequest {
  id?: string;
  name: string;
  action: ScheduleFormAction;
  topicCount?: number;
  rrule: string;
  timeZone: string;
}

export interface ScheduleFormInitial {
  /** 存在时为改期模式（schedule/save 回传 id 触发 revision++）。 */
  id?: string;
  /** 预填任务名（编辑器入口 = 文章标题）。 */
  name: string;
  action?: ScheduleFormAction;
  topicCount?: number;
  /** 预填重复规则；缺省用 每天 09:30。 */
  rrule?: string;
}

const WEEKDAYS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'MO', label: '周一' },
  { id: 'TU', label: '周二' },
  { id: 'WE', label: '周三' },
  { id: 'TH', label: '周四' },
  { id: 'FR', label: '周五' },
  { id: 'SA', label: '周六' },
  { id: 'SU', label: '周日' },
];

const ACTIONS: ReadonlyArray<{
  id: ScheduleFormAction;
  label: string;
  desc: string;
  icon: IconName;
  summary: string;
}> = [
  {
    id: 'draft',
    label: '定时到草稿箱',
    desc: '跑管线生成文章，并自动推送到公众号草稿箱',
    icon: 'send',
    summary: '执行成功后自动推送草稿箱；推送失败只记日志，文章保留在写作台可手动重推。',
  },
  {
    id: 'article',
    label: '定时生成文章',
    desc: '只生成并保存到写作台，不调用微信接口',
    icon: 'inbox',
    summary: '只落本地文章，不触碰微信接口；适合先把稿子攒起来再人工挑选。',
  },
  {
    id: 'topics',
    label: '定时选题',
    desc: '抓热榜 + AI 速览，候选保存到选题页',
    icon: 'flame',
    summary: '只抓热榜并生成速览，不写正文、不推送；候选在选题页展示。',
  },
];

export function ScheduleForm({
  open,
  initial,
  submitLabel,
  busy,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial?: ScheduleFormInitial;
  submitLabel: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (request: ScheduleFormRequest) => void;
}) {
  const parsed = initial?.rrule ? parseRruleForm(initial.rrule) : undefined;
  const [name, setName] = useState(initial?.name ?? '');
  const [action, setAction] = useState<ScheduleFormAction>(initial?.action ?? 'draft');
  const [topicCount, setTopicCount] = useState(initial?.topicCount ?? 3);
  const [hour, setHour] = useState(parsed?.hour ?? 9);
  const [minute, setMinute] = useState(parsed?.minute ?? 30);
  const [repeat, setRepeat] = useState<'once' | 'daily' | 'weekly'>(parsed?.repeat ?? 'daily');
  const [weekday, setWeekday] = useState(parsed?.weekday ?? 'MO');

  const rrule = useMemo(() => buildRrule(repeat, weekday, hour, minute), [repeat, weekday, hour, minute]);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const nameInvalid = name.trim().length === 0;
  const selectedAction = ACTIONS.find((item) => item.id === action) ?? ACTIONS[0];

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={initial?.id ? `改期：${initial.name}` : '新建定时任务'}
      closeLabel="取消"
      description="按计划自动执行 WeWrite 任务；发布目标始终不含群发。"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            className="ww-btn-accent"
            onClick={() =>
              onSubmit({
                id: initial?.id,
                name: name.trim(),
                action,
                ...(action === 'topics' ? { topicCount } : {}),
                rrule,
                timeZone,
              })
            }
            disabled={busy || nameInvalid}
          >
            {busy ? '保存中…' : submitLabel}
          </Button>
        </>
      }
    >
      <div className="ww-schedule-form">
        <section className="ww-schedule-form__group">
          <span className="ww-schedule-form__group-title">任务类型</span>
          <div className="ww-type-grid" role="radiogroup" aria-label="任务类型">
            {ACTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={action === option.id}
                className={action === option.id ? 'ww-type-card ww-type-card--active' : 'ww-type-card'}
                onClick={() => setAction(option.id)}
              >
                <Icon name={option.icon} size={18} />
                <span className="ww-type-card__label">{option.label}</span>
                <span className="ww-type-card__desc">{option.desc}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="ww-schedule-form__group">
          <span className="ww-schedule-form__group-title">计划</span>
          <label className="ww-field">
            <span className="ww-field__label">任务名</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="如：每日早四点" aria-label="任务名" />
          </label>
          <div className="ww-schedule-form__plan">
            <label className="ww-field ww-field--time">
              <span className="ww-field__label">时刻</span>
              <Input
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(event) => setHour(clamp(parseInt(event.target.value, 10), 0, 23))}
                aria-label="小时"
              />
              <span className="ww-field__colon">:</span>
              <Input
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(event) => setMinute(clamp(parseInt(event.target.value, 10), 0, 59))}
                aria-label="分钟"
              />
            </label>
            <div className="ww-field">
              <span className="ww-field__label">重复</span>
              <div className="ww-field__pills" role="radiogroup" aria-label="重复规则">
                <Pill active={repeat === 'once'} onClick={() => setRepeat('once')}>一次</Pill>
                <Pill active={repeat === 'daily'} onClick={() => setRepeat('daily')}>每天</Pill>
                <Pill active={repeat === 'weekly'} onClick={() => setRepeat('weekly')}>每周</Pill>
              </div>
            </div>
          </div>
          {repeat === 'weekly' ? (
            <div className="ww-field__pills" role="radiogroup" aria-label="星期">
              {WEEKDAYS.map((day) => (
                <Pill key={day.id} active={weekday === day.id} onClick={() => setWeekday(day.id)}>
                  {day.label}
                </Pill>
              ))}
            </div>
          ) : null}
          <div className="ww-rrule-preview">
            <span className="ww-rrule-preview__label">
              <Icon name="calendar-clock" size={16} /> {describeRrule(rrule)}
            </span>
            <details className="ww-rrule-details">
              <summary>RRULE</summary>
              <CodeChip>{rrule}</CodeChip>
            </details>
          </div>
        </section>

        <section className="ww-schedule-form__group">
          <span className="ww-schedule-form__group-title">内容</span>
          {action === 'topics' ? (
            <label className="ww-field">
              <span className="ww-field__label">
                候选数量 <span className="ww-field__hint">1–10，默认 3</span>
              </span>
              <Input
                type="number"
                min={1}
                max={10}
                value={topicCount}
                onChange={(event) => setTopicCount(clamp(parseInt(event.target.value, 10), 1, 10))}
                aria-label="候选数量"
              />
            </label>
          ) : (
            <p className="ww-field-note">主题来源：热榜第 1 条（每次自动取当前榜首）。</p>
          )}
          <p className="ww-schedule-form__summary">{selectedAction.summary}</p>
        </section>
      </div>
    </Modal>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
