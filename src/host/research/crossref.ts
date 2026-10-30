/**
 * I-23 Crossref DOI 核对（默认关闭）：
 * 只做确定性比对（题名/卷期页），失败/超时标记 error，不阻断成稿。
 * 关闭时 verifyClaimDois 直接返回，不发起任何外部请求。
 */

export type CrossrefStatus = 'verified' | 'not-found' | 'error' | 'skipped';

export interface CrossrefOptions {
  readonly enabled: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface CrossrefClaim {
  readonly id: string;
  readonly doi?: string;
}

export interface CrossrefLookup {
  readonly status: CrossrefStatus;
  readonly title?: string;
  readonly volume?: string;
  readonly page?: string;
  readonly reason?: string;
}

export interface CrossrefResult extends CrossrefLookup {
  readonly claimId: string;
  readonly doi: string;
}

export interface CrossrefReport {
  readonly enabled: boolean;
  readonly results: readonly CrossrefResult[];
  readonly issues: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CLAIMS = 10;

export async function lookupDoi(
  doi: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<CrossrefLookup> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (response.status === 404) return { status: 'not-found', reason: 'HTTP 404' };
    if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };
    const json = (await response.json()) as {
      message?: { title?: unknown; volume?: unknown; page?: unknown };
    };
    const message = json?.message ?? {};
    const title = Array.isArray(message.title) && typeof message.title[0] === 'string'
      ? message.title[0]
      : undefined;
    return {
      status: 'verified',
      ...(title ? { title } : {}),
      ...(typeof message.volume === 'string' ? { volume: message.volume } : {}),
      ...(typeof message.page === 'string' ? { page: message.page } : {}),
    };
  } catch {
    return { status: 'error', reason: '请求超时或失败' };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyClaimDois(
  claims: readonly CrossrefClaim[],
  options: CrossrefOptions,
): Promise<CrossrefReport> {
  if (!options.enabled) return { enabled: false, results: [], issues: [] };
  const selected = claims
    .filter((claim) => typeof claim.doi === 'string' && claim.doi.trim().length > 0)
    .slice(0, MAX_CLAIMS);
  const results = await Promise.all(
    selected.map(async (claim) => {
      const doi = claim.doi!.trim();
      return { claimId: claim.id, doi, ...(await lookupDoi(doi, options)) };
    }),
  );
  const issues = results
    .filter((result) => result.status === 'not-found')
    .map((result) => `DOI 未找到：${result.doi}`);
  return { enabled: true, results, issues };
}
