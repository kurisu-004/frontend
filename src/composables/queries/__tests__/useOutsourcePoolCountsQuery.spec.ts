// src/composables/queries/__tests__/useOutsourcePoolCountsQuery.spec.ts
//
// 2026-10-03 新增：useOutsourcePoolCountsQuery 常量 queryKey + 失效守门。
//
// 覆盖：
//   - T1：零参调用 → 正常拉取（queryFn 不向 api 传任何参数）。
//   - T2：queryKey 形态是常量 ['outsource-pool', 'counts']（无第三项）。
//   - T3：queryKey 与 qk.outsourcePoolCounts 同源（禁止调用点拼字面量数组）。
//   - T4：真实 counts 数据透传到 query.data。
//   - T5：invalidateOutsourcePoolCountsQuery → 失效后下一次 refetch 重新调用 api。
//   - T6：invalidateOutsourcePoolCountsQuery 走 qk.outsourcePoolCountsPrefix
//     （共享失效源）。
//
// 测试策略（沿 useWorkerPoolCountsQuery.spec.ts 范本）：
//   - vi.mock('@/api/outsource')：listOutsourcePoolCounts 替换为 vi.fn()，返回值沿
//     后端 `vo/pool.rs` 真契约（counts[] + sendable_total + in_flight_total + total，
//     **裸对象无分页信封**）；
//   - vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))：防 vitest
//     node env 中 ElMessage 内部 normalizeAppendTo 触发 ReferenceError。
//   - 本 spec 刻意**不桩掉** schemas 模块：queryFn 里的 parse 是真跑，坏响应会让
//     query 进 error 态（是守门本身的另一次验证）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

interface PoolCounts {
  counts: Array<{
    process_id: string;
    process_code: string;
    process_name: string;
    sendable_count: number;
    in_flight_count: number;
  }>;
  sendable_total: number;
  in_flight_total: number;
  total: number;
}

const EMPTY_PAYLOAD: PoolCounts = { counts: [], sendable_total: 0, in_flight_total: 0, total: 0 };

const realListOutsourcePoolCounts = vi.fn<() => Promise<PoolCounts>>(async () => ({
  ...EMPTY_PAYLOAD,
}));

vi.mock('@/api/outsource', () => ({
  listOutsourcePoolCounts: () => realListOutsourcePoolCounts(),
  // 本测试用不到 pool 域的另两个 helper，但 vi.mock 顶层 hoist 要求完整 module
  // shape —— 列出 stub 防止 partial mock 副作用（与既有 query spec 同款）。
  listOutsourcePoolByProcess: vi.fn(),
  listOutsourcePoolState: vi.fn(),
}));

import { qk } from '../keys';
import {
  invalidateOutsourcePoolCountsQuery,
  useOutsourcePoolCountsQuery,
} from '../useOutsourcePoolCountsQuery';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourcePoolCountsQuery — 常量 queryKey + 失效守门（2026-10-03）', () => {
  beforeEach(() => {
    realListOutsourcePoolCounts.mockClear();
    realListOutsourcePoolCounts.mockResolvedValue({ ...EMPTY_PAYLOAD });
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  it('T1：零参调用 → 正常拉取（queryFn 不向 api 传任何 params）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolCountsQuery());
    });
    await q!.refetch();
    expect(realListOutsourcePoolCounts).toHaveBeenCalledTimes(1);
    // 后端端点不接 Query extractor —— 一个参数都不能有
    expect(realListOutsourcePoolCounts.mock.calls[0]).toHaveLength(0);
    scope.stop();
  });

  it("T2：queryKey 形态是常量 ['outsource-pool', 'counts']（无第三项）", async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolCountsQuery());
    });
    await q!.refetch();
    // queryKey 不在 UseQueryReturnType 上，从 queryCache 反查实际落库的键
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys).toContainEqual(['outsource-pool', 'counts']);
    scope.stop();
  });

  it('T3：queryKey 与 qk.outsourcePoolCounts 同源（禁止调用点拼字面量数组）', () => {
    expect(qk.outsourcePoolCounts).toEqual(['outsource-pool', 'counts']);
    expect(qk.outsourcePoolCountsPrefix).toEqual(['outsource-pool', 'counts']);
  });

  it('T4：真实 counts 数据透传到 query.data（含两个分项计数）', async () => {
    realListOutsourcePoolCounts.mockResolvedValue({
      counts: [
        {
          process_id: '2000000000001',
          process_code: 'OUT-01',
          process_name: '外协粗加工',
          sendable_count: 4,
          in_flight_count: 2,
        },
      ],
      sendable_total: 4,
      in_flight_total: 2,
      total: 6,
    });
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolCountsQuery());
    });
    await q!.refetch();
    expect(q!.data.value?.counts[0]?.sendable_count).toBe(4);
    expect(q!.data.value?.counts[0]?.in_flight_count).toBe(2);
    expect(q!.data.value?.sendable_total).toBe(4);
    expect(q!.data.value?.total).toBe(6);
    scope.stop();
  });

  it('T5：invalidateOutsourcePoolCountsQuery → 失效后下一次 refetch 重新调用 api', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolCountsQuery());
    });
    await q!.refetch();
    const callsBefore = realListOutsourcePoolCounts.mock.calls.length;

    await invalidateOutsourcePoolCountsQuery(testQueryClient);
    await q!.refetch();

    expect(realListOutsourcePoolCounts.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T6：invalidateOutsourcePoolCountsQuery 走 qk.outsourcePoolCountsPrefix（共享失效源）', async () => {
    // 不变量：看板侧 useOutsourceBoardMove 的收发失效链与任何未来的失效点都通过
    // qk.outsourcePoolCountsPrefix 命中 counts 缓存，行为不分叉。
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourcePoolCountsQuery(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource-pool', 'counts'] });
  });

  // 守门回归锁：把 counts 端点的守门从 queryFn 上摘掉（只留 api 透传）时，本用例会红 ——
  // 说明 parse 真的挂在数据通路上，不是形同虚设的空壳。
  it('T7：坏响应（裸数组）→ query 进 error 态（Zod 守门挂在通路上）', async () => {
    realListOutsourcePoolCounts.mockResolvedValue([
      {
        process_id: '2000000000001',
        process_code: 'OUT-01',
        process_name: '外协粗加工',
        sendable_count: 4,
        in_flight_count: 2,
      },
    ] as unknown as PoolCounts);
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolCountsQuery());
    });
    await q!.refetch();
    expect(q!.isError.value).toBe(true);
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });
});
