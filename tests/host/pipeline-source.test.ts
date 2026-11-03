import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@/host/domain';
import { RunRecordSchema } from '@/host/domain';
import type { RunParams } from '@/shared/contract';
import { createPipelineEngine, type PipelineLlm, type RunStore } from '@/host/pipeline/engine';
import { createHttpSourceFetcher, extractReadableText, SourceFetchError, type SourceFetcher } from '@/host/pipeline/steps/source';
import type { SourceSearcher } from '@/host/pipeline/steps/source-search';

/**
 * 来源入管线（v0.5）：
 * - 抓取来源 URL → 提取正文 → 注入写稿提示词；
 * - 全部来源都取不到时 source 步失败 → run failed，outline/draft 不执行（暂停写稿）；
 * - 没有来源（纯主题写作）时 source 步 skipped=no-source，不阻断。
 */

const ARTICLE_HTML = `<html><head><title>罗技小狗表情包广告引争议</title>
<style>body{color:red}</style></head>
<body>
  <nav>网站导航</nav>
  <article>
    <h1>罗技被指暗讽消费者</h1>
    <p>11 月 2 日，罗技 G 影音旗舰店官方账号发布促销视频，使用小狗表情包做对比。</p>
    <p>客服回应称：小狗只是表情包，不是侮辱消费者。</p>
    <p>${'补充正文内容，包含时间、主体与回应细节。'.repeat(40)}</p>
  </article>
  <footer>版权信息</footer>
  <script>console.log('tracking')</script>
</body></html>`;

const baseParams: RunParams = {
  topicMode: 'fixed',
  topic: '罗技被骂上热搜',
  imageCount: 0,
  llm: { provider: 'test', model: 'test-model' },
};

class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();
  put(run: RunRecord): void {
    this.runs.set(run.id, run);
  }
  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }
  update(runId: string, patch: (run: RunRecord) => RunRecord): void {
    const current = this.runs.get(runId);
    if (current) this.runs.set(runId, patch(current));
  }
  all(): RunRecord[] {
    return [...this.runs.values()];
  }
}

const okStream = (text: string) =>
  (async function* () {
    yield { type: 'text-delta' as const, index: 0, text };
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
  })();

function makeEngine(options: { sourceFetcher?: SourceFetcher; llmText?: string; sourceSearch?: SourceSearcher } = {}) {
  const llmStream = vi.fn(async (_options: Record<string, unknown>) => okStream(options.llmText ?? '生成的成稿文本'));
  const store = new MemoryRunStore();
  const engine = createPipelineEngine({
    llm: { stream: llmStream as unknown as PipelineLlm['stream'] },
    store,
    sourceFetcher:
      options.sourceFetcher ??
      ({ fetch: vi.fn(async (url: string) => ({ url, title: '罗技小狗表情包广告引争议', text: '原文正文'.repeat(200), chars: 800 })) } as SourceFetcher),
    sourceSearch:
      options.sourceSearch ??
      ({ search: async () => [], resolve: async (url: string) => url } as SourceSearcher),
    gates: { run: async () => ({ passed: true, report: {} }) },
    renderer: { convert: () => '<section>x</section>' },
    images: { generate: async () => ({ bodyImageIds: [] }) },
  });
  return { engine, store, llmStream };
}

describe('extractReadableText', () => {
  it('提取 article 正文与标题，剔除脚本/导航/页脚', () => {
    const { title, text } = extractReadableText(ARTICLE_HTML);
    expect(title).toBe('罗技小狗表情包广告引争议');
    expect(text).toContain('11 月 2 日');
    expect(text).toContain('小狗只是表情包');
    expect(text).not.toContain('tracking');
    expect(text).not.toContain('网站导航');
    expect(text).not.toContain('版权信息');
  });
});

describe('createHttpSourceFetcher', () => {
  it('2xx HTML → SourceDocument（正文可读）', async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch,
    });
    const doc = await fetcher.fetch('https://news.example.test/a');
    expect(doc.url).toBe('https://news.example.test/a');
    expect(doc.title).toContain('罗技');
    expect(doc.text).toContain('罗技 G 影音旗舰店');
    expect(doc.chars).toBeGreaterThan(200);
  });

  it('HTTP 非 2xx → http-status 错误（不把错误页当原文）', async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => new Response('forbidden', { status: 403 })) as typeof fetch,
    });
    await expect(fetcher.fetch('https://news.example.test/blocked')).rejects.toMatchObject({ code: 'http-status' });
  });

  it('正文过短（登录墙/反爬壳）→ empty-content 错误', async () => {
    const fetcher = createHttpSourceFetcher({
      fetchImpl: (async () => new Response('<html><body><p>请登录</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
    });
    await expect(fetcher.fetch('https://news.example.test/wall')).rejects.toBeInstanceOf(SourceFetchError);
    await expect(fetcher.fetch('https://news.example.test/wall')).rejects.toMatchObject({ code: 'empty-content' });
  });
});

describe('管线 source 步', () => {
  it('抓到原文：source 步 succeeded，outline 提示词注入新闻原文', async () => {
    const { engine, store, llmStream } = makeEngine();
    const runId = await engine.start({
      trigger: 'manual',
      params: { ...baseParams, brief: { sources: ['https://news.example.test/a'], sourceTitle: '罗技小狗表情包广告引争议' } },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('succeeded');
    const sourceStep = run?.steps.find((step) => step.name === 'source');
    expect(sourceStep?.status).toBe('succeeded');
    expect((sourceStep?.metrics as { fetched?: { url: string }[] } | undefined)?.fetched?.[0]?.url).toBe('https://news.example.test/a');

    const firstCall = llmStream.mock.calls[0][0] as { messages: { content: { text: string }[] }[] };
    const prompt = firstCall.messages[0].content[0].text;
    expect(prompt).toContain('新闻原文');
    expect(prompt).toContain('原' + '文正文');
    expect(RunRecordSchema.safeParse(run).success).toBe(true);
  });

  it('全部来源抓取失败：暂停写稿——source 步 failed，outline/draft 保持 pending，LLM 零调用', async () => {
    const failing: SourceFetcher = {
      fetch: vi.fn(async () => {
        throw new SourceFetchError('http-status', '来源返回 HTTP 403：https://news.example.test/blocked');
      }),
    };
    const { engine, store, llmStream } = makeEngine({ sourceFetcher: failing });
    const runId = await engine.start({
      trigger: 'manual',
      params: { ...baseParams, brief: { sources: ['https://news.example.test/blocked'] } },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('source-unavailable');
    expect(run?.error?.message).toContain('暂停写稿');
    const steps = new Map(run?.steps.map((step) => [step.name, step]));
    expect(steps.get('source')?.status).toBe('failed');
    expect(steps.get('outline')?.status).toBe('pending');
    expect(steps.get('draft')?.status).toBe('pending');
    expect(llmStream).toHaveBeenCalledTimes(0);
  });

  it('没有来源：source 步 skipped=no-source，管线照常完成', async () => {
    const { engine, store } = makeEngine();
    const runId = await engine.start({ trigger: 'manual', params: baseParams });
    const run = store.get(runId);
    expect(run?.status).toBe('succeeded');
    const sourceStep = run?.steps.find((step) => step.name === 'source');
    expect(sourceStep?.status).toBe('succeeded');
    expect((sourceStep?.metrics as { skipped?: string } | undefined)?.skipped).toBe('no-source');
  });
});

describe('热搜聚合页 → 媒体报道', () => {
  it('微博热搜页：按标题检索媒体报道，解析直链后抓正文', async () => {
    const search = {
      search: vi.fn(async () => [
        { title: '罗技广告再被指侮辱用户，客服回应', url: 'https://weixin.sogou.com/link?url=abc', summary: '', publisher: '潇湘晨报' },
      ]),
      resolve: vi.fn(async () => 'https://mp.weixin.qq.com/s/abc'),
    };
    const fetcher = {
      fetch: vi.fn(async (url: string) => ({ url, title: '罗技广告再被指侮辱用户', text: '小狗表情包'.repeat(200), chars: 1000 })),
    };
    const { engine, store } = makeEngine({ sourceSearch: search, sourceFetcher: fetcher });
    const runId = await engine.start({
      trigger: 'manual',
      params: {
        ...baseParams,
        brief: { sources: ['https://s.weibo.com/weibo?q=%23罗技%23'], sourceTitle: '罗技广告再被指侮辱用户' },
      },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('succeeded');
    expect(search.search).toHaveBeenCalledWith('罗技广告再被指侮辱用户', 5, expect.anything());
    expect(search.resolve).toHaveBeenCalledWith('https://weixin.sogou.com/link?url=abc', expect.anything());
    expect(fetcher.fetch).toHaveBeenCalledWith('https://mp.weixin.qq.com/s/abc', expect.anything());
    const sourceStep = run?.steps.find((step) => step.name === 'source');
    expect((sourceStep?.metrics as { searched?: boolean } | undefined)?.searched).toBe(true);
  });

  it('检索不到报道 → 仍暂停写稿（source-unavailable）', async () => {
    const search = {
      search: vi.fn(async () => []),
      resolve: vi.fn(async (url: string) => url),
    };
    const { engine, store, llmStream } = makeEngine({ sourceSearch: search });
    const runId = await engine.start({
      trigger: 'manual',
      params: {
        ...baseParams,
        brief: { sources: ['https://s.weibo.com/weibo?q=%23罗技%23'], sourceTitle: '罗技广告再被指侮辱用户' },
      },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('source-unavailable');
    expect(run?.error?.message).toContain('检索不到');
    expect(llmStream).toHaveBeenCalledTimes(0);
  });
});

describe('来源假成功拦截（v0.5 修复）', () => {
  it('抓到搜狗中转页（241 字壳）→ 判失败并暂停', async () => {
    const fetcher = {
      fetch: vi.fn(async (url: string) => ({ url, title: '搜狗搜索', text: '搜狗搜索 相关结果'.repeat(20), chars: 241 })),
    };
    const { engine, store, llmStream } = makeEngine({ sourceFetcher: fetcher });
    const runId = await engine.start({
      trigger: 'manual',
      params: { ...baseParams, brief: { sources: ['https://weixin.sogou.com/link?url=abc'] } },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.code).toBe('source-unavailable');
    expect(run?.error?.message).toContain('检索/壳页面');
    expect(llmStream).toHaveBeenCalledTimes(0);
  });

  it('壳标题（搜狗搜索）即使正文很长也判失败', async () => {
    const fetcher = {
      fetch: vi.fn(async (url: string) => ({ url, title: '搜狗搜索', text: '正文'.repeat(400), chars: 800 })),
    };
    const { engine, store } = makeEngine({ sourceFetcher: fetcher });
    const runId = await engine.start({
      trigger: 'manual',
      params: { ...baseParams, brief: { sources: ['https://news.example.test/a'] } },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('检索/壳页面');
  });

  it('检索命中解析后仍是搜狗中转页 → 判失败并暂停', async () => {
    const search = {
      search: vi.fn(async () => [
        { title: '罗技广告再被指侮辱用户', url: 'https://weixin.sogou.com/link?url=abc', summary: '', publisher: '潇湘晨报' },
      ]),
      resolve: vi.fn(async (url: string) => url),
    };
    const { engine, store, llmStream } = makeEngine({ sourceSearch: search });
    const runId = await engine.start({
      trigger: 'manual',
      params: {
        ...baseParams,
        brief: { sources: ['https://s.weibo.com/weibo?q=%23罗技%23'], sourceTitle: '罗技广告再被指侮辱用户' },
      },
    });
    const run = store.get(runId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('未拿到文章直链');
    expect(llmStream).toHaveBeenCalledTimes(0);
  });
});
