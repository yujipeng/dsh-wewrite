/**
 * 阿里云百炼（DashScope 文生图，异步任务模式）。
 * 账号通常不支持同步调用（403 current user api does not support synchronous calls）：
 * 先提交任务拿 task_id，再轮询 /tasks/{id}，成功后下载结果图片。
 * 凭据走 WEWRITE_IMG_DASHSCOPE（Bearer）。
 */

import { ImageProviderError, type ImageGenResult, type ImageProvider, type ResolvedProviderConfig } from './types';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_MODEL = 'wanx2.1-t2i-turbo';
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

function classifyStatus(status: number): { code: 'AUTH' | 'RATE_LIMIT' | 'PROVIDER'; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'AUTH', retryable: false };
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true };
  return { code: 'PROVIDER', retryable: true };
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string; code?: string };
    return [payload?.code, payload?.message].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

export function createDashscopeProvider(fetchImpl?: typeof fetch): ImageProvider {
  const fetchFn = fetchImpl ?? fetch;

  return {
    id: 'dashscope',
    async generate(req, cfg: ResolvedProviderConfig): Promise<ImageGenResult> {
      const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
      const model = cfg.model ?? DEFAULT_MODEL;
      const auth = { Authorization: `Bearer ${cfg.apiKey}` };
      const [width, height] = req.size.split('x');

      let submit: Response;
      try {
        submit = await fetchFn(`${base}/services/aigc/text2image/image-synthesis`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-DashScope-Async': 'enable',
            ...auth,
          },
          body: JSON.stringify({
            model,
            input: { prompt: req.prompt },
            parameters: { size: `${width}*${height}`, n: req.n },
          }),
          signal: req.signal,
        });
      } catch (error) {
        if (req.signal?.aborted) throw new ImageProviderError({ providerId: 'dashscope', code: 'TIMEOUT', message: '请求已中止' });
        throw new ImageProviderError({
          providerId: 'dashscope',
          code: 'NETWORK',
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (!submit.ok) {
        const { code, retryable } = classifyStatus(submit.status);
        const detail = await readErrorDetail(submit);
        throw new ImageProviderError({
          providerId: 'dashscope',
          code,
          retryable,
          message: `HTTP ${submit.status}${detail ? ` ${detail}` : ''}`,
        });
      }

      const submitted = (await submit.json()) as { output?: { task_id?: string } };
      const taskId = submitted?.output?.task_id;
      if (!taskId) {
        throw new ImageProviderError({ providerId: 'dashscope', code: 'PROVIDER', message: '提交响应缺少 task_id' });
      }

      for (let poll = 0; poll < MAX_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (req.signal?.aborted) {
          throw new ImageProviderError({ providerId: 'dashscope', code: 'TIMEOUT', message: '请求已中止' });
        }
        let statusResponse: Response;
        try {
          statusResponse = await fetchFn(`${base}/tasks/${taskId}`, { headers: auth, signal: req.signal });
        } catch (error) {
          throw new ImageProviderError({
            providerId: 'dashscope',
            code: 'NETWORK',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (!statusResponse.ok) {
          const { code, retryable } = classifyStatus(statusResponse.status);
          throw new ImageProviderError({
            providerId: 'dashscope',
            code,
            retryable,
            message: `轮询返回 HTTP ${statusResponse.status}`,
          });
        }
        const data = (await statusResponse.json()) as {
          output?: { task_status?: string; message?: string; results?: { url?: string }[] };
        };
        const taskStatus = data?.output?.task_status;
        if (taskStatus === 'SUCCEEDED') {
          const urls = (data.output?.results ?? [])
            .map((item) => item.url)
            .filter((url): url is string => typeof url === 'string' && url.length > 0)
            .slice(0, req.n);
          if (!urls.length) {
            throw new ImageProviderError({ providerId: 'dashscope', code: 'PROVIDER', message: '任务成功但没有图片 URL' });
          }
          const images = [];
          for (const url of urls) {
            const download = await fetchFn(url, { signal: req.signal });
            if (!download.ok) {
              throw new ImageProviderError({
                providerId: 'dashscope',
                code: 'NETWORK',
                message: `图片下载返回 HTTP ${download.status}`,
              });
            }
            const buffer = Buffer.from(await download.arrayBuffer());
            images.push({
              buffer,
              mime: download.headers.get('content-type')?.split(';')[0] || 'image/png',
            });
          }
          return { images, model };
        }
        if (taskStatus === 'FAILED') {
          throw new ImageProviderError({
            providerId: 'dashscope',
            code: 'PROVIDER',
            message: data.output?.message ?? 'DashScope 任务失败',
          });
        }
      }

      throw new ImageProviderError({
        providerId: 'dashscope',
        code: 'TIMEOUT',
        message: `任务轮询超时（${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s）`,
      });
    },
  };
}
