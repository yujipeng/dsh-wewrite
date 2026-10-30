import { describe, expect, it } from 'vitest';
import { parseResearchOutput } from '@/host/research';

const payload = {
  facts: '2024 年城乡居民基础养老金最低标准 123 元/月。',
  mechanisms: '损失厌恶：一次性支出比按月扣款更疼。',
  mustInclude: ['123 元', '损失厌恶'],
  boundary: '不写成所有农村老人都没有养老金。',
};

describe('I-21 研究底稿解析', () => {
  it('合法 JSON 解析为 facts/mechanisms/mustInclude/boundary', () => {
    expect(parseResearchOutput(JSON.stringify(payload))).toEqual(payload);
  });

  it('兼容 ```json 围栏与前后缀文字', () => {
    const text = `研究结果：\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n以上。`;
    expect(parseResearchOutput(text)?.facts).toContain('123 元');
  });

  it('缺 facts 与 mechanisms → null', () => {
    expect(parseResearchOutput(JSON.stringify({ mustInclude: ['x'] }))).toBeNull();
  });

  it('非 JSON → null', () => {
    expect(parseResearchOutput('不是 JSON')).toBeNull();
  });

  it('mustInclude 过滤非字符串并截断到 10 条', () => {
    const parsed = parseResearchOutput(
      JSON.stringify({ ...payload, mustInclude: Array.from({ length: 12 }, (_, i) => `事实${i}`).concat([1 as never]) }),
    );
    expect(parsed?.mustInclude).toHaveLength(10);
  });
});
