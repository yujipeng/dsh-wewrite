import { useMemo, useState } from 'react';
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { buildRrule, describeRrule, parseRruleForm } from '../lib/format';
import { CodeChip } from './bits';
import { Icon, type IconName } from './Icon';

/**
 * 新建/改期定时任务弹层：
 * ① 任务类型（三张卡片）→ ② 计划（任务名 / 时刻 + 快捷时间 / 重复）→ ③ 内容。
 * 时间使用原生 time 选择器 + 常用时刻快捷 chip；重复规则用分段控件与星期 chip。
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
  id?: string;
  name: string;
  action?: ScheduleFormAction;
  topicCount?: number;
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

const REPEATS: ReadonlyArray<{ id: 'once' | 'daily' | 'weekly'; label: string; hint: string }> = [
  { id: 'once', label: '一次', hint: '只执行一次' },
  { id: 'daily', label: '每天', hint: '每天同一时刻' },
  { id: 'weekly', label: '每周', hint: '每周选定星期' },
];

const TIME_PRESETS = ['08:00', '09:00', '12:00', '18:00', '21:00'] as const;

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
    desc: '生成文章并自动推送',
    icon: 'send',
    summary: '执行成功后自动推送草稿箱；推送失败只记日志，文章保留在写作台可手动重推。',
  },
  {
    id: 'article',
    label: '定时生成文章',
    desc: '只落本地，不调微信',
    icon: 'inbox',
    summary: '只生成并保存到写作台，不触碰微信接口；适合先把稿子攒起来再人工挑选。',
  },
  {
    id: 'topics',
    label: '定时选题',
    desc: '抓热榜 + AI 速览',
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
  const timeValue = `${pad(hour)}:${pad(minute)}`;

  function setTime(value: string): void {
    const [nextHour, nextMinute] = value.split(':').map((part) => parseInt(part, 10));
    if (Number.isFinite(nextHour)) setHour(clamp(nextHour, 0, 23));
    if (Number.isFinite(nextMinute)) setMinute(clamp(nextMinute, 0, 59));
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      className="ww-modal"
      contentClassName="ww-schedule-form-scroll"
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
          <div className="ww-schedule-form__group-head">
            <span className="ww-schedule-form__group-index">1</span>
            <span className="ww-schedule-form__group-title">任务类型</span>
          </div>
          <div className="ww-type-list" role="radiogroup" aria-label="任务类型">
            {ACTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={action === option.id}
                className={action === option.id ? 'ww-type-option ww-type-option--active' : 'ww-type-option'}
                onClick={() => setAction(option.id)}
              >
                <span className="ww-type-option__icon">
                  <Icon name={option.icon} size={20} />
                </span>
                <span className="ww-type-option__body">
                  <span className="ww-type-option__label">{option.label}</span>
                  <span className="ww-type-option__desc">{option.desc}</span>
                </span>
                {action === option.id ? <Icon name="check" size={16} className="ww-type-option__check" /> : null}
              </button>
            ))}
          </div>
        </section>

        <section className="ww-schedule-form__group">
          <div className="ww-schedule-form__group-head">
            <span className="ww-schedule-form__group-index">2</span>
            <span className="ww-schedule-form__group-title">计划</span>
          </div>
          <label className="ww-field">
            <span className="ww-field__label">任务名</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="如：每日早四点" aria-label="任务名" />
          </label>

          <div className="ww-schedule-form__field">
            <span className="ww-field__label">时刻</span>
            <div className="ww-time-row">
              <input
                type="time"
                className="ww-time-input"
                value={timeValue}
                onChange={(event) => setTime(event.target.value)}
                aria-label="时刻"
              />
              <div className="ww-time-presets" role="group" aria-label="常用时刻">
                {TIME_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={preset === timeValue ? 'ww-time-preset ww-time-preset--active' : 'ww-time-preset'}
                    onClick={() => setTime(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="ww-schedule-form__field">
            <span className="ww-field__label">重复</span>
            <div className="ww-segmented" role="radiogroup" aria-label="重复规则">
              {REPEATS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={repeat === item.id}
                  className={repeat === item.id ? 'ww-segmented__item ww-segmented__item--active' : 'ww-segmented__item'}
                  onClick={() => setRepeat(item.id)}
                  title={item.hint}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {repeat === 'weekly' ? (
            <div className="ww-schedule-form__field">
              <span className="ww-field__label">星期</span>
              <div className="ww-day-chips" role="radiogroup" aria-label="星期">
                {WEEKDAYS.map((day) => (
                  <button
                    key={day.id}
                    type="button"
                    role="radio"
                    aria-checked={weekday === day.id}
                    className={weekday === day.id ? 'ww-day-chip ww-day-chip--active' : 'ww-day-chip'}
                    onClick={() => setWeekday(day.id)}
                  >
                    {day.label}
                  </button>
                ))}
              </div>
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
          <div className="ww-schedule-form__group-head">
            <span className="ww-schedule-form__group-index">3</span>
            <span className="ww-schedule-form__group-title">内容</span>
          </div>
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
          <div className="ww-schedule-target">
            <Icon name={selectedAction.icon} size={16} />
            <span>{selectedAction.summary}</span>
          </div>
        </section>
      </div>
    </Modal>
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
