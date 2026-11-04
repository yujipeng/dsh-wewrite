/**
 * 来源原文核读（v0.5 来源入管线）。
 *
 * brief.sources 指向的页面必须先被抓取并提取正文，写稿与事实门禁都以这份
 * 原文为依据；抓不到原文（超时/非 2xx/正文过短/非文本）时由管线抛
 * source-unavailable 暂停写稿，绝不凭标题凭空写。
 */

export interface SourceDocument {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly chars: number;
}

/** 未提取正文的原始页面：聚合页抽原文链接需要 HTML 与最终 URL。 */
export interface RawSourcePage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly html: string;
}

export interface SourceFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<SourceDocument>;
  /** 抓原始 HTML（不做正文阈值校验）；聚合页 → 原文直链抽取用。 */
  fetchHtml?(url: string, signal?: AbortSignal): Promise<RawSourcePage>;
}

export type SourceFetchErrorCode = 'timeout' | 'network' | 'http-status' | 'unsupported-type' | 'too-large' | 'empty-content' | 'shell-page';

export class SourceFetchError extends Error {
  constructor(
    readonly code: SourceFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

/** 正文下限：低于此长度视为登录墙/搜索壳/反爬页，不算拿到原文。 */
const MIN_CONTENT_CHARS = 600;
/** 正文上限：足够覆盖新闻全文，同时避免把整站导航塞进 run 记录。 */
const MAX_CONTENT_CHARS = 20000;
/** 搜索/聚合页的壳标题：抓到这些说明拿到的不是文章，而是检索结果页。 */
const SHELL_TITLES = ['搜狗搜索', '百度一下，你就知道', '微博', '微博搜索', '头条搜索'];

function isShellTitle(title: string): boolean {
  const value = title.trim();
  return SHELL_TITLES.some((shell) => value === shell || value.startsWith(shell));
}

/** 是否是可以作为写稿依据的文章：非搜狗中转/聚合页、非壳标题、正文达到下限。 */
export function isUsableSourceDocument(doc: SourceDocument): boolean {
  if (doc.chars < MIN_CONTENT_CHARS) return false;
  if (doc.url.includes('weixin.sogou.com')) return false;
  if (isShellTitle(doc.title)) return false;
  return true;
}
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

/** 普通浏览器 UA；微信公众号在部分网络下会返回「环境异常」验证页。 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 微信 iOS WebView UA：带 MicroMessenger 可让微信服务器按「App 内打开」放行正文。 */
const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003123) NetType/WIFI Language/zh_CN';

interface FetchAttempt {
  readonly userAgent: string;
  readonly referer?: string;
}

/** 抓取降级链：先普通 UA；只有正文过短（验证页/空壳）才换微信 UA + 微信 Referer 重试。 */
const FETCH_ATTEMPTS: readonly FetchAttempt[] = [
  { userAgent: BROWSER_UA },
  { userAgent: WECHAT_UA, referer: 'https://mp.weixin.qq.com/' },
];

const ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return ENTITY_MAP[lower] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(nav|header|footer|aside|form|svg|iframe|figure)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

function normalizeText(text: string): string {
  return text
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 提取页面标题（title / og:title）；正文抽取与聚合页诊断共用。 */
export function extractTitle(html: string): string {
  const titleMatch =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ??
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  return decodeEntities(titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 提取可读正文：优先 article / 公众号 js_content / main，兜底 body。 */
export function extractReadableText(html: string): { title: string; text: string } {
  const title = extractTitle(html);
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const candidates = [
    withoutNoise.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1],
    withoutNoise.match(/<[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i)?.[1],
    withoutNoise.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    withoutNoise.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1],
    withoutNoise,
  ];
  const raw = candidates.find((item) => item && normalizeText(stripTags(item)).length >= MIN_CONTENT_CHARS) ?? candidates[candidates.length - 1] ?? '';
  return { title, text: normalizeText(stripTags(raw)) };
}

export interface HttpSourceFetcherOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** HTTP 抓取器：跟随重定向、限制体积与耗时，返回提取后的正文。 */
export function createHttpSourceFetcher(options: HttpSourceFetcherOptions = {}): SourceFetcher {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const fetchRaw = async (url: string, attempt: FetchAttempt, signal: AbortSignal | undefined): Promise<RawSourcePage> => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchFn(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'user-agent': attempt.userAgent,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            ...(attempt.referer ? { referer: attempt.referer } : {}),
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SourceFetchError('timeout', `抓取来源超时（>${timeoutMs}ms）：${url}`);
        }
        throw new SourceFetchError(
          'network',
          `抓取来源失败：${error instanceof Error ? error.message : String(error)}（${url}）`,
        );
      }
      if (!response.ok) {
        throw new SourceFetchError('http-status', `来源返回 HTTP ${response.status}：${url}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)) {
        throw new SourceFetchError('unsupported-type', `来源不是可读文本（${contentType}）：${url}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new SourceFetchError('too-large', `来源页面过大（>${maxBytes} 字节），未做正文提取：${url}`);
      }
      const html = new TextDecoder('utf-8').decode(buffer);
      return { url, finalUrl: response.url || url, title: extractTitle(html), html };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  };

  const fetchOnce = async (url: string, attempt: FetchAttempt, signal: AbortSignal | undefined): Promise<SourceDocument> => {
    const page = await fetchRaw(url, attempt, signal);
    const { title, text } = extractReadableText(page.html);
    if (text.length < MIN_CONTENT_CHARS) {
      throw new SourceFetchError(
        'empty-content',
        `来源正文过短（${text.length} 字符 < ${MIN_CONTENT_CHARS}），可能是登录墙/搜索壳/反爬页：${url}`,
      );
    }
    const doc: SourceDocument = { url, title, text: text.slice(0, MAX_CONTENT_CHARS), chars: text.length };
    if (!isUsableSourceDocument(doc)) {
      throw new SourceFetchError('shell-page', `抓到的是检索/壳页面而不是文章（${title || '无标题'}）：${url}`);
    }
    return doc;
  };

  return {
    async fetch(url, signal) {
      let lastError: SourceFetchError | undefined;
      for (const attempt of FETCH_ATTEMPTS) {
        try {
          return await fetchOnce(url, attempt, signal);
        } catch (error) {
          const normalized =
            error instanceof SourceFetchError
              ? error
              : new SourceFetchError('network', `抓取来源失败：${error instanceof Error ? error.message : String(error)}（${url}）`);
          lastError = normalized;
          // 只有「页面可读但正文过短」才值得换微信 UA 重试；HTTP/网络/类型错误重试无意义。
          if (normalized.code !== 'empty-content') throw normalized;
        }
      }
      throw lastError ?? new SourceFetchError('empty-content', `来源正文过短：${url}`);
    },

    async fetchHtml(url, signal) {
      // 聚合页只取 HTML 抽原文链接：不套正文阈值，换 UA 只因 HTTP/网络错误重试一次。
      let lastError: SourceFetchError | undefined;
      for (const attempt of FETCH_ATTEMPTS) {
        try {
          return await fetchRaw(url, attempt, signal);
        } catch (error) {
          lastError =
            error instanceof SourceFetchError
              ? error
              : new SourceFetchError('network', `抓取来源失败：${error instanceof Error ? error.message : String(error)}（${url}）`);
          if (lastError.code === 'timeout') throw lastError;
        }
      }
      throw lastError ?? new SourceFetchError('network', `抓取来源失败：${url}`);
    },
  };
}
