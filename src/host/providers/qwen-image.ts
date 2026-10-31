/**
 * 阿里云百炼 Qwen-Image 文生图（同步 multimodal-generation）。
 * 与 dashscope(wanx) 不同：
 * - endpoint: /services/aigc/multimodal-generation/generation
 * - 请求体: input.messages[{ role:'user', content:[{ text }] }]
 * - 响应: output.choices[].message.content[].image（URL，24h 有效）
 * 只支持同步调用；图片需要二次下载。
 */

import { ImageProviderError, type ImageGenResult, type ImageProvider, type ResolvedProviderConfig } from './types';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_MODEL = 'qwen-image-2.0';
const MAX_IMAGES = 6;

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

/** 从同步响应中收集图片 URL；兼容多个 choices / content 元素。 */
export function extractQwenImageUrls(payload: unknown): string[] {
  const output = (payload as { output?: { choices?: unknown } } | undefined)?.output;
  if (!output || !Array.isArray(output.choices)) return [];
  const urls: string[] = [];
  for (const choice of output.choices) {
    const content = (choice as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const image = (item as { image?: unknown } | null)?.image;
      if (typeof image === 'string' && image.length > 0) urls.push(image);
    }
  }
  return urls;
}

export function createQwenImageProvider(fetchImpl?: typeof fetch): ImageProvider {
  const fetchFn = fetchImpl ?? fetch;

  return {
    id: 'qwen_image',
    async generate(req, cfg: ResolvedProviderConfig): Promise<ImageGenResult> {
      const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
      const model = cfg.model ?? DEFAULT_MODEL;
      const [width, height] = req.size.split('x');
      const count = Math.max(1, Math.min(MAX_IMAGES, req.n));

      let response: Response;
      try {
        response = await fetchFn(`${base}/services/aigc/multimodal-generation/generation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: {
              messages: [
                {
                  role: 'user',
                  content: [{ text: req.prompt }],
                },
              ],
            },
            parameters: {
              size: `${width}*${height}`,
              n: count,
              prompt_extend: true,
              watermark: false,
            },
          }),
          signal: req.signal,
        });
      } catch (error) {
        if (req.signal?.aborted) {
          throw new ImageProviderError({ providerId: 'qwen_image', code: 'TIMEOUT', message: '请求已中止' });
        }
        throw new ImageProviderError({
          providerId: 'qwen_image',
          code: 'NETWORK',
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (!response.ok) {
        const { code, retryable } = classifyStatus(response.status);
        const detail = await readErrorDetail(response);
        throw new ImageProviderError({
          providerId: 'qwen_image',
          code,
          retryable,
          message: `HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
        });
      }

      const payload = (await response.json()) as {
        code?: string;
        message?: string;
        output?: { choices?: unknown };
      };
      if (payload.code || payload.message) {
        throw new ImageProviderError({
          providerId: 'qwen_image',
          code: 'PROVIDER',
          message: [payload.code, payload.message].filter(Boolean).join(' '),
        });
      }

      const urls = extractQwenImageUrls(payload).slice(0, count);
      if (!urls.length) {
        throw new ImageProviderError({
          providerId: 'qwen_image',
          code: 'PROVIDER',
          message: '响应缺少图片 URL',
        });
      }

      const images = [];
      for (const url of urls) {
        let download: Response;
        try {
          download = await fetchFn(url, { signal: req.signal });
        } catch (error) {
          throw new ImageProviderError({
            providerId: 'qwen_image',
            code: 'NETWORK',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (!download.ok) {
          throw new ImageProviderError({
            providerId: 'qwen_image',
            code: 'NETWORK',
            message: `图片下载返回 HTTP ${download.status}`,
          });
        }
        images.push({
          buffer: Buffer.from(await download.arrayBuffer()),
          mime: download.headers.get('content-type')?.split(';')[0] || 'image/png',
        });
      }

      return { images, model };
    },
  };
}
