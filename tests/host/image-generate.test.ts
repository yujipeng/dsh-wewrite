import { describe, expect, it } from 'vitest';
import { WeWriteService } from '@/host/service';
import { countImagePlaceholders } from '@/host/images/placeholders';
import { MemoryDomain, makeCredentials, makeLlm, silentLogger } from './service-harness';

interface GenerateInput {
  count: number;
  includeCover?: boolean;
  includeBody?: boolean;
}

async function setup() {
  const service = await WeWriteService.open({
    domain: new MemoryDomain(),
    credentials: makeCredentials({}).service,
    llm: { stream: makeLlm('').stream },
    now: () => new Date('2026-10-31T00:00:00.000Z'),
    logger: silentLogger,
  });
  const calls: GenerateInput[] = [];
  let counter = 0;
  (service as unknown as {
    buildImageGenerator: () => {
      generate: (input: GenerateInput) => Promise<{
        coverImageId?: string;
        bodyImageIds: string[];
      }>;
    };
  }).buildImageGenerator = () => ({
    generate: async (input) => {
      calls.push(input);
      counter += 1;
      return {
        ...(input.includeCover ? { coverImageId: `img_cover_${counter}` } : {}),
        bodyImageIds: input.includeBody
          ? Array.from({ length: input.count }, (_, index) => `img_body_${counter}_${index}`)
          : [],
      };
    },
  });
  return { service, calls };
}

async function save(service: WeWriteService, markdown: string, title = '配图测试') {
  return service.saveArticle({
    slug: 'image-fixture',
    title,
    digest: '摘要',
    markdown,
    theme: 'professional-clean',
  });
}

describe('image/generate service（首图/内图/替换/占位补齐）', () => {
  it('只生成内图：不产封面，按正文占位数量生成并绑定', async () => {
    const { service, calls } = await setup();
    const article = await save(service, '正文\n\n![图](图片待生成)');
    const next = await service.generateArticleImages({ articleId: article.id, kind: 'body' });

    expect(calls[0]).toMatchObject({ includeCover: false, includeBody: true, count: 1 });
    expect(next.coverImageId).toBeUndefined();
    expect(next.bodyImageIds).toHaveLength(1);
  });

  it('正文没有占位符时自动补齐', async () => {
    const { service } = await setup();
    const article = await save(service, '正文没有图片');
    const next = await service.generateArticleImages({ articleId: article.id, kind: 'body', count: 2 });

    expect(next.bodyImageIds).toHaveLength(2);
    expect(countImagePlaceholders(next.markdown)).toBe(2);
  });

  it('replace=true 替换已有内图', async () => {
    const { service, calls } = await setup();
    const article = await save(service, '正文');
    const first = await service.generateArticleImages({ articleId: article.id, kind: 'body', count: 2 });
    const second = await service.generateArticleImages({
      articleId: article.id,
      kind: 'body',
      count: 1,
      replace: true,
    });

    expect(first.bodyImageIds).toHaveLength(2);
    expect(second.bodyImageIds).toHaveLength(1);
    expect(second.bodyImageIds[0]).not.toBe(first.bodyImageIds[0]);
    expect(calls).toHaveLength(2);
  });

  it('只生成首图：不产内图，绑定封面', async () => {
    const { service, calls } = await setup();
    const article = await save(service, '正文');
    const next = await service.generateArticleImages({ articleId: article.id, kind: 'cover' });

    expect(calls[0]).toMatchObject({ includeCover: true, includeBody: false, count: 0 });
    expect(next.coverImageId).toMatch(/^img_cover_/);
    expect(next.bodyImageIds).toEqual([]);
  });
});
