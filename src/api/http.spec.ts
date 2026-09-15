import { describe, expect, it } from 'vitest';
import { serializeParams, serializeParamsV1 } from './http';

describe('serializeParamsV1', () => {
  // 2026-09-15 Phase 5 合并：v1 / v2 共用 serializeParamsV1（数组重复 key 形式）。
  // v2 业务 `statuses` 由后端 schema 改为单值 string，与重复 key 形式语义兼容
  // （Rust 端 List / String 单值字段解析重复 key 仅取首元素）。CSV 白名单无消费者，
  // serializeParamsV2 已删除。

  it('数组 → 重复 key 形式（不含逗号）', () => {
    expect(serializeParamsV1({ statuses: ['PENDING', 'INSPECTION'] })).toBe(
      'statuses=PENDING&statuses=INSPECTION',
    );
    // 反向断言：不能是 CSV 单值（?statuses=PENDING%2CINSPECTION）
    expect(serializeParamsV1({ statuses: ['PENDING', 'INSPECTION'] })).not.toContain('%2C');
  });

  it('单值数组 → 单个重复 key', () => {
    expect(serializeParamsV1({ statuses: ['PENDING'] })).toBe('statuses=PENDING');
  });

  it('空数组 → 该 key 不出现', () => {
    expect(serializeParamsV1({ statuses: [] })).toBe('');
  });

  it('undefined/null 顶层值跳过', () => {
    expect(serializeParamsV1({ a: undefined, b: null, c: 'x' })).toBe('c=x');
  });

  it('其它数组（ids）维持重复 key 形式', () => {
    expect(serializeParamsV1({ ids: ['1', '2'] })).toBe('ids=1&ids=2');
  });

  it('空串数组元素：v1 不过滤 → 输出 statuses=', () => {
    // 实际行为记录：v1 「其它数组」分支只是把每个元素 push 一遍，
    // encodeURIComponent('') === ''，所以会拼出 ?statuses=&statuses=x。
    // 这是潜伏问题：FastAPI 解析空串仍会进 enum 校验失败。
    expect(serializeParamsV1({ statuses: ['PENDING', ''] })).toBe('statuses=PENDING&statuses=');
  });

  it('混合：数组 + 普通键', () => {
    const out = serializeParamsV1({
      statuses: ['DRAFT'],
      customer_id: '190000000000100',
    });
    expect(out).toBe('statuses=DRAFT&customer_id=190000000000100');
  });
});

describe('serializeParams（向后兼容别名）', () => {
  // 2026-08-29：serializeParams 保留为 serializeParamsV1 的 alias，供历史 import
  // 不至于崩。新代码请用具名版本。

  it('行为与 serializeParamsV1 一致', () => {
    const input = { statuses: ['PENDING', 'INSPECTION'], page: 1 };
    expect(serializeParams(input)).toBe(serializeParamsV1(input));
  });
});
