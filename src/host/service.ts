/** WeWriteService（架构 §3）：host 级唯一服务；写操作串行化。重活已拆 images/wechat-flow/articles-store/schedules-store/views。 */

import { CONTRACT_VERSION, type ArticleDetail, type ArticleListItem, type ConfigView, type HotspotAnalysis, type HotspotDigestItem, type HotspotFetchView, type HotspotItem, type HotspotItemDigest, type RunDetail, type RunParams, type RunSummary, type ScheduleViewModel, type SnapshotResponse, type SuggestedTopicsView } from '../shared/contract';
import { createHash, randomUUID } from 'node:crypto';
import { CREDENTIAL_REFS, DEFAULT_IMAGE_PROVIDER_CHAIN } from '../shared/image-provider-ids';
import { convertArticle } from '../render/convert';
import { SettingsRecordSchema, type RunRecord, type ScheduleAction, type ScheduleRecord, type TopicCandidateRecord } from './domain';
import { rewriteSystemPrompt, rewriteUserPrompt, streamLlmText, type PipelineLlm } from './pipeline/llm';
import { digestHotspotItem as runHotspotDigest } from './hotspot-digest';
import { analyzeHotspot as runHotspotAnalyze } from './hotspot-analyze';
import { createPipelineEngine, pruneTerminalRuns, type PipelineEngine, type RunStore } from './pipeline/engine';
import { aggregateHotspots, buildHotspotSources } from './pipeline/steps/topic';
import { suggestTopics as runSuggestTopics } from './suggest-topics';
import { qualityGatesRunner } from './pipeline/steps/gates';
import { resolveLogger, unwrapCredential, type CredentialsService, type HostLogger, type LlmService, type StorageDomainHandle } from './platform';
import { createAgentToolsGate, type AgentToolsGate } from './agent-tools-gate';
import { createCallRunBindings, type CallRunBindings } from './call-run-bindings';
import { createSchedulerService } from './scheduler/service';
import { createDomainRunStore, openTables, parseGlobalState, type DomainTables, type GlobalState } from './store';
import { createImagesGenerator } from './images';
import { ArticleStore } from './articles-store';
import { ScheduleStore } from './schedules-store';
import { diagnoseWeChat, pushArticleDraft, type PushArticleResult, type WeChatFlowDeps } from './wechat-flow';
import { truncateMessage } from './redaction';
import { buildConfigView, runToDetail, runToSummary, scheduleToView } from './views';
import { toServiceError, WewriteServiceError } from './service-errors';
import type { DiagnoseResult } from './wechat/client';

export { WewriteServiceError };

export interface ServiceDeps {
  readonly domain: StorageDomainHandle;
  readonly credentials: CredentialsService;
  readonly llm: LlmService;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly logger?: HostLogger;
  /** 热榜逐条速览 LLM 调用超时毫秒（默认 45s；测试注入缩短值验证 abort 分支）。 */
  readonly digestTimeoutMs?: number;
  /** AI 改写 LLM 调用超时毫秒（默认 45s；测试注入缩短值验证 abort 分支）。 */
  readonly rewriteTimeoutMs?: number;
  /** 建议选题 LLM 调用超时毫秒（默认 45s；测试注入缩短值验证 abort 分支）。 */
  readonly suggestTimeoutMs?: number;
  readonly agentToolsConfigDefault?: boolean; // AC-M1-12 插件 config 默认（patch 值；未显式设置时闸门回落它）
}

/** 热榜逐条速览与 AI 改写的单次 LLM 调用上限（uiux v0.3 拍板各 45s）。 */
const HOTSPOT_DIGEST_TIMEOUT_MS = 45_000;
const REWRITE_TIMEOUT_MS = 45_000;
/** 建议选题：单次 LLM 调用 45s、缓存 30 分钟、从热榜前 30 条中筛选。 */
const SUGGEST_TIMEOUT_MS = 45_000;
const SUGGEST_CACHE_TTL_MS = 30 * 60_000;
const SUGGEST_HOTSPOT_LIMIT = 30;
/** 同时执行的管线 run 上限（任务中心串行队列；后续若开放设置项再替换为 settings）。 */
const MAX_CONCURRENT_RUNS = 1;

export class WeWriteService {
  private readonly tables: DomainTables;
  private readonly runStore: RunStore;
  private readonly engine: PipelineEngine;
  private readonly logger: HostLogger;
  private readonly nowFn: () => Date;
  private state: GlobalState;
  private operationTail: Promise<unknown> = Promise.resolve();
  private wechatSecret = '';
  private readonly articles: ArticleStore;
  private readonly schedules: ScheduleStore;
  private readonly scheduler: ReturnType<typeof createSchedulerService>;
  /** callId→runId 内存映射（M2 运行卡 callId 兜底链；有界 FIFO，dispose 清空）+ AC-M1-12 单一真源闸门。 */
  private readonly callBindings: CallRunBindings;
  private readonly agentToolsGate: AgentToolsGate;
  /** 建议选题缓存（key = batchId + count + 写作要求；30 分钟 TTL）与同 key 并发请求复用。 */
  private suggestCache: { key: string; at: number; value: SuggestedTopicsView } | undefined;
  private readonly suggestInFlight = new Map<string, Promise<SuggestedTopicsView>>();
  /** 最近一批热榜：建议选题复用同一批，热榜刷新（再次 fetch）即换批次。 */
  private hotspotBatch: { batchId: string; items: readonly HotspotItem[]; fetchedAtIso: string } | undefined;

  private constructor(private readonly deps: ServiceDeps) {
    this.tables = openTables(deps.domain);
    this.logger = deps.logger ?? resolveLogger({}, 'dsh-wewrite');
    this.nowFn = deps.now ?? (() => new Date());
    this.state = parseGlobalState(deps.domain.global.get(), this.logger);
    this.callBindings = createCallRunBindings();
    this.agentToolsGate = createAgentToolsGate({ touched: () => this.state.agentToolsTouched, explicit: () => this.state.settings.agentToolsEnabled, configDefault: deps.agentToolsConfigDefault ?? false });
    this.runStore = createDomainRunStore(this.tables.runs, this.logger);
    this.articles = new ArticleStore({
      tables: this.tables,
      runStore: this.runStore,
      serialize: <T,>(operation: () => Promise<T>) => this.serialize(operation),
      nowIso: () => this.nowIso(),
      getSettings: () => this.settings,
    });
    this.schedules = new ScheduleStore({
      tables: this.tables,
      serialize: <T,>(operation: () => Promise<T>) => this.serialize(operation),
      nowIso: () => this.nowIso(),
      startRun: (schedule) => this.startRun({ trigger: 'schedule', params: schedule.params, scheduleId: schedule.id }),
    });
    this.engine = createPipelineEngine({
      llm: deps.llm as unknown as import('./pipeline/llm').PipelineLlm,
      store: this.runStore,
      gates: qualityGatesRunner,
      renderer: { convert: ({ markdown, theme }) => convertArticle({ markdown, theme }) },
      topicSource: { fetch: async (limit: number) => [...(await this.fetchHotspots(limit))] },
      images: createImagesGenerator({
        getSettings: () => this.settings,
        resolveCredential: (ref) => Promise.resolve(deps.credentials.resolve(ref)).then(unwrapCredential),
        now: this.nowFn,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        persist: async (records) => {
          for (const record of records) await this.tables.images.put(record.id, record);
        },
      }),
      onProduced: ({ markdown, runId }) => this.articles.persistProduced(markdown, runId),
      writingProfile: () => this.settings.writingProfile,
      onImagesBound: ({ articleId, coverImageId, bodyImageIds }) =>
        this.articles.bindImages(articleId, { coverImageId, bodyImageIds }),
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      now: this.nowFn,
    });
    this.scheduler = createSchedulerService({
      loadSchedules: async () => [...this.tables.schedules.entries()].map(([, record]) => record),
      saveSchedule: async (record) => this.tables.schedules.put(record.id, record),
      claim: (key) => this.claimOccurrence(key),
      startRun: async (schedule) => this.startScheduledRun(schedule),
      now: this.nowFn,
    });
  }

  static async open(deps: ServiceDeps): Promise<WeWriteService> {
    const service = new WeWriteService(deps);
    await service.persistState();
    const recovered = await service.engine.resumeInterrupted();
    if (recovered > 0) service.logger.warn(`宿主停机打断 ${recovered} 个 run，已标记 interrupted（不自动补偿重跑）`);
    return service;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.catch(() => undefined);
    return next;
  }

  private async persistState(): Promise<void> {
    await this.deps.domain.global.set(this.state);
  }

  get settings() {
    return this.state.settings;
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  // ── snapshot / hotspots / runs ─────────────────────────────────────────────

  async snapshot(): Promise<SnapshotResponse> {
    return {
      articles: this.listArticles(),
      runs: this.listRuns(),
      schedules: [...this.tables.schedules.entries()].map(([, record]) => scheduleToView(record)),
      topicCandidates: this.listTopicCandidates(),
      config: await this.getConfig(),
      serverNow: this.nowIso(),
      capabilities: { contractVersion: CONTRACT_VERSION, features: ['scheduler', 'images', 'hotspots', 'gates'] },
    };
  }

  listRuns(): RunSummary[] {
    return this.runStore
      .all()
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .map(runToSummary);
  }

  async fetchHotspots(limit = 20, options: { refresh?: boolean } = {}): Promise<HotspotItem[]> {
    const sources = buildHotspotSources({
      aggregatorUrl: this.settings.hotspotAggregatorUrl,
      sources: this.settings.hotspotSources,
      fetchImpl: this.deps.fetchImpl,
    });
    // 建议选题需要 30 条：一次至少拉 30 并存为批次；调用方只取前 limit 条。
    const pullLimit = Math.max(limit, SUGGEST_HOTSPOT_LIMIT);
    const { items, failures } = await aggregateHotspots(sources, pullLimit);
    for (const failure of failures) {
      this.logger.warn(truncateMessage(`热榜源 ${failure.sourceId} 拉取失败：${failure.message}`));
    }
    const batchItems = [...items];
    // 内容指纹只取「来源 + 标题」并排序：热榜实时排名/顺序抖动不应触发建议重算；
    // 只有条目集合真正变化、或用户手动刷新（refresh=true）时才产生新批次。
    const fingerprint = createHash('sha1')
      .update(
        [...batchItems]
          .map((item) => `${item.source}|${item.title}`)
          .sort()
          .join('\n'),
      )
      .digest('hex')
      .slice(0, 12);
    this.hotspotBatch = {
      batchId: options.refresh ? `hb_${randomUUID().replaceAll('-', '').slice(0, 12)}` : `hb_${fingerprint}`,
      items: batchItems,
      fetchedAtIso: this.nowIso(),
    };
    return batchItems.slice(0, limit);
  }

  /** 热榜 RPC 视图：条目 + 批次号，前端用 batchId 判断建议选题是否对应当前热榜。 */
  async fetchHotspotBatch(limit = 20, options: { refresh?: boolean } = {}): Promise<HotspotFetchView> {
    const items = await this.fetchHotspots(limit, options);
    const batch = this.hotspotBatch;
    if (!batch) throw new WewriteServiceError('hotspot-batch-missing', '热榜批次未建立');
    return { items, batchId: batch.batchId, fetchedAtIso: batch.fetchedAtIso };
  }

  /** 建议选题直接调用（定时/工具）时，确保有一个可用批次。 */
  private async ensureHotspotBatch(): Promise<{ batchId: string; items: readonly HotspotItem[]; fetchedAtIso: string }> {
    if (!this.hotspotBatch) await this.fetchHotspots(SUGGEST_HOTSPOT_LIMIT);
    const batch = this.hotspotBatch;
    if (!batch) throw new WewriteServiceError('hotspot-batch-missing', '热榜批次未建立');
    return batch;
  }

  /** 热榜逐条 AI 速览（uiux v0.3 §1）：抓原文→抽取→LLM；抓取失败静默降级 title 模式。 */
  async digestHotspotItem(item: HotspotDigestItem): Promise<HotspotItemDigest> {
    return runHotspotDigest(
      {
        llm: this.deps.llm as unknown as PipelineLlm,
        provider: this.state.settings.llmDefault.provider,
        model: this.state.settings.llmDefault.model,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        logger: this.logger,
        timeoutMs: this.deps.digestTimeoutMs ?? HOTSPOT_DIGEST_TIMEOUT_MS,
        nowIso: () => this.nowIso(),
      },
      item,
    );
  }

  /** 热点结构化分析（确认弹层）：简介 + 可写角度；单次 LLM 调用，超时复用速览配置。 */
  async analyzeHotspot(item: HotspotDigestItem): Promise<HotspotAnalysis> {
    return runHotspotAnalyze(
      {
        llm: this.deps.llm as unknown as PipelineLlm,
        provider: this.state.settings.llmDefault.provider,
        model: this.state.settings.llmDefault.model,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        logger: this.logger,
        timeoutMs: this.deps.digestTimeoutMs ?? HOTSPOT_DIGEST_TIMEOUT_MS,
        nowIso: () => this.nowIso(),
      },
      item,
    );
  }

  /**
   * 建议选题（选题中心右栏）：写作要求 + 热榜 30 条 → 最多 10 条可写选题。
   * 批次语义：复用最近一批热榜；缓存 key 绑定 batchId，热榜刷新即自动失效。
   * 同一批次 30 分钟内复用结果；refresh 绕过缓存；同 key 并发请求复用同一 Promise。
   */
  async suggestTopics(input: { count?: number; refresh?: boolean } = {}): Promise<SuggestedTopicsView> {
    const count = Math.min(10, Math.max(1, input.count ?? 10));
    const batch = await this.ensureHotspotBatch();
    const key = `${batch.batchId}:${count}:${JSON.stringify(this.settings.writingProfile)}`;
    const now = this.nowFn().getTime();
    if (!input.refresh && this.suggestCache?.key === key && now - this.suggestCache.at < SUGGEST_CACHE_TTL_MS) {
      return this.suggestCache.value;
    }
    const inFlight = this.suggestInFlight.get(key);
    if (inFlight) return inFlight;
    const task = (async () => {
      const outcome = await runSuggestTopics(
        {
          llm: this.deps.llm as unknown as PipelineLlm,
          provider: this.state.settings.llmDefault.provider,
          model: this.state.settings.llmDefault.model,
          logger: this.logger,
          profile: this.settings.writingProfile,
          timeoutMs: this.deps.suggestTimeoutMs ?? SUGGEST_TIMEOUT_MS,
          nowIso: () => this.nowIso(),
        },
        batch.items.slice(0, SUGGEST_HOTSPOT_LIMIT),
        count,
      );
      const value: SuggestedTopicsView = { ...outcome, batchId: batch.batchId };
      this.suggestCache = { key, at: this.nowFn().getTime(), value };
      return value;
    })().finally(() => {
      this.suggestInFlight.delete(key);
    });
    this.suggestInFlight.set(key, task);
    return task;
  }

  /** AI 改写选中段（uiux v0.3 §3）：只输出改写文本，maxTokens 随原文长度缩放。 */
  async rewriteText(input: { text: string; instruction: string; title?: string }): Promise<{ text: string }> {
    const startedAt = Date.now();
    const { provider, model } = this.state.settings.llmDefault;
    if (!provider || !model) {
      throw new WewriteServiceError('llm-not-configured', '尚未配置默认模型：请先到「设置」里选择 AI 供应商与模型，再改写选中段落');
    }
    const timeoutMs = this.deps.rewriteTimeoutMs ?? REWRITE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const outcome = await streamLlmText(
        this.deps.llm as unknown as PipelineLlm,
        {
          purpose: 'wewrite-article-rewrite',
          system: rewriteSystemPrompt(),
          user: rewriteUserPrompt(input),
          provider,
          model,
          maxTokens: Math.min(4000, input.text.length * 3 + 500),
        },
        controller.signal,
      );
      if (outcome.status === 'aborted') {
        throw new WewriteServiceError('rewrite-timeout', `AI 改写超时（${Math.round(timeoutMs / 1000)} 秒），已取消，请重试`);
      }
      // rewrite-error 分流：LLM 供应商错误的 code/message 原样透传
      if (outcome.status === 'error') throw new WewriteServiceError(outcome.code, outcome.message);
      if (!outcome.text) throw new WewriteServiceError('rewrite-empty', '模型未返回任何改写内容，请重试');
      this.logger.info(
        `article rewrite ok：model=${model} ${Date.now() - startedAt}ms in=${input.text.length} out=${outcome.text.length}`,
      );
      return { text: outcome.text };
    } catch (error) {
      const code = error instanceof WewriteServiceError ? error.code : 'unknown';
      this.logger.warn(`article rewrite failed（${code}）：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  startRun(input: { trigger: 'manual' | 'schedule' | 'chat'; params: RunParams; articleId?: string; scheduleId?: string }): { runId: string } {
    // settings.llmDefault 解析进 params.llm（本次显式覆盖优先）——paramsSnapshot 记录实际用的供应商/模型。
    const params: RunParams = { ...input.params, llm: { ...this.state.settings.llmDefault, ...(input.params.llm ?? {}) } };
    const { runId, done } = this.engine.begin({
      trigger: input.trigger,
      params,
      ...(input.articleId ? { articleId: input.articleId } : {}),
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    });
    void done.catch((error) => {
      const serviceError = toServiceError(error);
      this.logger.error(truncateMessage(`run ${runId} 执行异常（${serviceError.code}）：${serviceError.message}`));
    });
    return { runId };
  }

  cancelRun(runId: string): { ok: boolean } {
    return { ok: this.engine.cancel(runId) };
  }

  /** 任务中心重试：沿用原 run 的 paramsSnapshot（含原模型覆盖）重新入队；活跃 run 拒绝重试。 */
  retryRun(runId: string): { runId: string } {
    const record = this.runStore.get(runId);
    if (!record) throw new WewriteServiceError('run-not-found', `运行记录不存在（runId: ${runId}）`);
    if (record.status === 'queued' || record.status === 'running') {
      throw new WewriteServiceError('run-active', `运行仍在进行中（${record.status}），请先取消再重试`);
    }
    return this.startRun({
      trigger: record.trigger,
      params: record.paramsSnapshot,
      ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
      ...(record.articleId ? { articleId: record.articleId } : {}),
    });
  }

  /** chat-integration M1：等待 run 到终态（wewrite_run 工具 execute 等终态用；未知 runId → undefined）。 */
  async runCompletion(runId: string): Promise<RunRecord | undefined> {
    return this.engine.awaitDone(runId);
  }

  /** chat-integration M2 消费面：run 详情（RunSummary + steps + topic，run/detail RPC 透传）。runId/callId 二选一。 */
  runDetail(selector: { runId?: string; callId?: string }): RunDetail {
    const runId = selector.runId ?? (selector.callId ? this.callBindings.resolve(selector.callId) : undefined);
    const record = runId ? this.runStore.get(runId) : undefined;
    const hint = selector.callId ? `callId: ${selector.callId}` : `runId: ${selector.runId ?? ''}`;
    if (!record) throw new WewriteServiceError('run-not-found', `运行记录不存在（${hint}）`);
    return runToDetail(record);
  }

  /** M2 callId 兜底链锚点：工具 execute 绑宿主 callId → runId。 */
  bindRunCall(callId: string, runId: string): void { this.callBindings.bind(callId, runId); }

  lookupArticleTitle(articleId: string): string { // 推送审批 reason 同步内存查（architecture §4.4）
    const record = articleId ? (this.tables.articles.get(articleId) as { title?: unknown } | undefined) : undefined;
    return typeof record?.title === 'string' ? record.title : '';
  }

  // ── articles / schedules（委托 store）─────────────────────────────────────

  listArticles(): ArticleListItem[] {
    return this.articles.list();
  }

  getArticle(id: string): ArticleDetail {
    return this.articles.get(id);
  }

  saveArticle(input: { id?: string; slug: string; title: string; digest: string; markdown: string; theme: string }): Promise<ArticleDetail> {
    return this.articles.save(input);
  }

  deleteArticle(id: string): Promise<{ deleted: boolean }> { return this.articles.delete(id); }

  previewArticle(input: { id: string } | { markdown: string; theme: string }): { html: string } {
    return this.articles.preview(input);
  }

  saveSchedule(input: { id?: string; name: string; action: ScheduleAction; topicCount?: number; rrule: string; timeZone: string; params: RunParams; enabled: boolean }): Promise<ScheduleViewModel> {
    return this.schedules.save(input);
  }

  /** 调度派发：topics 走热榜扫描；draft/article 走管线，draft 成功后自动推草稿箱。 */
  private async startScheduledRun(schedule: ScheduleRecord): Promise<string> {
    if (schedule.action === 'topics') {
      await this.scanTopics(schedule);
      return `scan_${schedule.id}`;
    }
    const { runId } = this.startRun({ trigger: 'schedule', params: schedule.params, scheduleId: schedule.id });
    if (schedule.action === 'draft') void this.pushScheduledRun(runId);
    return runId;
  }

  /** draft 任务：run 成功后自动推草稿箱；失败只记日志，文章保留可手动重推。 */
  private async pushScheduledRun(runId: string): Promise<void> {
    const run = await this.runCompletion(runId);
    if (!run || run.status !== 'succeeded') return;
    const articleId = run.articleId ?? this.findArticleIdByRun(runId);
    if (!articleId) {
      this.logger.warn(`定时推送跳过：run ${runId} 没有产出文章`);
      return;
    }
    try {
      await this.pushArticleDraft(articleId);
      this.logger.info(`定时任务已推草稿箱（article ${articleId}）`);
    } catch (error) {
      this.logger.warn(truncateMessage(`定时推送失败（article ${articleId}）：${toServiceError(error).message}`));
    }
  }

  private findArticleIdByRun(runId: string): string | undefined {
    for (const [, article] of this.tables.articles.entries()) {
      if (article.lastRunId === runId) return article.id;
    }
    return undefined;
  }

  /** topics 任务：抓热榜 + 逐条 AI 速览，保存最近一批候选（不写正文、不推送）。 */
  private async scanTopics(schedule: ScheduleRecord): Promise<void> {
    const count = schedule.topicCount ?? 3;
    const items = await this.fetchHotspots(count);
    const batchId = `batch_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const createdAt = this.nowIso();
    const records: TopicCandidateRecord[] = [];
    for (const item of items.slice(0, count)) {
      let digest: string | undefined;
      try {
        const result = await this.digestHotspotItem({ rank: item.rank, title: item.title, url: item.url });
        digest = result.digest;
      } catch (error) {
        this.logger.warn(truncateMessage(`定时选题速览失败（${item.title}）：${toServiceError(error).message}`));
      }
      records.push({
        v: 1,
        id: `tc_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        batchId,
        scheduleId: schedule.id,
        title: item.title,
        source: item.source,
        url: item.url,
        rank: item.rank,
        ...(digest ? { digest } : {}),
        createdAt,
      });
    }
    await this.serialize(async () => {
      for (const record of records) await this.tables.topicCandidates.put(record.id, record);
      const ordered = [...this.tables.topicCandidates.entries()]
        .map(([, record]) => record)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const keepBatches = new Set([...new Set(ordered.map((record) => record.batchId))].slice(0, 5));
      for (const [id, record] of this.tables.topicCandidates.entries()) {
        if (!keepBatches.has(record.batchId)) await this.tables.topicCandidates.delete(id);
      }
    });
  }

  /** 最近一批定时选题候选（选题页展示；无候选时为空数组）。 */
  listTopicCandidates(): SnapshotResponse['topicCandidates'] {
    const all = [...this.tables.topicCandidates.entries()].map(([, record]) => record);
    const latestBatch = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.batchId;
    return all
      .filter((record) => record.batchId === latestBatch)
      .sort((a, b) => a.rank - b.rank)
      .map((record) => ({
        id: record.id,
        batchId: record.batchId,
        ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
        title: record.title,
        source: record.source,
        url: record.url,
        rank: record.rank,
        ...(record.digest ? { digest: record.digest } : {}),
        createdAt: record.createdAt,
      }));
  }

  deleteSchedule(id: string): Promise<{ deleted: boolean }> { return this.schedules.delete(id); }

  toggleSchedule(id: string, enabled: boolean): Promise<ScheduleViewModel> {
    return this.schedules.toggle(id, enabled);
  }

  runScheduleNow(id: string): { runId: string } { return this.schedules.runNow(id); }

  private async claimOccurrence(key: string): Promise<boolean> {
    return this.serialize(async () => {
      if (this.state.claimedOccurrences.includes(key)) return false;
      this.state = { ...this.state, claimedOccurrences: [...this.state.claimedOccurrences, key].slice(-500) };
      await this.persistState();
      return true;
    });
  }

  /** AC-M1-12 单一真源总开关（显式设置 > 插件 config 默认）；翻转通知供热回收。 */
  agentToolsEnabled(): boolean { return this.agentToolsGate.enabled(); }
  onAgentToolsChanged(listener: (enabled: boolean) => void): () => void { return this.agentToolsGate.subscribe(listener); }

  async getConfig(): Promise<ConfigView> { // AC-M1-12：投影闸门真值（未显式设置时= config 默认，非物化 false）
    return buildConfigView({ ...this.settings, agentToolsEnabled: this.agentToolsEnabled() }, await this.describeCredentials());
  }

  async setConfig(patch: Record<string, unknown>): Promise<ConfigView> {
    return this.serialize(async () => {
      const gateBefore = this.agentToolsEnabled();
      const parsed = SettingsRecordSchema.safeParse({ ...this.state.settings, ...patch });
      if (!parsed.success) {
        throw new WewriteServiceError('config-invalid', `设置校验失败：${parsed.error.issues[0]?.message ?? '未知问题'}`);
      }
      this.state = { ...this.state, settings: parsed.data, ...(Object.prototype.hasOwnProperty.call(patch, 'agentToolsEnabled') ? { agentToolsTouched: true } : {}) }; // AC-M1-12：显式写开关即打 touched
      await this.persistState();
      const gateAfter = this.agentToolsEnabled();
      if (gateAfter !== gateBefore) this.agentToolsGate.notify(gateAfter);
      return this.getConfig();
    });
  }

  async setCredential(ref: string, value: string): Promise<{ ok: boolean }> {
    await this.deps.credentials.set(ref, value);
    if (ref === CREDENTIAL_REFS.wechatSecret) this.wechatSecret = value;
    return { ok: true };
  }

  async describeCredentials(): Promise<Record<string, { configured: boolean; writable: boolean }>> {
    const refs = [CREDENTIAL_REFS.wechatSecret, ...DEFAULT_IMAGE_PROVIDER_CHAIN.map(CREDENTIAL_REFS.image)];
    const descriptors: Record<string, { configured: boolean; writable: boolean }> = {};
    for (const ref of refs) {
      const raw = await Promise.resolve(this.deps.credentials.describe(ref));
      descriptors[ref] = { configured: raw?.configured ?? false, writable: raw?.writable ?? true };
    }
    return descriptors;
  }

  async listLlmOptions(): Promise<{ providers: { id: string; models: string[] }[] }> {
    // 宿主 listModels 返回 Promise（dsh-llm seam 实测），同步 .map 会炸——归一后再用。
    const rawProviders = await Promise.resolve(this.deps.llm.listProviders?.() ?? []);
    const providers = Array.isArray(rawProviders) ? rawProviders : [];
    const result: { id: string; models: string[] }[] = [];
    for (const entry of providers) {
      const listing = entry as { id?: string; name?: string };
      const id = String(listing?.id ?? listing?.name ?? entry ?? '');
      if (!id) continue;
      const rawModels = await Promise.resolve(this.deps.llm.listModels?.(id) ?? []);
      const models = (Array.isArray(rawModels) ? rawModels : []).map((model) =>
        String((model as { id?: string })?.id ?? model),
      );
      result.push({ id, models });
    }
    return { providers: result };
  }

  // ── wechat / lifecycle ─────────────────────────────────────────────────────

  private weChatFlowDeps(): WeChatFlowDeps {
    return {
      articles: this.tables.articles,
      images: this.tables.images,
      clientDeps: {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        getCredentials: () => ({ appId: this.settings.wechatAppId, secret: this.wechatSecret }),
        getSettings: () => ({ apiBaseUrl: this.settings.wechatApiBaseUrl, author: this.settings.wechatAuthor }),
      },
      refreshSecret: async () => {
        const resolved = await Promise.resolve(this.deps.credentials.resolve(CREDENTIAL_REFS.wechatSecret));
        this.wechatSecret = unwrapCredential(resolved) ?? '';
      },
      serialize: <T,>(operation: () => Promise<T>) => this.serialize(operation),
      now: this.nowFn,
    };
  }

  async pushArticleDraft(articleId: string): Promise<PushArticleResult> {
    return pushArticleDraft(this.weChatFlowDeps(), articleId);
  }

  async diagnoseWeChat(): Promise<DiagnoseResult> {
    return diagnoseWeChat(this.weChatFlowDeps());
  }

  startScheduler(): void { this.scheduler.start(); }

  async pruneRunHistory(): Promise<void> {
    const kept = pruneTerminalRuns(this.runStore.all(), this.settings.runHistoryLimit);
    const keptIds = new Set(kept.map((run) => run.id));
    for (const run of this.runStore.all()) {
      if (!keptIds.has(run.id)) await this.tables.runs.delete(run.id);
    }
  }

  async dispose(): Promise<void> {
    this.scheduler.stop();
    this.callBindings.clear();
    this.suggestInFlight.clear();
    this.suggestCache = undefined;
    await this.deps.domain.close().catch(() => undefined);
  }
}
