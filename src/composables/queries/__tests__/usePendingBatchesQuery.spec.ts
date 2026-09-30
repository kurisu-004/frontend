// src/composables/queries/__tests__/usePendingBatchesQuery.spec.ts
//
// 2026-09-29 新增：usePendingBatchesQuery 共享基础数据层守门 + reactive params +
// 失效。
//
// 2026-09-30 契约校正（对齐 backend-rust src/modules/prod/batch/vo.rs 实际 serde）：
//   - `batch_no` 是 `i32`（**非 String**）—— 旧 schema 的 union+transform 归一成
//     string 是基于「contract 注释误标」的误修，现直接 z.number()；
//   - `current_process_step_id` / `process_chain_id` 是 `i64` + `serialize_i64`
//     （DB NULL 走 `.unwrap_or(0)` 兜底，见 vo.rs 字段注释）⇒ **永不返 null**，
//     语义为 "0" = 未设。旧 schema 写 `.nullable()` 是错的。
//   - `ListPendingBatchesParams` 删 urgent_only / keyword（后端 ListPendingQuery
//     只接 limit / offset 两个 Query 参数，旧值只是死参）。
//
// 覆盖：
//   - S1：pendingBatchItemSchema 接受 backend-rust PendingBatchItem 17 字段不抛错。
//   - S2：pendingBatchItemSchema 缺 version → 抛 ZodError（M-1 strip regression guard）。
//   - S3：pendingBatchItemSchema 缺 process_chain_id → 抛 ZodError（同源 guard）。
//   - S4：pendingBatchListResultSchema 接受完整 4 字段 shape（items/total/limit/offset）。
//   - S5：pendingBatchListResultSchema 缺 items → 抛 ZodError。
//   - T1：usePendingBatchesQuery(静态对象) → fetchPendingBatches 收到该 params。
//   - T2：usePendingBatchesQuery(Ref) → 改 ref.value 后调 refetch，fetchPendingBatches 收到新 params。
//   - T3：invalidatePendingBatchesQuery → 失效后下一次 refetch 重新调用 fetchPendingBatches。
//
// 测试策略（沿 usePartFilesListQuery.spec.ts 范本）：
//   - vi.mock('@/api/pendingBatches')：fetchPendingBatches 替换为 vi.fn()。
//   - vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))：防 vitest
//     node env 中 ElMessage 内部 normalizeAppendTo 触发 ReferenceError。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const realFetchPendingBatches = vi.fn<
  (...args: unknown[]) => Promise<{
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
  }>
>(async (..._args: unknown[]) => ({ items: [], total: 0, limit: 200, offset: 0 }));

vi.mock('@/api/pendingBatches', () => ({
  fetchPendingBatches: (params: unknown) => realFetchPendingBatches(params),
  dispatchBatch: vi.fn(),
  bulkDispatchBatches: vi.fn(),
  autoDispatchBatches: vi.fn(),
}));

import { cleanParams } from '@/api/http';
import type { ListPendingBatchesParams } from '@/api/pendingBatches';
import { pendingBatchItemSchema, pendingBatchListResultSchema } from '../schemas';
import {
  invalidatePendingBatchesQuery,
  usePendingBatchesQuery,
} from '../usePendingBatchesQuery';

function lastParams(): Record<string, unknown> {
  const calls = realFetchPendingBatches.mock.calls;
  const last = calls[calls.length - 1];
  // realFetchPendingBatches 是无参 mock，调用栈可能为空（never invoked）。
  return (last?.[0] ?? {}) as unknown as Record<string, unknown>;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('pendingBatchItemSchema / pendingBatchListResultSchema（2026-09-29 新增）', () => {
  it('S1：pendingBatchItemSchema 接受 backend-rust PendingBatchItem 完整 17 字段不抛错', () => {
    const item = pendingBatchItemSchema.parse({
      batch_id: '3000000000001',
      part_id: '4000000000001',
      batch_no: 1,
      quantity: 5,
      serial_no: null,
      name: '法兰盘',
      drawing_no: 'DWG-A001',
      planned_delivery_date: '2026-10-01',
      system_delivery_date: '2026-09-25',
      customer_name: '客户A',
      parent_customer_name: null,
      applicant_name: '张三',
      is_urgent: false,
      note: null,
      version: 1,
      current_process_step_id: '5000000000010',
      process_chain_id: '6000000000001',
    });
    expect(item.batch_id).toBe('3000000000001');
    expect(item.process_chain_id).toBe('6000000000001');
    // 2026-09-30：batch_no 后端是 i32，不再归一成 string
    expect(item.batch_no).toBe(1);
  });

  it('S1b：current_process_step_id / process_chain_id = \'0\' 是合法值（未设语义）', () => {
    // 后端 DB NULL 走 `.unwrap_or(0)` 兜底并序列化为字符串 "0"（vo.rs 字段注释
    // 明确「前端按 0 == 未设 step 区分」）⇒ 非 nullable。
    const item = pendingBatchItemSchema.parse({
      batch_id: '3000000000001',
      part_id: '4000000000001',
      batch_no: 1,
      quantity: 5,
      serial_no: null,
      name: '法兰盘',
      drawing_no: 'DWG-A001',
      planned_delivery_date: '2026-10-01',
      system_delivery_date: null,
      customer_name: null,
      parent_customer_name: null,
      applicant_name: null,
      is_urgent: false,
      note: null,
      version: 1,
      current_process_step_id: '0',
      process_chain_id: '0',
    });
    expect(item.current_process_step_id).toBe('0');
    expect(item.process_chain_id).toBe('0');
  });

  it('S1c：current_process_step_id = null → 抛 ZodError（非 Option 字段）', () => {
    // 回归 guard：修复前 schema 写 `.nullable()` 是「恰好接受」而非「按契约接受」——
    // 后端若哪天真返 null，前端应立刻炸出来而不是静默当 0 处理。
    expect(() =>
      pendingBatchItemSchema.parse({
        batch_id: '3000000000001',
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: null,
        name: 'x',
        drawing_no: 'DWG',
        planned_delivery_date: null,
        system_delivery_date: null,
        customer_name: null,
        parent_customer_name: null,
        applicant_name: null,
        is_urgent: false,
        note: null,
        version: 1,
        current_process_step_id: null,
        process_chain_id: '0',
      }),
    ).toThrow();
  });

  it('S2：pendingBatchItemSchema 缺 version → 抛 ZodError（M-1 strip regression guard）', () => {
    expect(() =>
      pendingBatchItemSchema.parse({
        batch_id: '3000000000001',
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: null,
        name: 'x',
        drawing_no: 'DWG-A001',
        planned_delivery_date: null,
        system_delivery_date: null,
        customer_name: null,
        parent_customer_name: null,
        applicant_name: null,
        is_urgent: false,
        note: null,
        // version 缺
        current_process_step_id: '0',
        process_chain_id: '0',
      }),
    ).toThrow();
  });

  it('S3：pendingBatchItemSchema 缺 process_chain_id → 抛 ZodError（同源 guard）', () => {
    expect(() =>
      pendingBatchItemSchema.parse({
        batch_id: '3000000000001',
        part_id: '4000000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: null,
        name: 'x',
        drawing_no: 'DWG-A001',
        planned_delivery_date: null,
        system_delivery_date: null,
        customer_name: null,
        parent_customer_name: null,
        applicant_name: null,
        is_urgent: false,
        note: null,
        version: 1,
        current_process_step_id: '0',
        // process_chain_id 缺
      }),
    ).toThrow();
  });

  it('S4：pendingBatchListResultSchema 接受完整 4 字段 shape', () => {
    const r = pendingBatchListResultSchema.parse({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
    expect(r.total).toBe(0);
    expect(r.limit).toBe(200);
  });

  it('S5：pendingBatchListResultSchema 缺 items → 抛 ZodError', () => {
    expect(() =>
      pendingBatchListResultSchema.parse({
        // items 缺
        total: 0,
        limit: 200,
        offset: 0,
      }),
    ).toThrow();
  });
});

describe('usePendingBatchesQuery — reactive params + 失效（2026-09-29）', () => {
  beforeEach(() => {
    realFetchPendingBatches.mockClear();
    realFetchPendingBatches.mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
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

  it('T1：传静态对象 → fetchPendingBatches 收到该 params（含 limit + offset）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePendingBatchesQuery> | undefined;
    scope.run(() => {
      // 2026-09-30：后端 ListPendingQuery 只接 limit / offset
      q = testApp.runWithContext(() => usePendingBatchesQuery({ limit: 200, offset: 0 }));
    });
    await q!.refetch();
    expect(realFetchPendingBatches).toHaveBeenCalled();
    // fetchPendingBatches 收到的是 cleanParams 之后的 params（queryFn 调用形态）。
    expect(lastParams().limit).toBe(200);
    expect(lastParams().offset).toBe(0);
    void cleanParams;
    scope.stop();
  });

  it('T2：传 Ref<ListPendingBatchesParams> → 改 ref.value 后调 refetch，fetchPendingBatches 收到新 params', async () => {
    // 背景（沿 useProcessesQuery T2 范本）：queryKey 走 reactive 时参数变化触发 refetch。
    const paramsRef: Ref<ListPendingBatchesParams> = ref({ limit: 200 });
    const scope = effectScope();
    let q: ReturnType<typeof usePendingBatchesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePendingBatchesQuery(paramsRef));
    });
    await q!.refetch();
    expect(realFetchPendingBatches).toHaveBeenCalledTimes(1);
    // 改 limit → queryKey 自动变 → refetch
    paramsRef.value = { limit: 50, offset: 10 };
    await q!.refetch();
    expect(realFetchPendingBatches).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('T3：invalidatePendingBatchesQuery → 失效后下一次 refetch 重新调用 fetchPendingBatches', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof usePendingBatchesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => usePendingBatchesQuery({ limit: 200 }));
    });
    await q!.refetch();
    const callsBefore = realFetchPendingBatches.mock.calls.length;

    await invalidatePendingBatchesQuery(testQueryClient);
    await q!.refetch();

    expect(realFetchPendingBatches.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });
});