import { describe, expect, it } from 'vitest';
import { preflightPush, WECHAT_LIMITS, type PreflightImage, type PreflightInput } from '@/host/wechat/preflight';

/**
 * 推送前预检（I-01）：标题字符数、摘要 UTF-8 字节、正文图张数、单图 <1MB、
 * 封面/图片记录完整性；纯函数，零网络调用。
 */

const cover: PreflightImage = { id: 'img_cover', kind: 'cover', bytes: 1000, mime: 'image/png' };

const base = (patch: Partial<PreflightInput> = {}): PreflightInput => ({
  title: '合格标题',
  digest: '摘要',
  bodyImageIds: [],
  coverImageId: 'img_cover',
  images: [cover],
  ...patch,
});

const bodyImage = (index: number, bytes = 1000): PreflightImage => ({
  id: `img_body_${index}`,
  kind: 'body',
  bytes,
  mime: 'image/jpeg',
});

describe('preflightPush（微信硬限制）', () => {
  it('合法文章：ok=true，无 issues', () => {
    const result = preflightPush(base());
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('标题：64 字通过，65 字拒绝，空标题拒绝', () => {
    expect(preflightPush(base({ title: '标'.repeat(WECHAT_LIMITS.titleMaxChars) })).ok).toBe(true);
    const over = preflightPush(base({ title: '标'.repeat(WECHAT_LIMITS.titleMaxChars + 1) }));
    expect(over.ok).toBe(false);
    expect(over.issues.join()).toContain('标题 65 字');
    const empty = preflightPush(base({ title: '   ' }));
    expect(empty.ok).toBe(false);
    expect(empty.issues.join()).toContain('标题为空');
  });

  it('摘要：120 字节通过，121 字节拒绝（UTF-8 口径）', () => {
    const exact = '中'.repeat(40); // 3 字节 × 40 = 120
    expect(Buffer.byteLength(exact, 'utf8')).toBe(120);
    expect(preflightPush(base({ digest: exact })).ok).toBe(true);
    const over = preflightPush(base({ digest: `${exact}字` })); // 123 字节
    expect(over.ok).toBe(false);
    expect(over.issues.join()).toContain('摘要 123 字节');
  });

  it('正文图：10 张通过，11 张拒绝', () => {
    const ten = Array.from({ length: 10 }, (_, index) => bodyImage(index));
    expect(
      preflightPush(
        base({ bodyImageIds: ten.map((image) => image.id), images: [cover, ...ten] }),
      ).ok,
    ).toBe(true);

    const eleven = Array.from({ length: 11 }, (_, index) => bodyImage(index));
    const over = preflightPush(
      base({ bodyImageIds: eleven.map((image) => image.id), images: [cover, ...eleven] }),
    );
    expect(over.ok).toBe(false);
    expect(over.issues.join()).toContain('正文图 11 张');
  });

  it('单图：0.99MB 通过，1.00MB 拒绝（<1MB 硬限制）', () => {
    const below = bodyImage(1, 1024 * 1024 - 100);
    expect(
      preflightPush(base({ bodyImageIds: [below.id], images: [cover, below] })).ok,
    ).toBe(true);

    const limit = bodyImage(2, 1024 * 1024);
    const over = preflightPush(base({ bodyImageIds: [limit.id], images: [cover, limit] }));
    expect(over.ok).toBe(false);
    expect(over.issues.join()).toContain('超过单图 1MB 上限');
  });

  it('封面/正文图记录缺失、mime 非图片、空内容均报告', () => {
    const missingCover = preflightPush(base({ coverImageId: 'img_missing' }));
    expect(missingCover.issues.join()).toContain('封面图记录缺失');

    const noCover = preflightPush(base({ coverImageId: undefined }));
    expect(noCover.issues.join()).toContain('缺少封面图');

    const missingBody = preflightPush(base({ bodyImageIds: ['img_nope'] }));
    expect(missingBody.issues.join()).toContain('正文图记录缺失');

    const bad: PreflightImage = { id: 'img_bad', kind: 'body', bytes: 1000, mime: 'text/plain' };
    const badResult = preflightPush(base({ bodyImageIds: [bad.id], images: [cover, bad] }));
    expect(badResult.issues.join()).toContain('类型不是 image/*');

    const empty: PreflightImage = { id: 'img_empty', kind: 'body', bytes: 0, mime: 'image/png' };
    const emptyResult = preflightPush(base({ bodyImageIds: [empty.id], images: [cover, empty] }));
    expect(emptyResult.issues.join()).toContain('内容为空');
  });
});
