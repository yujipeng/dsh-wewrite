/**
 * 图片步装配（F7 / AC-9）：providers fallback 链 + ImageRecord 产线。
 * 从 service 拆出（单文件 <=300 行纪律）；凭据经注入的 resolver 读取（ADR-006）。
 */

import { randomUUID } from 'node:crypto';
import { CREDENTIAL_REFS, DEFAULT_IMAGE_PROVIDER_CHAIN, IMAGE_PROVIDER_IDS, type ImageProviderId } from '../shared/image-provider-ids';
import type { ImageProviderConfig } from '../shared/contract';
import type { ImageRecord, SettingsRecord } from './domain';
import type { ImagesGenerator } from './pipeline/engine';
import { runImageFallback } from './providers/registry';
import { chooseProviderSize } from './providers/capabilities';
import { processForWeChat } from './images/postprocess';
import type { ImageGenRequest, ImageProvider, ImageSize, ResolvedProviderConfig } from './providers/types';
import { createAzureOpenAiProvider } from './providers/azure-openai';
import { createDoubaoProvider } from './providers/doubao';
import { createDashscopeProvider } from './providers/dashscope';
import { createGeminiProvider } from './providers/gemini';
import { createJimengProvider } from './providers/jimeng';
import { createMinimaxProvider } from './providers/minimax';
import { createOpenAiProvider } from './providers/openai';
import { createOpenrouterProvider } from './providers/openrouter';
import { createReplicateProvider } from './providers/replicate';

export const PROVIDER_FACTORIES: Readonly<Record<ImageProviderId, (fetchImpl?: typeof fetch) => ImageProvider>> = {
  openai: createOpenAiProvider,
  doubao: createDoubaoProvider,
  dashscope: createDashscopeProvider,
  jimeng: createJimengProvider,
  minimax: createMinimaxProvider,
  azure_openai: createAzureOpenAiProvider,
  gemini: createGeminiProvider,
  openrouter: createOpenrouterProvider,
  replicate: createReplicateProvider,
};

export interface ImagesGeneratorDeps {
  readonly getSettings: () => SettingsRecord;
  readonly resolveCredential: (ref: string) => Promise<string | undefined>;
  readonly now: () => Date;
  readonly persist: (records: readonly ImageRecord[]) => Promise<void>;
  /** 传输层注入（测试路由 / 出口代理），缺省走全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

/** 微信封面 2.35:1；正文 16:9（I-02 目标尺寸，1280 宽已满足封面 900×383 建议）。 */
const COVER_TARGET = { width: 1280, height: 545 } as const;
const BODY_TARGET = { width: 1280, height: 720 } as const;
const COVER_SIZE: ImageSize = '1280x545';
const BODY_SIZE: ImageSize = '1280x720';

export function createImagesGenerator(deps: ImagesGeneratorDeps): ImagesGenerator {
  return {
    generate: async ({ count, articleId }) => {
      const settings = deps.getSettings();
      const chain = settings.imageProviders.length
        ? settings.imageProviders
        : DEFAULT_IMAGE_PROVIDER_CHAIN.map((providerId): ImageProviderConfig => ({
            providerId,
            credentialRef: CREDENTIAL_REFS.image(providerId),
          }));
      const keys = await Promise.all(
        chain.map(async (entry) => String((await deps.resolveCredential(entry.credentialRef)) ?? '')),
      );
      const configs = new Map<ImageProviderId, ResolvedProviderConfig>(
        chain.map((entry, index) => [
          entry.providerId,
          {
            apiKey: keys[index],
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
            ...(entry.model ? { model: entry.model } : {}),
          },
        ]),
      );
      const providers = chain
        .filter((entry) => (IMAGE_PROVIDER_IDS as readonly string[]).includes(entry.providerId))
        .map((entry) => PROVIDER_FACTORIES[entry.providerId](deps.fetchImpl));
      const resolveConfig = (providerId: ImageProviderId): ResolvedProviderConfig =>
        configs.get(providerId) ?? { apiKey: '' };

      const make = async (
        prompt: string,
        kind: 'cover' | 'body',
        target: { width: number; height: number },
        targetSize: ImageSize,
      ): Promise<ImageRecord> => {
        const req: ImageGenRequest = { prompt, size: targetSize, n: 1 };
        const outcome = await runImageFallback(providers, resolveConfig, req, (providerId) =>
          chooseProviderSize(providerId, targetSize),
        );
        const image = outcome.result.images[0];
        // I-02/I-03：裁剪到微信目标比例 + 压缩到 <1MB；sharp 不可用时原样返回，预检兜底。
        const processed = await processForWeChat(
          image?.buffer ?? Buffer.alloc(0),
          image?.mime ?? 'image/png',
          target,
        );
        return {
          v: 1,
          id: `img_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          // P0-1：真实文章 id 溯源（render 步落库后回传；无绑定场景兜底占位）
          articleId: articleId ?? 'pending',
          kind,
          mime: processed.mime,
          base64: processed.buffer.toString('base64'),
          provider: outcome.providerId,
          model: outcome.result.model,
          prompt,
          bytes: processed.bytes,
          ...(processed.width > 0 ? { width: processed.width } : {}),
          ...(processed.height > 0 ? { height: processed.height } : {}),
          compressed: processed.compressed,
          createdAt: deps.now().toISOString(),
        };
      };

      const cover = await make('为文章生成封面图：风格克制、信息密度高，深色纯色背景，无文字水印', 'cover', COVER_TARGET, COVER_SIZE);
      const bodies: ImageRecord[] = [];
      for (let index = 0; index < count; index += 1) {
        bodies.push(
          await make(`正文配图 ${index + 1}：克制的信息图风格，单主题，无文字水印`, 'body', BODY_TARGET, BODY_SIZE),
        );
      }
      const stored = [cover, ...bodies];
      await deps.persist(stored);
      return { coverImageId: stored[0].id, bodyImageIds: bodies.map((record) => record.id) };
    },
  };
}
