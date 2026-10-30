/**
 * 契约基础形状（分层底座）：被 view-schemas 与 contract 两层单向消费，杜绝环。
 * 本层只依赖 zod 与 image-provider-ids，不依赖其他 shared 模块。
 */

import { z } from 'zod';
import { IMAGE_PROVIDER_IDS } from './image-provider-ids';

/** IANA 时区校验（Intl 真实解析，'UTC+8'/'Mars/Olympus' 等均拒）。 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z.string().refine(isValidTimeZone, { message: '必须是合法 IANA 时区' });
export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug 必须是 kebab-case' });
export const CredentialRefSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, { message: '凭据引用必须是 POSIX 环境变量名' });

export const IMAGE_SIZES = z.enum(['1024x1024', '1024x1536', '1536x1024', '1344x768', '768x1344']);

export const ImageProviderConfigSchema = z.strictObject({
  providerId: z.enum(IMAGE_PROVIDER_IDS),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  credentialRef: z.string(),
});
export type ImageProviderConfig = z.infer<typeof ImageProviderConfigSchema>;

/**
 * 公众号写作要求（参考 wechat-article/.wewrite/style.yaml）：
 * 生成文章时作为硬性要求注入 outline/draft prompt；空字段不注入。
 */
export const WritingProfileSchema = z.strictObject({
  name: z.string().default(''),
  industry: z.string().default(''),
  topics: z.array(z.string()).default([]),
  tone: z.string().default(''),
  voice: z.string().default(''),
  wordCount: z.string().default(''),
  contentStyle: z.string().default(''),
  persona: z.string().default(''),
  blacklistWords: z.array(z.string()).default([]),
  blacklistTopics: z.array(z.string()).default([]),
  coverStyle: z.string().default(''),
});
export type WritingProfile = z.infer<typeof WritingProfileSchema>;

export const EMPTY_WRITING_PROFILE: WritingProfile = {
  name: '',
  industry: '',
  topics: [],
  tone: '',
  voice: '',
  wordCount: '',
  contentStyle: '',
  persona: '',
  blacklistWords: [],
  blacklistTopics: [],
  coverStyle: '',
};

export const LlmOverrideSchema = z.strictObject({
  provider: z.string().optional(),
  model: z.string().optional(),
});
export type LlmOverride = z.infer<typeof LlmOverrideSchema>;

/**
 * I-22：写作合同里的主张—来源—边界结构。
 * fact 类主张必须带 sourceIds（指向 brief.sources 里的 URL）；opinion 可无来源。
 */
export const ClaimSchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(500),
  type: z.enum(['fact', 'opinion']),
  /** I-23：可选 DOI；开启 Crossref 时用于核对题名/卷期页，不阻断成稿。 */
  doi: z.string().trim().max(200).optional(),
  sourceIds: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  status: z.enum(['supported', 'bounded']).optional(),
  boundary: z.string().trim().max(300).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * 启动 brief（v0.5 变密度输入合同，docs/v0.5-launch-brief.md §2）：
 * 主题之外全部可选——一句话路径零损伤；给了即按分层绑定生效（标题/思路硬绑、大纲骨架绑、来源硬绑+门禁）。
 */
export const LaunchBriefSchema = z.strictObject({
  /** 硬绑：给了就是最终标题（落库覆盖推导标题，微信标题上限 64 字）。 */
  title: z.string().trim().min(1).max(64).optional(),
  /** 硬绑：文章主张的锚（draft 提示词围绕它展开，不得偏离）。 */
  approach: z.string().trim().min(1).max(2000).optional(),
  /** 骨架绑：给定节名不删不改、管线可补节（outline 步校验+补洞+机械校验）。 */
  outline: z.array(z.string().trim().min(1).max(120)).min(1).max(20).optional(),
  /** 硬绑：来源必须以可见 URL 文本进正文（gates 机械检查），AI 不得编造未给来源。 */
  sources: z.array(z.url()).min(1).max(10).optional(),
  /** I-10：一句话主张，全文论证围绕它展开。 */
  thesis: z.string().trim().min(1).max(200).optional(),
  /** I-10：边界——这篇不写什么，避免跑题与越界。 */
  boundary: z.string().trim().min(1).max(500).optional(),
  /** I-10：最强反方及回应。 */
  counterpoint: z.string().trim().min(1).max(500).optional(),
  /** I-10：目标读者（谁 / 场景 / 关心的问题）。 */
  audience: z
    .strictObject({
      who: z.string().trim().min(1).max(120).optional(),
      context: z.string().trim().min(1).max(200).optional(),
      question: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  /** I-10/I-11：必须原样出现的事实/机制（机械门禁）。 */
  mustInclude: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
  /** I-10/I-11：不得出现的内容（机械门禁）。 */
  mustAvoid: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
  /** I-22：主张—来源—边界结构；fact 类主张必须带 sourceIds。 */
  claims: z.array(ClaimSchema).min(1).max(20).optional(),
});
export type LaunchBrief = z.infer<typeof LaunchBriefSchema>;

/** 管线运行参数（Spec §5 run/start.params；调度 paramsSnapshot 同型）。 */
export const RunParamsSchema = z.strictObject({
  topicMode: z.enum(['hotspots', 'fixed']),
  topic: z.string().optional(),
  brief: LaunchBriefSchema.optional(),
  theme: z.string().optional(),
  imageCount: z.number().int().min(0).max(10).optional(),
  llm: LlmOverrideSchema.optional(),
});
export type RunParams = z.infer<typeof RunParamsSchema>;

export const ARTICLE_STATUSES = ['editing', 'rendered', 'pushed', 'failed'] as const;
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
