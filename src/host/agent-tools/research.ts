/**
 * wewrite_research（I-21，可选）：围绕主题生成事实/机制底稿，供 agent 写入写作合同。
 * 不调用时管线行为不变；工具失败返回结构化错误，不抛异常。
 */

import type { ToolRunContext, WewriteToolDefinition } from '../platform';
import type { WeWriteService } from '../service';
import { asArgsRecord, callView, errorToCodeMessage, jsonSchema, resultView, textBlocks, toolError } from './output-helpers';

export function buildResearchTool(service: WeWriteService): WewriteToolDefinition {
  return {
    name: 'wewrite_research',
    description:
      '可选研究底稿：围绕主题产出已核实事实、解释机制、mustInclude 与 boundary，供写作合同使用。'
      + '不调用时管线行为完全不变；仅在用户要求「先查一下 / 做事实底稿」时调用。',
    timeoutMs: 60000,
    parameters: {
      topic: { type: 'string', description: '研究主题', required: true },
      sources: { type: 'array', items: { type: 'string' }, description: '可选候选来源 URL' },
    },
    output: {
      schema: jsonSchema(
        {
          ok: { type: 'boolean' },
          facts: { type: 'string' },
          mechanisms: { type: 'string' },
          mustInclude: { type: 'array' },
          boundary: { type: 'string' },
          error: { type: 'object' },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        const record = asArgsRecord(value);
        if (record.ok === false) {
          const error = asArgsRecord(record.error);
          return textBlocks(`研究底稿生成失败：${typeof error.message === 'string' ? error.message : '未知错误'}`);
        }
        return textBlocks(
          '事实底稿：',
          String(record.facts ?? ''),
          '',
          '解释机制：',
          String(record.mechanisms ?? ''),
          '',
          `必须出现：${Array.isArray(record.mustInclude) ? record.mustInclude.map(String).join('、') : '（无）'}`,
          `边界：${String(record.boundary ?? '') || '（无）'}`,
        );
      },
      presentationMeta: (_args, value) => {
        const record = asArgsRecord(value);
        return {
          tool: 'wewrite_research',
          facts: String(record.facts ?? ''),
          mechanisms: String(record.mechanisms ?? ''),
          mustInclude: Array.isArray(record.mustInclude) ? record.mustInclude.map(String) : [],
          boundary: String(record.boundary ?? ''),
        };
      },
    },
    async execute(args: unknown, _exec: ToolRunContext) {
      const record = asArgsRecord(args);
      const topic = typeof record.topic === 'string' ? record.topic.trim() : '';
      if (!topic) {
        return {
          ...toolError('topic-missing', 'topic 不能为空'),
          facts: '',
          mechanisms: '',
          mustInclude: [],
          boundary: '',
        };
      }
      const sources = Array.isArray(record.sources)
        ? record.sources.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      try {
        const result = await service.researchTopic({ topic, ...(sources.length ? { sources } : {}) });
        return { ok: true, ...result };
      } catch (error) {
        const { code, message } = errorToCodeMessage(error, 'research-failed');
        return { ...toolError(code, message), facts: '', mechanisms: '', mustInclude: [], boundary: '' };
      }
    },
    presentCall: () => callView('execute', '生成研究底稿'),
    presentResult: (_args, result) => {
      const meta = asArgsRecord(result.meta);
      return resultView('研究底稿', textBlocks(
        `事实：${String(meta.facts ?? '') || '（无）'}`,
        `机制：${String(meta.mechanisms ?? '') || '（无）'}`,
        `必须出现：${Array.isArray(meta.mustInclude) && meta.mustInclude.length ? meta.mustInclude.map(String).join('、') : '（无）'}`,
        `边界：${String(meta.boundary ?? '') || '（无）'}`,
      ));
    },
  };
}
