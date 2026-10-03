// src/composables/queries/__tests__/useWorkerStateByWorkerQuery.spec.ts
//
// 2026-10-04：shelfId 维度整体移除（后端 shelf_id 降为可选且只影响前端零消费的
// pool_count_by_process；`auth.activeShelfId` 对 MANAGER/CLERK/INSPECTOR 恒空会让
// enabled 恒 false ⇒ 持有列表静默假空）。mock 签名与 queryKey 断言同步改成单参数。
// 2026-09-30 新增：useWorkerStateByWorkerQuery reactive params + enabled 闸门 +
// queryKey + 失效守门。
//
// 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛）：
//   - URL `/prod/worker-pool/state` → `/prod/pool/state`；
//   - `workerStateSchema.work_type_code` 由 `.nullable()` 收紧为 `z.string()` ——
//     后端 `WorkerPoolState.work_type_code` 是非 Option String（model.rs:122），
//     无工种时退化为**空串**而非 null；
//   - 删 `invalidateWorkerStateByWorkerQuery(qc, wid, sid)` 精刷版 —— move 端点改造后
//     一次写操作可同时改多个 worker 的 held_batches（auto-allocate），唯一正确策略
//     是 `invalidateWorkerStateByWorkerAll` 前缀全失效。
//
// 覆盖：
//   - S1-S4：workerStateSchema 解析后端真契约 + work_type_code 空串 + 缺
//     held_batches 抛 ZodError + 缺 max_held 抛 ZodError。
//   - T1：传静态 string → getWorkerState 收到 worker_id。
//   - T2：传 Ref<workerId> → 改 ref.value 后调 refetch，getWorkerState 收到新
//     worker_id（reactive params guard）。
//   - T4：workerId = null → enabled=false，getWorkerState 调用 0 次（闸门 guard；
//     「持有列表恒空」修复的核心回归点）。
//   - T5：queryKey 形态 = ['worker-pool','state',workerId]，**不含货架维度**。
//   - T6 / T7：invalidateWorkerStateByWorkerAll 前缀失效后重拉 + 确实走
//     qk.workerPoolStatePrefix。
//
// 测试策略（沿 usePartFilesListQuery.spec.ts 范本）：
//   - vi.mock('@/api/workerPool')：getWorkerState 替换为 vi.fn()。
//   - vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))。

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

// 2026-09-30：mock 沿 backend-rust WorkerPoolState 真契约 —— 8 顶层字段 + 嵌套
// pool_count_by_process[] + held_batches[]。held_batches 元素用最小 HeldBatchItem 形态。
const realGetWorkerState = vi.fn<
  (params: { worker_id: string }) => Promise<{
    worker_id: string;
    worker_name: string;
    work_type_code: string;
    max_held: number;
    current_held: number;
    capacity_remaining: number;
    pool_count_by_process: Array<{ process_id: string; pool_count: number }>;
    held_batches: Array<{
      batch_id: string;
      part_id: string;
      batch_no: number;
      quantity: number;
      serial_no: string | null;
      drawing_no: string;
      name: string;
      system_delivery_date: string | null;
      planned_delivery_date: string | null;
      is_urgent: boolean;
      customer_name: string | null;
      parent_customer_name: string | null;
      applicant_name: string | null;
      location: string;
      shelf_code: string | null;
      note: string | null;
      has_cnc_program: boolean;
      version: number;
    }>;
  }>
>(async (params: { worker_id: string }) => ({
  worker_id: params.worker_id,
  worker_name: '工人甲',
  work_type_code: 'CNC',
  max_held: 3,
  current_held: 0,
  capacity_remaining: 3,
  pool_count_by_process: [],
  held_batches: [],
}));

vi.mock('@/api/workerPool', () => ({
  getWorkerState: (params: { worker_id: string }) => realGetWorkerState(params),
  // 2026-09-30：其它 workerPool 函数在本测试用不到，列出 stub 防止 partial mock 副作用。
  getWorkerPoolCounts: vi.fn(),
  getWorkerPoolByProcess: vi.fn(),
  refillWorkerPool: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
}));

import { workerStateSchema } from '../schemas';
import {
  invalidateWorkerStateByWorkerAll,
  useWorkerStateByWorkerQuery,
} from '../useWorkerStateByWorkerQuery';

function lastParams(): { worker_id: string } | undefined {
  const calls = realGetWorkerState.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0] as { worker_id: string } | undefined;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('workerStateSchema（2026-09-30 新增）', () => {
  function makeBaseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      worker_id: '1900000000001',
      worker_name: '张三',
      work_type_code: 'CNC',
      max_held: 3,
      current_held: 1,
      capacity_remaining: 2,
      pool_count_by_process: [{ process_id: '2000000000001', pool_count: 5 }],
      held_batches: [],
      ...overrides,
    };
  }

  it('S1：workerStateSchema 接受 backend-rust WorkerPoolState 8 字段不抛错', () => {
    const parsed = workerStateSchema.parse(makeBaseState());
    expect(parsed.worker_id).toBe('1900000000001');
    expect(parsed.work_type_code).toBe('CNC');
    expect(parsed.max_held).toBe(3);
    expect(parsed.pool_count_by_process).toHaveLength(1);
    expect(parsed.held_batches).toHaveLength(0);
  });

  it('S2：work_type_code = 空串是合法值（无工种场景）', () => {
    // 2026-09-30 契约校正：后端 `pub work_type_code: String`（非 Option），
    // 无工种时退化为空串（worker-pool.md:52「前端应展示『工种未设置』占位」），
    // **不是 null**。修复前 schema 写 `.nullable()` 恰好也接受 null，是「恰好对」
    // 而非「按契约对」—— 本用例锁死非 nullable 语义。
    const parsed = workerStateSchema.parse(makeBaseState({ work_type_code: '' }));
    expect(parsed.work_type_code).toBe('');
  });

  it('S3：缺 held_batches → 抛 ZodError（M-1 guard）', () => {
    expect(() =>
      workerStateSchema.parse({
        worker_id: '1900000000001',
        worker_name: '张三',
        work_type_code: 'CNC',
        max_held: 3,
        current_held: 1,
        capacity_remaining: 2,
        pool_count_by_process: [],
        // held_batches 缺
      }),
    ).toThrow();
  });

  it('S4：缺 max_held → 抛 ZodError（M-1 guard）', () => {
    expect(() =>
      workerStateSchema.parse({
        worker_id: '1900000000001',
        worker_name: '张三',
        work_type_code: 'CNC',
        // max_held 缺
        current_held: 1,
        capacity_remaining: 2,
        pool_count_by_process: [],
        held_batches: [],
      }),
    ).toThrow();
  });
});

describe('useWorkerStateByWorkerQuery — reactive params + enabled 闸门 + 失效（2026-10-04）', () => {
  beforeEach(() => {
    realGetWorkerState.mockClear();
    realGetWorkerState.mockImplementation(async (params: { worker_id: string }) => ({
      worker_id: params.worker_id,
      worker_name: '工人甲',
      work_type_code: 'CNC',
      max_held: 3,
      current_held: 0,
      capacity_remaining: 3,
      pool_count_by_process: [],
      held_batches: [],
    }));
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

  it('T1：传静态 string → getWorkerState 收到 worker_id', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerStateByWorkerQuery(() => '1900000000001'));
    });
    await q!.refetch();
    expect(realGetWorkerState).toHaveBeenCalled();
    expect(lastParams()?.worker_id).toBe('1900000000001');
    scope.stop();
  });

  it('T2：传 Ref<workerId> → 改 ref.value 后调 refetch，getWorkerState 收到新 worker_id', async () => {
    // 背景（沿 useProcessesQuery T2 范本）：reactive params guard。
    const widRef: Ref<string | null> = ref('1900000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerStateByWorkerQuery(() => widRef.value));
    });
    await q!.refetch();
    expect(lastParams()?.worker_id).toBe('1900000000001');

    widRef.value = '1900000000002';
    await q!.refetch();
    expect(lastParams()?.worker_id).toBe('1900000000002');
    scope.stop();
  });

  it('T4：workerId = null → enabled=false → getWorkerState 调用 0 次', async () => {
    // 闸门 guard：workerId 缺失必须不发请求。这是修复「持有列表恒空」的核心回归点 ——
    // 此前 enabled 额外要求 shelfId 非空，而 auth.activeShelfId 对
    // MANAGER / CLERK / INSPECTOR 恒 null ⇒ 恒不满足 ⇒ 静默假空。
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerStateByWorkerQuery(() => null));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realGetWorkerState).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T5：queryKey 形态 = [\'worker-pool\',\'state\',workerId]，不含货架维度', async () => {
    // 2026-10-04 回归 guard：shelfId 维度已整体移除。若有人把 shelfId 加回键里，
    // 键长会变 4 段、且同一 worker 会被按架切成不同 cache identity。
    const widSource = ref<string>('1900000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerStateByWorkerQuery(() => widSource.value));
    });
    await q!.refetch();
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((entry) => entry.queryKey);
    expect(keys).toContainEqual(['worker-pool', 'state', '1900000000001']);
    expect(lastParams()?.worker_id).toBe('1900000000001');
    scope.stop();
  });

  it('T6：invalidateWorkerStateByWorkerAll(qc) → 整个 state 域失效并重拉', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerStateByWorkerQuery(() => '1900000000001'));
    });
    await q!.refetch();
    const callsBefore = realGetWorkerState.mock.calls.length;

    await invalidateWorkerStateByWorkerAll(testQueryClient);
    await q!.refetch();

    expect(realGetWorkerState.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T7：invalidateWorkerStateByWorkerAll 走 qk.workerPoolStatePrefix（共享失效源）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateWorkerStateByWorkerAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['worker-pool', 'state'],
    });
  });
});