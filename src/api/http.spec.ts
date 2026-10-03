import { describe, expect, it } from 'vitest';
import { serializeParamsV2 } from './http';

describe('serializeParamsV2', () => {
  // 白名单内 key（`statuses` / `locations` / `holder_ids`）数组 → CSV 单值
  // `?k=a%2Cb`；其它数组维持重复 key。`api` / `refreshClient`（baseURL
  // `/api/v2`）都用它，匹配 rust axum Query 反序列化的 CSV 期望。

  it('statuses 数组 → CSV 单值（核心 regression 守卫）', () => {
    // 必须编出 `?statuses=IN_PROCESS%2CREPAIRING`：rust axum 的 Query 反序列化对
    // 重复 key（?statuses=A&statuses=B）取不到期望形态，直接 400，UI 打开
    // /parts 白屏。
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
    // v2 端点如果有非白名单的数组字段（如 ids、codes），仍走重复 key——避免
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

  // 2026-09-17 PR-4 同步：backend-rust PartListQuery 把 locations / holder_ids
  // 实现为 `Option<String>`（逗号分隔单值）。前端不加入白名单会触发 backend
  // axum 解析失败（`?locations=A&locations=B` → Query<Option<String>> 单值报错）。
  // 这两条断言是跨仓契约 F3 的精确回归守卫。
  it('locations 数组 → CSV 单值（PR-4 backend PartListQuery 同步）', () => {
    expect(serializeParamsV2({ locations: ['PRODUCTION_SHELF', 'WORKER'] })).toBe(
      'locations=PRODUCTION_SHELF%2CWORKER',
    );
    // 反向断言：不能是重复 key（?locations=A&locations=B）
    expect(serializeParamsV2({ locations: ['PRODUCTION_SHELF', 'WORKER'] })).not.toContain(
      'locations=PRODUCTION_SHELF&locations=',
    );
  });

  it('holder_ids 数组 → CSV 单值（PR-4 backend PartListQuery 同步，雪花 ID 字符串原样）', () => {
    // 雪花 ID 字符串（CLAUDE.md §3）禁止 Number()，CSV 拼接必须保留原 string 形态。
    // 后端 service 层把 CSV 拆成 Vec<i64>，前端不参与 parse。
    expect(serializeParamsV2({ holder_ids: ['1700000000000000001', '1700000000000000002'] })).toBe(
      'holder_ids=1700000000000000001%2C1700000000000000002',
    );
    // 反向断言：不能是重复 key
    expect(
      serializeParamsV2({ holder_ids: ['1700000000000000001', '1700000000000000002'] }),
    ).not.toContain('holder_ids=1700000000000000001&holder_ids=');
  });

  it('混合：locations CSV + holder_ids CSV + statuses CSV（PR-4 全白名单）', () => {
    // PR-4 真实 wire-format：locations / holder_ids / statuses 同时设，三组
    // 都走 CSV。Object.keys 顺序 = insertion 顺序（ES2020）。
    const out = serializeParamsV2({
      locations: ['PRODUCTION_SHELF'],
      holder_ids: ['1700000000000000001'],
      statuses: ['IN_PROCESS'],
      customer_id: '190000000000100',
    });
    expect(out).toBe(
      'locations=PRODUCTION_SHELF' +
        '&holder_ids=1700000000000000001' +
        '&statuses=IN_PROCESS' +
        '&customer_id=190000000000100',
    );
  });

  it('locations / holder_ids 单值数组 → CSV 单值（无尾随逗号）', () => {
    expect(serializeParamsV2({ locations: ['OFFICE'] })).toBe('locations=OFFICE');
    expect(serializeParamsV2({ holder_ids: ['1700000000000000099'] })).toBe(
      'holder_ids=1700000000000000099',
    );
  });
});
