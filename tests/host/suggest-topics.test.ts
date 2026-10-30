import { describe, expect, it, vi } from 'vitest';
import type { HotspotItem } from '@/shared/contract';
import type { LlmService } from '@/host/platform';
import { WeWriteService } from '@/host/service';
import { WewriteServiceError } from '@/host/service-errors';
import { parseSuggestedTopicLines } from '@/host/suggest-topics';
import { MemoryDomain, makeCredentials, silentLogger } from './service-harness';

/**
 * 建议选题（选题中心右栏）：
 * - parseSuggestedTopicLines：行结构解析、Markdown 清洗、去重、来源越界/黑名单二次过滤
 * - service.suggestTopics：热榜 30 条 + 写作要求 → LLM，30 分钟缓存 / refresh / 写作要求失效
 * LLM 按宿主真实 chunk 协议 mock（text-delta + finish.reason）。
 */

const FIXED_NOW = new Date('2026-08-20T12:00:00.000Z');

const PROFILE = {
  name: '社会现象心理分析',
  industry: '心理学',
  topics: ['社会热点背后的心理机制'],
  tone: '冷静',
  voice: '第一人称',
  wordCount: '1800-2600',
  contentStyle: '观点',
  persona: 'midnight-friend',
  blacklistWords: ['震惊'],
  blacklistTopics: ['裁员'],
  coverStyle: '',
};

const hotspot = (title: string, index = 1): HotspotItem => ({
  title,
  source: 'weibo',
  rank: index,
  url: `https://s.weibo.com/weibo?q=${encodeURIComponent(title)}`,
});

const hotspots = (count = 30): HotspotItem[] =>
  Array.from({ length: count }, (_, index) => hotspot(`热点 ${index + 1}`, index + 1));

const linesFor = (count: number): string =>
  Array.from({ length: count }, (_, index) => `${index + 1} ||| 建议标题${index + 1} ||| 角度${index + 1} ||| ${index + 1}`).join('\n');

function makeFetch(titles: string[]) {
  const impl = vi.fn(async (_url: unknown) =>
    new Response(JSON.stringify({ data: { realtime: titles.map((note) => ({ note })) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return impl as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

type StreamFactory = (options: Record<string, unknown>, call: number) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

function makeScriptedLlm(factory: StreamFactory) {
  const calls: Record<string, unknown>[] = [];
  const stream: StreamFactory = (options, call) => {
    calls.push(options);
    return factory(options, call);
  };
  return { llm: { stream } as LlmService, calls };
}

async function* textStream(text: string) {
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

const userTextOf = (options: Record<string, unknown>): string => {
  const messages = options.messages as { content: { text: string }[] }[];
  return String(messages[0].content[0].text);
};

async function rejectInfo(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WewriteServiceError) return { code: error.code, message: error.message };
    return { code: `non-coded:${error instanceof Error ? error.message : String(error)}`, message: '' };
  }
  return { code: 'no-error-thrown', message: '' };
}

async function makeService(
  llm: LlmService,
  options: {
    titles?: string[];
    writingProfile?: typeof PROFILE;
    suggestTimeoutMs?: number;
    skipLlmConfig?: boolean;
  } = {},
) {
  const fetchImpl = makeFetch(options.titles ?? hotspots().map((item) => item.title));
  const service = await WeWriteService.open({
    domain: new MemoryDomain(),
    credentials: makeCredentials().service,
    llm,
    fetchImpl,
    now: () => FIXED_NOW,
    logger: silentLogger,
    ...(options.suggestTimeoutMs !== undefined ? { suggestTimeoutMs: options.suggestTimeoutMs } : {}),
  });
  await service.setConfig({
    hotspotSources: ['weibo'],
    ...(options.skipLlmConfig ? {} : { llmDefault: { provider: 'zhipu', model: 'glm-4.5-flash' } }),
    ...(options.writingProfile ? { writingProfile: options.writingProfile } : {}),
  });
  return { service, fetchImpl };
}

// ── 纯解析 ──────────────────────────────────────────────────────────────────

describe('parseSuggestedTopicLines', () => {
  it('解析 10 行：标题/角度与来源条目（source/rank/title/url）逐项映射', () => {
    const source = hotspots(10);
    const topics = parseSuggestedTopicLines(linesFor(10), source, 10, PROFILE);

    expect(topics).toHaveLength(10);
    expect(topics[0]).toEqual({
      title: '建议标题1',
      angle: '角度1',
      source: 'weibo',
      sourceRank: 1,
      sourceTitle: '热点 1',
      sourceUrl: 'https://s.weibo.com/weibo?q=%E7%83%AD%E7%82%B9%201',
    });
    expect(topics[9]?.title).toBe('建议标题10');
  });

  it('清洗 Markdown 粗体/列表符号与整体引号；末尾多带字段仍按最后一个数字取热点序号', () => {
    const text = [
      '- **1** ||| **《AI 眼镜为什么火了》** ||| 从隐私边界切入 ||| 2 ||| 额外字段',
      '2. 「第二个标题」 ||| 角度二 ||| 3',
    ].join('\n');
    const topics = parseSuggestedTopicLines(text, hotspots(5), 10, PROFILE);

    expect(topics[0]).toMatchObject({ title: 'AI 眼镜为什么火了', angle: '从隐私边界切入', sourceRank: 2 });
    expect(topics[1]).toMatchObject({ title: '第二个标题', sourceRank: 3 });
  });

  it('去重、来源越界与缺字段行静默丢弃', () => {
    const text = [
      '1 ||| 同一个标题 ||| 角度一 ||| 1',
      '2 ||| 同一个标题 ||| 角度二 ||| 2',
      '3 ||| 越界来源 ||| 角度三 ||| 99',
      '4 ||| 缺角度 ||||| 1',
      '不是行结构',
    ].join('\n');
    const topics = parseSuggestedTopicLines(text, hotspots(3), 10, PROFILE);

    expect(topics.map((item) => item.title)).toEqual(['同一个标题']);
  });

  it('黑名单二次过滤：建议标题/角度命中禁用词或不写话题即丢弃', () => {
    const text = [
      '1 ||| 震惊！某公司突然宣布 ||| 角度一 ||| 1',
      '2 ||| 某公司裁员传闻 ||| 角度二 ||| 2',
      '3 ||| 正常标题 ||| 正常角度 ||| 3',
    ].join('\n');
    const topics = parseSuggestedTopicLines(text, hotspots(3), 10, PROFILE);

    expect(topics.map((item) => item.title)).toEqual(['正常标题']);
  });

  it('标题以「3.15」这类数字点号开头时不被误当作序号删除', () => {
    const topics = parseSuggestedTopicLines('1 ||| 3.15 晚会曝光名单 ||| 从消费维权谈起 ||| 1', hotspots(1), 10, PROFILE);
    expect(topics[0]?.title).toBe('3.15 晚会曝光名单');
  });

  it('最多返回 count 条，标题与角度按上限截断', () => {
    const text = [
      `1 ||| ${'长'.repeat(100)} ||| ${'角'.repeat(300)} ||| 1`,
      '2 ||| 第二条 ||| 角度 ||| 2',
    ].join('\n');
    const topics = parseSuggestedTopicLines(text, hotspots(3), 1, PROFILE);

    expect(topics).toHaveLength(1);
    expect(topics[0]?.title.length).toBe(60);
    expect(topics[0]?.angle.length).toBe(120);
  });
});

// ── service.suggestTopics ───────────────────────────────────────────────────

describe('service.suggestTopics', () => {
  it('成功：10 条建议、profileUsed=true、totalHotspots=30、固定 generatedAtIso', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    const result = await service.suggestTopics({ count: 10 });

    expect(result.topics).toHaveLength(10);
    expect(result.profileUsed).toBe(true);
    expect(result.totalHotspots).toBe(30);
    expect(result.model).toBe('glm-4.5-flash');
    expect(result.generatedAtIso).toBe(FIXED_NOW.toISOString());
  });

  it('提示词：注入写作要求、黑名单与热榜编号；purpose/provider/model/maxTokens 契约', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    await service.suggestTopics({ count: 10 });

    expect(llm.calls).toHaveLength(1);
    const options = llm.calls[0];
    expect(options?.purpose).toBe('wewrite-suggest-topics');
    expect(options?.provider).toBe('zhipu');
    expect(options?.model).toBe('glm-4.5-flash');
    expect(options?.maxTokens).toBe(33_000);
    const user = userTextOf(options ?? {});
    expect(user).toContain('公众号：社会现象心理分析（心理学）');
    expect(user).toContain('主题方向：社会热点背后的心理机制');
    expect(user).toContain('不写的话题：裁员');
    expect(user).toContain('禁用词（不得出现）：震惊');
    expect(user).toContain('[1] weibo #1 热点 1');
    expect(user).toContain('[30] weibo #30 热点 30');
    expect(user).toContain('最多 10 条');
  });

  it('写作要求为空：profileUsed=false，提示词说明按通用标准筛选', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm);

    const result = await service.suggestTopics({ count: 10 });

    expect(result.profileUsed).toBe(false);
    expect(userTextOf(llm.calls[0] ?? {})).toContain('还没有填写写作要求');
  });

  it('未配置模型：llm-not-configured，零 LLM 调用', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, { skipLlmConfig: true });

    const info = await rejectInfo(service.suggestTopics({ count: 10 }));

    expect(info.code).toBe('llm-not-configured');
    expect(info.message).toContain('设置');
    expect(llm.calls).toHaveLength(0);
  });

  it('空输出：重试一次后 suggest-empty（共 2 次调用）', async () => {
    const llm = makeScriptedLlm(async () => textStream(''));
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    const info = await rejectInfo(service.suggestTopics({ count: 10 }));

    expect(info.code).toBe('suggest-empty');
    expect(llm.calls).toHaveLength(2);
    expect(userTextOf(llm.calls[1] ?? {})).toContain('上一次没有输出内容');
  });

  it('格式不符：带纠正提示重试一次，仍失败 suggest-parse-failed', async () => {
    const llm = makeScriptedLlm(async () => textStream('1. 这段不是行结构\n2. 第二行也不是'));
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    const info = await rejectInfo(service.suggestTopics({ count: 10 }));

    expect(info.code).toBe('suggest-parse-failed');
    expect(llm.calls).toHaveLength(2);
    expect(userTextOf(llm.calls[1] ?? {})).toContain('【纠正】');
    expect(userTextOf(llm.calls[1] ?? {})).toContain('|||');
  });

  it('超时：注入短超时 + 持续吐 delta 的慢流 → suggest-timeout', async () => {
    const llm = makeScriptedLlm(async function* () {
      for (let index = 0; ; index += 1) {
        yield { type: 'text-delta', index, text: `行${index}` };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE, suggestTimeoutMs: 30 });

    const info = await rejectInfo(service.suggestTopics({ count: 10 }));

    expect(info.code).toBe('suggest-timeout');
    expect(info.message).toContain('已取消');
  });

  it('LLM 错误分流：finish.reason=error 的 code/message 原样透传', async () => {
    const llm = makeScriptedLlm(async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'context-overflow', message: '上下文超限' } } };
    });
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    const info = await rejectInfo(service.suggestTopics({ count: 10 }));

    expect(info).toEqual({ code: 'context-overflow', message: '上下文超限' });
  });

  it('黑名单硬过滤：命中「不写的话题」的热点不进入提示词', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, {
      titles: ['某公司裁员 20%', '热点 A', '热点 B'],
      writingProfile: PROFILE,
    });

    await service.suggestTopics({ count: 10 });

    const user = userTextOf(llm.calls[0] ?? {});
    expect(user).not.toContain('裁员 20%');
    expect(user).toContain('热点 A');
  });

  it('全部热点被黑名单排除：suggest-no-hotspots，零 LLM 调用', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, {
      titles: ['某公司裁员 20%', '又一波裁员'],
      writingProfile: PROFILE,
    });

    const info = await rejectInfo(service.suggestTopics({ count: 10 }));

    expect(info.code).toBe('suggest-no-hotspots');
    expect(llm.calls).toHaveLength(0);
  });

  it('热榜不足 10 条：按实际条数生成（target=min(count, 候选数)）', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(3)));
    const { service } = await makeService(llm.llm, {
      titles: ['热点 A', '热点 B', '热点 C'],
      writingProfile: PROFILE,
    });

    const result = await service.suggestTopics({ count: 10 });

    expect(result.topics).toHaveLength(3);
    expect(result.totalHotspots).toBe(3);
    expect(userTextOf(llm.calls[0] ?? {})).toContain('最多 3 条');
  });

  it('缓存 30 分钟：第二次调用直接命中，不再调模型；refresh=true 强制重算但不重复拉热榜', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service, fetchImpl } = await makeService(llm.llm, { writingProfile: PROFILE });

    await service.suggestTopics({ count: 10 });
    await service.suggestTopics({ count: 10 });
    expect(llm.calls).toHaveLength(1);
    expect(fetchImpl.mock.calls).toHaveLength(1);

    // 建议区「刷新」= 同一热榜批次重算，不产生新批次、不重复拉热榜。
    await service.suggestTopics({ count: 10, refresh: true });
    expect(llm.calls).toHaveLength(2);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it('批次：hotspots/fetch 返回 batchId，suggest 复用同一批热榜（不重复拉取）', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service, fetchImpl } = await makeService(llm.llm, { writingProfile: PROFILE });

    const batch = await service.fetchHotspotBatch(30);
    expect(batch.batchId).toMatch(/^hb_[a-z0-9]+$/);
    expect(batch.items).toHaveLength(30);
    expect(batch.fetchedAtIso).toBe(FIXED_NOW.toISOString());
    const fetchesAfterBatch = fetchImpl.mock.calls.length;

    const result = await service.suggestTopics({ count: 10 });
    expect(result.batchId).toBe(batch.batchId);
    expect(fetchImpl.mock.calls.length).toBe(fetchesAfterBatch);
  });

  it('热榜刷新产生新批次：建议缓存随 batchId 失效并重新生成', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    const first = await service.fetchHotspotBatch(30);
    const firstSuggest = await service.suggestTopics({ count: 10 });
    expect(firstSuggest.batchId).toBe(first.batchId);
    const callsAfterFirst = llm.calls.length;

    const second = await service.fetchHotspotBatch(30);
    expect(second.batchId).not.toBe(first.batchId);
    const secondSuggest = await service.suggestTopics({ count: 10 });
    expect(secondSuggest.batchId).toBe(second.batchId);
    expect(llm.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('写作要求变更：缓存 key 变化，下一次重新生成', async () => {
    const llm = makeScriptedLlm(async () => textStream(linesFor(10)));
    const { service } = await makeService(llm.llm, { writingProfile: PROFILE });

    await service.suggestTopics({ count: 10 });
    await service.setConfig({ writingProfile: { ...PROFILE, topics: ['新的主题方向'] } });
    await service.suggestTopics({ count: 10 });

    expect(llm.calls).toHaveLength(2);
    expect(userTextOf(llm.calls[1] ?? {})).toContain('新的主题方向');
  });
});
