import { describe, expect, it } from 'vitest';
import { serializeParams, serializeParamsV1, serializeParamsV2 } from './http';

describe('serializeParamsV1', () => {
  // 2026-09-15 Phase 5 拆分还原：v1 Python FastAPI 期望所有数组 → 重复 key 形式
  // `?k=a&k=b`。专供 `apiPrint`（baseURL `/api/v1`）使用。
  // 注意：v1 不区分白名单，所有数组都走重复 key——历史拆分原因（2026-08-29）是
  // v2 Rust axum 的 `statuses` 期望 CSV 单值，两边语义不一致。

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

describe('serializeParamsV2', () => {
  // 2026-09-15 hotfix 恢复 v2 CSV 白名单机制：白名单内 key（`statuses` 等）数组 →
  // CSV 单值 `?k=a,b`；其它数组维持重复 key。专供 `api` / `refreshClient`（baseURL
  // `/api/v2`）使用，匹配 Rust axum Query 反序列化对 Vec<T> 的 CSV 期望。

  it('statuses 数组 → CSV 单值（核心 regression 守卫）', () => {
    // 这是 Phase 5 误合并导致 /parts 返 400 的精确回归断言：必须编出
    // `?statuses=IN_PROCESS%2CREPAIRING`，前端调 `GET /api/v2/parts` 才不会 400。
    expect(serializeParamsV2({ statuses: ['IN_PROCESS', 'REPAIRING'] })).toBe(
      'statuses=IN_PROCESS%2CREPAIRING',
    );
  });

  it('statuses 单值数组 → CSV 单值（无尾随逗号）', () => {
    expect(serializeParamsV2({ statuses: ['IN_PROCESS'] })).toBe('statuses=IN_PROCESS');
  });

  it('statuses 空数组 → 该 key 不出现', () => {
    expect(serializeParamsV2({ statuses: [] })).toBe('');
  });

  it('非白名单数组（ids）维持重复 key 形式', () => {
    // v2 端点如果有非 `statuses` 的数组字段（如 ids、codes），仍走重复 key——避免
    // 误把所有数组都 CSV 化导致其它端点反序列化失败。
    expect(serializeParamsV2({ ids: ['1', '2'] })).toBe('ids=1&ids=2');
  });

  it('混合：白名单 CSV + 其它数组重复 key + 普通键', () => {
    const out = serializeParamsV2({
      statuses: ['IN_PROCESS', 'REPAIRING'],
      ids: ['1'],
      page: 2,
    });
    // 顺序由 Object.keys 保证（ES2020 后 keys 顺序 = insertion 顺序）
    expect(out).toBe('statuses=IN_PROCESS%2CREPAIRING&ids=1&page=2');
  });
});

describe('serializeParams（向后兼容别名）', () => {
  // 2026-08-29：serializeParams 保留为 serializeParamsV1 的 alias，供历史 import
  // 不至于崩。新代码请用具名 V1 / V2。

  it('行为与 serializeParamsV1 一致', () => {
    const input = { ids: ['1', '2'], page: 1 };
    expect(serializeParams(input)).toBe(serializeParamsV1(input));
  });
});
