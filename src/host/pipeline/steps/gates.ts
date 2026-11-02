/**
 * 质量门禁步（F6）：strict 门禁 + 编号配图一致性。
 * 移植自源管线 quality_validate.mjs --strict 与 validate_numbering.mjs 的判定内核：
 * 禁用词、内部标记、句长方差、信息密度、有序列表编号连续性、配图编号一致。
 * 语义取逻辑（判定阈值同源），CLI/报告排版不搬。
 */

import type { GatesRunner } from '../engine';
import { verifyClaimDois, type CrossrefReport } from '../../research/crossref';

/** 禁用词（源管线 BANNED_PATTERNS 同集）。 */
const BANNED_WORDS = [
  '总而言之', '值得一提', '不容忽视', '毋庸置疑', '综上所述', '由此可见', '显而易见', '不言而喻',
  '绝绝子', 'yyds', '破防了', '好家伙', '就一个路径问题', '整挺好', 'DNA动了',
] as const;

/** 内部标记：编辑锚点 / 待填占位（emoji 以转义书写，源码不落字面）。 */
const INTERNAL_MARKER_PATTERNS: readonly RegExp[] = [
  /\u270F\uFE0F\s*编辑(?:建议|提醒)/g,
  /<!--[\s\S]*?编辑(?:建议|提醒)[\s\S]*?-->/g,
  /[\[【]\s*请填写[^\]】]*[\]】]/g,
  /[\[【]\s*待补充[^\]】]*[\]】]/g,
  /^\s*(?:待确认)\s*[：:].*$/gm,
  /(?:事实边界|核验来源)\s*[：:]/g,
];

/** 具体细节特征（数字+单位 / 语义化版本号 / 行内代码 / 金额）。 */
const SPECIFIC_PATTERNS: readonly RegExp[] = [
  /\d+[\.\d]*\s*(?:秒|分钟|小时|天|月|年|%|元|美元|GB|MB|KB|文件|行|次|轮)/g,
  /`[^`]+`/g,
  /\$[\d,]+/g,
  /v?\d+\.\d+(?:\.\d+)?/g,
];

const cpLength = (text: string): number => [...text].length;

function countMatches(text: string, regex: RegExp): number {
  const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  return (text.match(global) ?? []).length;
}

interface SentenceStats {
  count: number;
  mean: number;
  varianceRatio: number;
}

function analyzeSentences(text: string): SentenceStats {
  const sentences = text.split(/[。！？\n]/).map((part) => part.trim()).filter((part) => cpLength(part) > 5);
  if (!sentences.length) return { count: 0, mean: 0, varianceRatio: 0 };
  const lengths = sentences.map(cpLength);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const std =
    lengths.length > 1
      ? Math.sqrt(lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / (lengths.length - 1))
      : 0;
  return { count: lengths.length, mean, varianceRatio: mean > 0 ? std / mean : 0 };
}

/** 有序列表编号连续性：每个有序列表必须从 1 起且逐项 +1（栅栏代码块内不检查）。 */
function auditNumbering(markdown: string): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  let inFence = false;
  let expected = 1;
  let listSeen = false;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^([ \t]*)(\d+)[.)]\s+\S/);
    if (!match) {
      if (listSeen) {
        listSeen = false;
        expected = 1;
      }
      continue;
    }
    const value = Number(match[2]);
    if (!listSeen) {
      listSeen = true;
      expected = 1;
    }
    if (value !== expected) {
      issues.push(`有序列表编号断裂：期望 ${expected}，实际 ${value}（行：${line.trim().slice(0, 40)}）`);
    }
    expected = value + 1;
  }
  return { passed: issues.length === 0, issues };
}

/** 配图一致性：正文图占位/引用按出现顺序编号时，编号必须连续且与图片计数一致。 */
function auditFigureNumbering(markdown: string, imageCount: number): { passed: boolean; issues: string[] } {
  const references = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
  const numbered = references.map((ref) => (ref[1] ?? '').match(/^图\s*(\d+)/));
  const issues: string[] = [];
  const explicit = numbered.filter(Boolean) as RegExpExecArray[];
  for (let index = 0; index < explicit.length; index += 1) {
    if (Number(explicit[index][1]) !== index + 1) {
      issues.push(`配图编号不连续：第 ${index + 1} 张被标为 图${explicit[index][1]}`);
      break;
    }
  }
  if (references.length !== imageCount && imageCount > 0) {
    issues.push(`配图数不一致：正文引用 ${references.length} 处，管线产图 ${imageCount} 张`);
  }
  return { passed: issues.length === 0, issues };
}

// ── 范文重合（I-24）：防止整句搬运范文；只告警，不阻断 ────────────────────────

/** 触发告警的最短连续重合长度（按归一化后的汉字/字母/数字计）。 */
export const EXEMPLAR_OVERLAP_MIN_RUN = 15;

/** 归一化：去掉代码块、Markdown 结构、空白与标点，只留汉字/字母/数字，避免排版差异漏检。 */
function normalizeForOverlap(text: string): string {
  return text
    .replace(/(```|~~~)[\s\S]*?\1/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
}

/** 返回第一段 ≥ minRun 的连续重合文本；没有则 null。 */
export function findExemplarOverlap(text: string, excerpt: string, minRun = EXEMPLAR_OVERLAP_MIN_RUN): string | null {
  const source = [...normalizeForOverlap(text)];
  const sample = [...normalizeForOverlap(excerpt)];
  if (source.length < minRun || sample.length < minRun) return null;
  const windows = new Set<string>();
  for (let i = 0; i + minRun <= sample.length; i += 1) windows.add(sample.slice(i, i + minRun).join(''));
  for (let i = 0; i + minRun <= source.length; i += 1) {
    const window = source.slice(i, i + minRun).join('');
    if (windows.has(window)) return window;
  }
  return null;
}

/** 范文重合审计：命中的范文序号 + 重合片段；只用于报告，不参与 passed。 */
export function auditExemplarOverlap(
  markdown: string,
  excerpts: readonly string[],
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  excerpts.forEach((excerpt, index) => {
    const run = findExemplarOverlap(markdown, excerpt);
    if (run) issues.push(`与范文 ${index + 1} 连续重合 ${EXEMPLAR_OVERLAP_MIN_RUN} 字：「${run}」`);
  });
  return { passed: issues.length === 0, issues };
}

export interface GatesReport {
  readonly strict: true;
  readonly bannedWords: readonly { readonly pattern: string; readonly count: number }[];
  readonly internalMarkers: number;
  readonly sentenceCount: number;
  readonly sentenceVariance: number;
  readonly infoDensityPer500: number;
  readonly codeBlocks: number;
  readonly numbering: { readonly passed: boolean; readonly issues: readonly string[] };
  readonly figureNumbering: { readonly passed: boolean; readonly issues: readonly string[] };
  /** 来源门禁（v0.5）：仅在启动 brief 携带 sources 时启用，否则 undefined（门禁不激活）。 */
  readonly sources: { readonly passed: boolean; readonly issues: readonly string[] } | undefined;
  /** 大纲骨架终检（v0.5）：仅在启动 brief 携带 outline 时启用——draft 层改写/遗漏给定节的最后防线。 */
  readonly outlineSkeleton: { readonly passed: boolean; readonly issues: readonly string[] } | undefined;
  /** I-11：mustInclude / mustAvoid 机械门禁；未携带时 undefined。 */
  readonly contract: { readonly passed: boolean; readonly issues: readonly string[] } | undefined;
  /** I-22：事实主张—来源门禁；未携带 claims 时 undefined。 */
  readonly claims: { readonly passed: boolean; readonly issues: readonly string[] } | undefined;
  /** I-24：与范文的连续重合告警；未携带 styleExemplars 时 undefined。只告警，不参与 passed。 */
  readonly exemplarOverlap: { readonly passed: boolean; readonly issues: readonly string[] } | undefined;
  /** 事实一致性（v0.5 来源入管线）：仅携带 sourceTexts 时启用；不一致阻断渲染。 */
  readonly sourceConsistency: { readonly passed: boolean; readonly issues: readonly string[] } | undefined;
  /** I-23：Crossref DOI 核对结果（只记录，不参与 passed 判定）。 */
  readonly crossref?: CrossrefReport;
  readonly issues: readonly string[];
}

export interface GateClaim {
  readonly id: string;
  readonly text: string;
  readonly type: 'fact' | 'opinion';
  readonly doi?: string;
  readonly sourceIds?: readonly string[];
  readonly status?: 'supported' | 'bounded';
  readonly boundary?: string;
}

export interface RunGatesInput {
  readonly markdown: string;
  readonly imageCount?: number;
  /** 启动 brief 的来源 URL（v0.5 硬绑）：给了即启用来源门禁。 */
  readonly sources?: readonly string[];
  /** 用户提供的原文文本（主题/标题/思路/大纲）——其中出现的 URL 视为已授权，不算编造。 */
  readonly userText?: readonly string[];
  /** 启动 brief 的给定大纲节名（v0.5 骨架绑）：给了即启用骨架终检。 */
  readonly outlineSkeleton?: readonly string[];
  /** I-11：必须原样出现的事实/机制。 */
  readonly mustInclude?: readonly string[];
  /** I-11：不得原样出现的内容。 */
  readonly mustAvoid?: readonly string[];
  /** I-22：主张—来源结构；fact 类必须有 sourceIds。 */
  readonly claims?: readonly GateClaim[];
  /** I-24：范文正文（仅 excerpt）；给了即启用重合告警，不进入 issues、不阻断。 */
  readonly styleExemplars?: readonly string[];
  /** 来源原文（source 步抓取结果）：给了即启用事实一致性门禁。 */
  readonly sourceTexts?: readonly GateSourceText[];
}

export interface GateSourceText {
  readonly url: string;
  readonly title?: string;
  readonly text: string;
}

/** 归一化比较键：去空白与常见标点，容忍排版差异。 */
function normalizeForMatch(text: string): string {
  return text.replace(/[\s\u3000，。！？、；：""''（）()《》【】\-—…·.,!?;:'"]+/g, '');
}

const YEAR_PATTERN = /(?:19|20)\d{2}\s*年/g;

/** 引语模式：中文弯引号与英文双引号，8–80 字（过短的多为强调词，噪音大）。 */
const QUOTE_PATTERNS: readonly RegExp[] = [/“([^”]{8,80})”/g, /"([^"]{8,80})"/g];

/**
 * 事实一致性门禁（v0.5 来源入管线）：
 * 成稿里的年份与引号引语必须能在来源原文中找到——防止把旧闻/别的新闻套进本次热点。
 * 来源完全没提年份时跳过该规则；引语最多报 3 条，避免刷屏。
 */
export function auditFactConsistency(
  markdown: string,
  sourceTexts: readonly GateSourceText[],
): { passed: boolean; issues: string[] } {
  const corpusRaw = sourceTexts.map((doc) => `${doc.title ?? ''}\n${doc.text}`).join('\n');
  const corpus = normalizeForMatch(corpusRaw);
  if (!corpus) return { passed: true, issues: [] };
  const issues: string[] = [];

  const sourceYears = new Set<string>();
  for (const match of corpusRaw.matchAll(YEAR_PATTERN)) sourceYears.add(match[0].replace(/\s+/g, ''));
  if (sourceYears.size) {
    const draftYears = new Set<string>();
    for (const match of markdown.matchAll(YEAR_PATTERN)) draftYears.add(match[0].replace(/\s+/g, ''));
    for (const year of draftYears) {
      if (issues.length >= 3) break;
      if (!sourceYears.has(year)) issues.push(`成稿提到 ${year}，但来源原文中没有这个年份（疑似旧闻或虚构）`);
    }
  }

  const quotes = new Set<string>();
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of markdown.matchAll(pattern)) quotes.add(match[1].trim());
  }
  let quoteIssues = 0;
  for (const quote of quotes) {
    if (quoteIssues >= 3) break;
    if (quote.includes('图片待生成')) continue;
    const needle = normalizeForMatch(quote);
    if (needle.length < 8) continue;
    if (!corpus.includes(needle)) {
      issues.push(`引语未在来源原文中找到（疑似虚构引语）：「${quote.slice(0, 40)}${quote.length > 40 ? '…' : ''}」`);
      quoteIssues += 1;
    }
  }
  return { passed: issues.length === 0, issues };
}

// ── 来源门禁（v0.5 docs/v0.5-launch-brief.md §2「来源」硬绑）──────────────────
// 微信会静默剥离 <a> 锚标签——所以「用上来源」必须以裸 URL 文本出现，藏在
// Markdown 链接语法 [](url) 里的 URL 渲染后即丢失，不算可见。

const URL_PATTERN = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&+;,=%-]+/g;

/** 归一化比较键：去空白与尾斜杠（大小写保留——路径段大小写敏感）。 */
function urlKey(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 剥掉 Markdown 链接/图片语法，只留可见文本域（链接文字保留，URL 位置丢弃）。 */
function stripLinkUrls(markdown: string): string {
  return markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$2');
}

/** 剥掉围栏代码块（代码块里的 URL 是示意内容，不算引用，也不算编造来源）。 */
function stripCodeFences(markdown: string): string {
  return markdown.replace(/(```|~~~)[\s\S]*?\1/g, '');
}

/** 可见文本域包含判定：容忍尾斜杠差异（给定 a.com/x/ 成文写 a.com/x 视为出现）。 */
function visibleContainsUrl(visibleText: string, url: string): boolean {
  const trimmed = url.trim();
  const variants = [trimmed, trimmed.replace(/\/+$/, '')];
  return variants.some((variant) => variant.length > 0 && visibleText.includes(variant));
}

/** 来源可见性：每条给定 URL 必须以裸文本出现在正文（链接语法里的不算）。 */
function auditSourceVisibility(markdown: string, sources: readonly string[]): { passed: boolean; issues: string[] } {
  const visibleText = stripLinkUrls(markdown);
  const issues = sources
    .filter((url) => !visibleContainsUrl(visibleText, url))
    .map((url) => `来源未以可见 URL 出现在正文（微信会剥离链接语法，需写成裸文本）：${url}`);
  return { passed: issues.length === 0, issues };
}

/** engine draft 自愈判据（v0.5）：给定来源是否已以裸文本可见（供重写触发，语义同 auditSourceVisibility）。 */
export function isSourceUrlVisible(markdown: string, url: string): boolean {
  return visibleContainsUrl(stripLinkUrls(markdown), url);
}

/** 编造拦截：正文出现的 URL（代码块除外）必须属于给定来源或用户原文带出的 URL；
 *  给定来源的更深路径（a.com/x → a.com/x/section）视为同源延伸，放行。 */
function auditInventedSources(markdown: string, allowed: readonly string[]): { passed: boolean; issues: string[] } {
  const allowedKeys = allowed.map(urlKey).filter(Boolean);
  const allowedByPrefix = (key: string): boolean =>
    allowedKeys.some(
      (candidate) => key === candidate || (key.startsWith(candidate) && (candidate.endsWith('/') || key.charAt(candidate.length) === '/')),
    );
  const text = stripCodeFences(markdown);
  const issues: string[] = [];
  const flagged = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const found = urlKey(match[0].replace(/[.,;:，。；：、]+$/, ''));
    if (!found || allowedByPrefix(found) || flagged.has(found)) continue;
    flagged.add(found);
    issues.push(`正文包含未提供的来源 URL（疑似编造，删除或换成给定来源）：${found}`);
  }
  return { passed: issues.length === 0, issues };
}

/** 门禁判定：任一硬项不过即 passed=false（strict 语义，未过阻断默认推送路径，AC-7）。 */
export function runQualityGates(input: RunGatesInput): { passed: boolean; report: GatesReport } {
  const text = input.markdown;
  const bannedWords = BANNED_WORDS.flatMap((word) => {
    const count = countMatches(text, new RegExp(word, 'g'));
    return count ? [{ pattern: word, count }] : [];
  });
  const internalMarkers = INTERNAL_MARKER_PATTERNS.reduce((acc, regex) => acc + countMatches(text, regex), 0);
  const sentence = analyzeSentences(text);
  const chars = cpLength(text);
  const detailCount = SPECIFIC_PATTERNS.reduce((acc, regex) => acc + countMatches(text, regex), 0);
  const infoDensity = chars > 0 ? detailCount / (chars / 500) : 0;
  const codeBlocks = countMatches(text, /```[\s\S]*?```/g);
  const numbering = auditNumbering(text);
  const figureNumbering = auditFigureNumbering(text, input.imageCount ?? 0);
  const sources = input.sources?.length
    ? (() => {
        // 授权集 = 给定来源 + 用户原文（主题/标题/思路/大纲）里带出的 URL（提取而非整句比对）。
        const userUrls = (input.userText ?? []).flatMap((text) =>
          [...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:，。；：、]+$/, '')),
        );
        const allowed = [...input.sources, ...userUrls];
        const visibility = auditSourceVisibility(text, input.sources);
        const invented = auditInventedSources(text, allowed);
        const issues = [...visibility.issues, ...invented.issues];
        return { passed: issues.length === 0, issues };
      })()
    : undefined;
  const outlineSkeleton = input.outlineSkeleton?.length
    ? (() => {
        const issues = input.outlineSkeleton
          .filter((section) => !text.includes(section))
          .map((section) => `大纲骨架：给定节「${section}」未原样出现在成稿`);
        return { passed: issues.length === 0, issues };
      })()
    : undefined;

  // I-11：合同硬项——按字面包含判定；不用正则，天然避免元字符误伤。
  const contract = input.mustInclude?.length || input.mustAvoid?.length
    ? (() => {
        const issues: string[] = [];
        for (const item of input.mustInclude ?? []) {
          if (!text.includes(item)) issues.push(`缺少必须出现的内容：${item}`);
        }
        for (const item of input.mustAvoid ?? []) {
          if (text.includes(item)) issues.push(`出现禁止内容：${item}`);
        }
        return { passed: issues.length === 0, issues };
      })()
    : undefined;

  const claims = input.claims?.length
    ? (() => {
        const issues: string[] = [];
        const providedSources = new Set((input.sources ?? []).map((source) => source.trim()));
        for (const claim of input.claims ?? []) {
          if (claim.type !== 'fact') continue;
          const sourceIds = (claim.sourceIds ?? []).map((id) => id.trim()).filter(Boolean);
          if (sourceIds.length === 0) {
            issues.push(`事实主张缺少来源：${claim.text.slice(0, 60)}`);
            continue;
          }
          if (providedSources.size > 0) {
            for (const sourceId of sourceIds) {
              if (!providedSources.has(sourceId)) issues.push(`事实主张引用了未提供的来源：${sourceId}`);
            }
          }
        }
        return { passed: issues.length === 0, issues };
      })()
    : undefined;

  // I-24：范文重合只写报告，不进入 issues（不阻断）。
  const exemplarOverlap = input.styleExemplars?.length
    ? auditExemplarOverlap(text, input.styleExemplars)
    : undefined;

  // v0.5：事实一致性——成稿年份/引语必须能在来源原文中找到，否则阻断渲染。
  const sourceConsistency = input.sourceTexts?.length
    ? auditFactConsistency(text, input.sourceTexts)
    : undefined;

  const issues: string[] = [];
  if (bannedWords.length) issues.push(`禁用词命中 ${bannedWords.length} 组`);
  if (internalMarkers) issues.push(`内部标记残留 ${internalMarkers} 处`);
  if (sentence.count > 0 && sentence.varianceRatio < 0.3) issues.push('句长方差过低，节奏单调');
  if (chars > 500 && infoDensity < 1) issues.push('信息密度不足（每 500 字具体细节 < 1 处）');
  if (chars > 0 && chars < 300) issues.push('正文过短（< 300 字）');
  if (!numbering.passed) issues.push(...numbering.issues);
  if (!figureNumbering.passed) issues.push(...figureNumbering.issues);
  if (sources && !sources.passed) issues.push(...sources.issues);
  if (outlineSkeleton && !outlineSkeleton.passed) issues.push(...outlineSkeleton.issues);
  if (contract && !contract.passed) issues.push(...contract.issues);
  if (claims && !claims.passed) issues.push(...claims.issues);
  if (sourceConsistency && !sourceConsistency.passed) issues.push(...sourceConsistency.issues);

  const report: GatesReport = {
    strict: true,
    bannedWords,
    internalMarkers,
    sentenceCount: sentence.count,
    sentenceVariance: Number(sentence.varianceRatio.toFixed(2)),
    infoDensityPer500: Number(infoDensity.toFixed(1)),
    codeBlocks,
    numbering,
    figureNumbering,
    sources,
    outlineSkeleton,
    contract,
    claims,
    exemplarOverlap,
    sourceConsistency,
    issues,
  };
  return { passed: issues.length === 0, report };
}

/** engine 装配适配器（GatesRunner 形状；来源/骨架门禁输入透传）。 */
export const qualityGatesRunner: GatesRunner = {
  async run(input: {
    markdown: string;
    sources?: readonly string[];
    userText?: readonly string[];
    outlineSkeleton?: readonly string[];
    mustInclude?: readonly string[];
    mustAvoid?: readonly string[];
    claims?: readonly GateClaim[];
    styleExemplars?: readonly string[];
    sourceTexts?: readonly GateSourceText[];
    crossref?: { enabled: boolean; fetchImpl?: typeof fetch; timeoutMs?: number };
  }) {
    const result = runQualityGates({
      markdown: input.markdown,
      ...(input.sources?.length ? { sources: input.sources, userText: input.userText } : {}),
      ...(input.outlineSkeleton?.length ? { outlineSkeleton: input.outlineSkeleton } : {}),
      ...(input.mustInclude?.length ? { mustInclude: input.mustInclude } : {}),
      ...(input.mustAvoid?.length ? { mustAvoid: input.mustAvoid } : {}),
      ...(input.claims?.length ? { claims: input.claims } : {}),
      ...(input.styleExemplars?.length ? { styleExemplars: input.styleExemplars } : {}),
      ...(input.sourceTexts?.length ? { sourceTexts: input.sourceTexts } : {}),
    });
    if (!input.crossref) return result;
    // I-23：DOI 核对只写报告，不改 passed（默认关闭时 verifyClaimDois 直接返回，不发请求）。
    const crossref = await verifyClaimDois(input.claims ?? [], {
      enabled: input.crossref.enabled,
      ...(input.crossref.fetchImpl ? { fetchImpl: input.crossref.fetchImpl } : {}),
      ...(input.crossref.timeoutMs ? { timeoutMs: input.crossref.timeoutMs } : {}),
    });
    return { passed: result.passed, report: { ...result.report, crossref } };
  },
};
