import { describe, expect, it } from 'vitest';
import type { ArticleDetail } from '@/shared/contract';
import { formatPublishRecord } from '@/client/lib/publish-record';

const base: ArticleDetail = {
  id: 'art_1',
  slug: 'publish-record',
  title: '发布记录测试',
  digest: '摘要',
  status: 'pushed',
  updatedAt: '2026-10-30T08:00:00.000Z',
  v: 1,
  markdown: '# 标题',
  theme: 'professional-clean',
  bodyImageIds: [],
  wechatMediaId: 'MEDIA_1',
  thumbMediaId: 'THUMB_1',
  pushedAt: '2026-10-30T08:00:00.000Z',
  digestBytes: 6,
  pushVerify: { ok: true, issues: [], checkedAt: '2026-10-30T08:00:00.000Z' },
};

describe('formatPublishRecord（I-05）', () => {
  it('已推送且校验通过：包含 media_id/推送时间/摘要字节/校验结论', () => {
    const text = formatPublishRecord(base);
    expect(text).toContain('media_id：MEDIA_1');
    expect(text).toContain('thumb_media_id：THUMB_1');
    expect(text).toContain('推送时间：2026-10-30T08:00:00.000Z');
    expect(text).toContain('摘要字节：6');
    expect(text).toContain('回读校验：通过');
  });

  it('未推送：明确标注「未推送」，不编造时间', () => {
    const text = formatPublishRecord({
      ...base,
      status: 'rendered',
      wechatMediaId: undefined,
      thumbMediaId: undefined,
      pushedAt: undefined,
      digestBytes: undefined,
      pushVerify: undefined,
    });
    expect(text).toContain('media_id：（未推送）');
    expect(text).toContain('推送时间：（未推送）');
    expect(text).toContain('回读校验：（无记录）');
  });

  it('校验失败：列出 issues', () => {
    const text = formatPublishRecord({
      ...base,
      pushVerify: { ok: false, issues: ['正文图片数不一致：期望 1 张，回读 0 张'], checkedAt: '2026-10-30T08:00:00.000Z' },
    });
    expect(text).toContain('回读校验：未通过');
    expect(text).toContain('- 正文图片数不一致');
  });
});
