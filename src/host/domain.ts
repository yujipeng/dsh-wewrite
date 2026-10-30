/**
 * storage domain schema（Spec §6 / 架构 §5）：单一 domain `dsh-wewrite` v1。
 * zod schema 即权威；全部记录带 v 字段做记录级演进（架构 §9.6）。
 * 介质版本不符时 storageDomain.open 拒绝——天然迁移闸门。
 */

import { z } from 'zod';
import { ImageProviderConfigSchema, LlmOverrideSchema, RUN_STATUSES, RunParamsSchema } from '../shared/contract';
import { isValidTimeZone } from '../shared/contract';
import { EMPTY_WRITING_PROFILE, WritingProfileSchema } from '../shared/schema-base';

const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug 必须是 kebab-case' });
const TimeZoneSchema = z.string().refine(isValidTimeZone, { message: '必须是合法 IANA 时区' });

/** 单张图片上限（Spec §10）。base64 以字符数口径控制（10MiB 字符 < 10MB 二进制的 base64 编码长度，保守拒收）。 */
const IMAGE_BASE64_MAX_CHARS = 10 * 1024 * 1024;

// ── global：SettingsRecord（非机密项；机密一律走 ctx.credentials，架构 §8）──

export const SettingsRecordSchema = z.strictObject({
  wechatAppId: z.string().default(''),
  wechatApiBaseUrl: z.string().default('https://api.weixin.qq.com'),
  wechatAuthor: z.string().default(''),
  defaultTheme: z.string().default('professional-clean'),
  defaultImageSize: z
    .enum(['1024x1024', '1024x1536', '1536x1024', '1344x768', '768x1344'])
    .default('1024x1024'),
  llmDefault: LlmOverrideSchema.default({}),
  imageProviders: z.array(ImageProviderConfigSchema).default([
    { providerId: 'openai', credentialRef: 'WEWRITE_IMG_OPENAI' },
  ]),
  agentToolsEnabled: z.boolean().default(false),
  writingProfile: WritingProfileSchema.default(EMPTY_WRITING_PROFILE),
  runHistoryLimit: z.number().int().min(1).max(1000).default(200),
  hotspotSources: z.array(z.enum(['weibo', 'toutiao', 'baidu', 'hackernews'])).default(['weibo', 'toutiao', 'baidu']),
  hotspotAggregatorUrl: z.string().default(''),
});
export type SettingsRecord = z.infer<typeof SettingsRecordSchema>;

// ── table：articles ─────────────────────────────────────────────────────────

export const ArticleRecordSchema = z.strictObject({
  v: z.number().int().min(1),
  id: z.string().min(1),
  slug: SlugSchema,
  title: z.string().min(1),
  digest: z.string(),
  status: z.enum(['editing', 'rendered', 'pushed', 'failed']),
  markdown: z.string(),
  theme: z.string(),
  bodyImageIds: z.array(z.string()).max(10).default([]),
  coverImageId: z.string().optional(),
  wechatMediaId: z.string().optional(),
  thumbMediaId: z.string().optional(),
  lastRunId: z.string().optional(),
  /** 发布记录（I-04/I-05）：推送时间、摘要字节数、回读校验结论。 */
  pushedAt: z.string().optional(),
  digestBytes: z.number().int().min(0).optional(),
  pushVerify: z
    .strictObject({
      ok: z.boolean(),
      issues: z.array(z.string()),
      checkedAt: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArticleRecord = z.infer<typeof ArticleRecordSchema>;

// ── table：runs ─────────────────────────────────────────────────────────────

export const StepRecordSchema = z.strictObject({
  name: z.string().min(1),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});
export type StepRecord = z.infer<typeof StepRecordSchema>;

export const RunRecordSchema = z.strictObject({
  v: z.number().int().min(1),
  id: z.string().min(1),
  trigger: z.enum(['manual', 'schedule', 'chat']),
  scheduleId: z.string().optional(),
  articleId: z.string().optional(),
  paramsSnapshot: RunParamsSchema,
  status: z.enum(RUN_STATUSES),
  steps: z.array(StepRecordSchema),
  error: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
  summary: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// ── table：schedules ────────────────────────────────────────────────────────

export const ScheduleActionSchema = z.enum(['draft', 'article', 'topics']);
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>;

export const ScheduleRecordSchema = z.strictObject({
  v: z.number().int().min(1),
  id: z.string().min(1),
  revision: z.number().int().min(1),
  name: z.string().min(1),
  action: ScheduleActionSchema.default('draft'),
  topicCount: z.number().int().min(1).max(10).optional(),
  rrule: z.string().min(1),
  timeZone: TimeZoneSchema,
  params: RunParamsSchema,
  publishTarget: z.literal('draft'),
  enabled: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

// ── table：topicCandidates（定时选题产物）────────────────────────────────────

export const TopicCandidateRecordSchema = z.strictObject({
  v: z.number().int().min(1),
  id: z.string().min(1),
  batchId: z.string().min(1),
  scheduleId: z.string().optional(),
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.string(),
  rank: z.number().int().min(1),
  digest: z.string().optional(),
  createdAt: z.string(),
  /** I-08：候选字段（全部可选，旧记录无新字段可读）。 */
  sourceType: z.enum(['hot', 'demand', 'evergreen']).optional(),
  originUrl: z.string().optional(),
  heat: z.number().min(0).max(10).optional(),
  relevance: z.number().min(0).max(10).optional(),
  value: z.number().min(0).max(10).optional(),
  score: z.number().min(0).max(10).optional(),
  idealClick: z.string().max(200).optional(),
  seo: z.string().max(200).optional(),
  framework: z.enum(['opinion', 'hot-take', 'pain-point']).optional(),
  reason: z.string().max(300).optional(),
  historyMark: z.string().max(300).optional(),
});
export type TopicCandidateRecord = z.infer<typeof TopicCandidateRecordSchema>;

// ── table：images ───────────────────────────────────────────────────────────

export const ImageRecordSchema = z.strictObject({
  v: z.number().int().min(1),
  id: z.string().min(1),
  articleId: z.string().min(1),
  kind: z.enum(['cover', 'body']),
  mime: z.string().regex(/^image\//, { message: 'mime 必须 image/*' }),
  base64: z.string().max(IMAGE_BASE64_MAX_CHARS),
  /** 压缩后字节数（I-03）；旧记录无此字段。 */
  bytes: z.number().int().min(0).optional(),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  /** false = sharp 不可用/压缩失败，交由推送预检兜底。 */
  compressed: z.boolean().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string(),
  wechatUrl: z.string().optional(),
  wechatMediaId: z.string().optional(),
  createdAt: z.string(),
});
export type ImageRecord = z.infer<typeof ImageRecordSchema>;

// ── global：复合状态（settings + 调度 occurrence claim 键）─────────────────

export const GlobalStateSchema = z.strictObject({
  v: z.literal(1),
  settings: SettingsRecordSchema,
  claimedOccurrences: z.array(z.string()).default([]),
  /** AC-M1-12：用户是否显式设置过 agentToolsEnabled（闸门真源标记；缺省=从未设置，回落插件 config 默认）。 */
  agentToolsTouched: z.boolean().default(false),
});
export type GlobalState = z.infer<typeof GlobalStateSchema>;

// ── domain spec（F15：defineDomain({name, version, global?, tables}) + domainTable(zod)）──
// 平台 global 槽契约（dsh-storage-domain 源码 358 行实证）：键名是 `schema` + `initial`，
// 非 tables 的 `valueSchema`；且 schema 必须拒绝 null（null 是介质「从未写入」哨兵，平台 65 行显式校验）。
// 写错键名的症状：首启 global=null 走 initial 分支不报错，二次启动读到已写入的 global
// 走 `globalSpec.schema.parse` → undefined.parse → DomainError invalid-record（2026-08-19 实测踩中）。

export const INITIAL_GLOBAL: GlobalState = {
  v: 1,
  settings: SettingsRecordSchema.parse({}),
  claimedOccurrences: [],
  agentToolsTouched: false,
};

export const domainSpec = {
  // 存储单元名受平台 UNIT_NAME_RE（/^[a-z][a-z0-9_]*$/）约束，连字符非法——
  // 用下划线形态，与 cordis 插件名（dsh-wewrite）区分。
  name: 'dsh_wewrite',
  version: 1,
  global: { schema: GlobalStateSchema, initial: INITIAL_GLOBAL },
  tables: {
    articles: { valueSchema: ArticleRecordSchema },
    runs: { valueSchema: RunRecordSchema },
    schedules: { valueSchema: ScheduleRecordSchema },
    topic_candidates: { valueSchema: TopicCandidateRecordSchema },
    images: { valueSchema: ImageRecordSchema },
  },
} as const;

export type WewriteDomainSpec = typeof domainSpec;
