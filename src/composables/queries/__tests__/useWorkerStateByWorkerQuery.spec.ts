// src/composables/queries/__tests__/useWorkerStateByWorkerQuery.spec.ts
//
// 2026-09-30 新增：useWorkerStateByWorkerQuery 双 reactive params + enabled 闸门 +
// queryKey + 失效守门。
//
// 覆盖：
//   - S1-S4：workerStateSchema 解析后端真契约 + work_type_code nullable + 缺
//     held_batches 抛 ZodError + 缺 max_held 抛 ZodError。
//   - T1：传静态 string → getWorkerState 收到 worker_id + shelf_id。
//   - T2：传 Ref（workerId）+ Ref（shelfId）→ 改任一 ref.value 后调 refetch，
//     getWorkerState 收到新参数对（核心 reactive params 双参数 guard）。
//   - T3：workerId = null → enabled=false，queryFn 不被调用（核心闸门 guard）。
//   - T4：shelfId = null（workerId 有效） → enabled=false，queryFn 不被调用
//     （双参数闸门：workerId 满足但 shelfId 不满足 → 仍不发起请求）。
//   - T5：queryKey 形态正确（含 workerId + shelfId 内容）。
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
  (params: { worker_id: string; shelf_id: string }) => Promise<{
    worker_id: string;
    worker_name: string;
    work_type_code: string | null;
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
>(async (params: { worker_id: string; shelf_id: string }) => ({
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
  getWorkerState: (params: { worker_id: string; shelf_id: string }) =>
    realGetWorkerState(params),
  // 2026-09-30：其它 workerPool 函数在本测试用不到，列出 stub 防止 partial mock 副作用。
  getWorkerPoolCounts: vi.fn(),
  getWorkerPoolByProcess: vi.fn(),
  refillWorkerPool: vi.fn(),
  assignWorkerPool: vi.fn(),
  removeFromWorkerPool: vi.fn(),
  autoAllocate: vi.fn(),
}));

import { workerStateSchema } from '../schemas';
import {
  invalidateWorkerStateByWorkerAll,
  invalidateWorkerStateByWorkerQuery,
  useWorkerStateByWorkerQuery,
} from '../useWorkerStateByWorkerQuery';

function lastParams(): { worker_id: string; shelf_id: string } | undefined {
  const calls = realGetWorkerState.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0] as { worker_id: string; shelf_id: string } | undefined;
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

  it('S2：work_type_code = null 是合法值（无工种场景）', () => {
    const parsed = workerStateSchema.parse(makeBaseState({ work_type_code: null }));
    expect(parsed.work_type_code).toBeNull();
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

describe('useWorkerStateByWorkerQuery — 双 reactive params + enabled 闸门 + 失效（2026-09-30）', () => {
  beforeEach(() => {
    realGetWorkerState.mockClear();
    realGetWorkerState.mockImplementation(
      async (params: { worker_id: string; shelf_id: string }) => ({
        worker_id: params.worker_id,
        worker_name: '工人甲',
        work_type_code: 'CNC',
        max_held: 3,
        current_held: 0,
        capacity_remaining: 3,
        pool_count_by_process: [],
        held_batches: [],
      }),
    );
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

  it('T1：传静态 string → getWorkerState 收到 worker_id + shelf_id', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerStateByWorkerQuery(
          () => '1900000000001',
          () => '5000000000001',
        ),
      );
    });
    await q!.refetch();
    expect(realGetWorkerState).toHaveBeenCalled();
    expect(lastParams()?.worker_id).toBe('1900000000001');
    expect(lastParams()?.shelf_id).toBe('5000000000001');
    scope.stop();
  });

  it('T2：传 Ref<workerId> + Ref<shelfId> → 改任一 ref.value 后调 refetch，getWorkerState 收到新参数对', async () => {
    // 背景（沿 useProcessesQuery T2 范本扩展为双参数 reactive guard）。
    const widRef: Ref<string | null> = ref('1900000000001');
    const sidRef: Ref<string | null> = ref('5000000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerStateByWorkerQuery(
          () => widRef.value,
          () => sidRef.value,
        ),
      );
    });
    await q!.refetch();
    expect(lastParams()?.worker_id).toBe('1900000000001');
    expect(lastParams()?.shelf_id).toBe('5000000000001');

    // 改 widRef
    widRef.value = '1900000000002';
    await q!.refetch();
    expect(lastParams()?.worker_id).toBe('1900000000002');
    expect(lastParams()?.shelf_id).toBe('5000000000001');

    // 改 sidRef
    sidRef.value = '5000000000002';
    await q!.refetch();
    expect(lastParams()?.worker_id).toBe('1900000000002');
    expect(lastParams()?.shelf_id).toBe('5000000000002');
    scope.stop();
  });

  it('T3：workerId = null → enabled=false → getWorkerState 调用 0 次', async () => {
    // 核心闸门 guard：workerId null 必须不发请求（避免后端 422）。
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerStateByWorkerQuery(() => null, () => '5000000000001'),
      );
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realGetWorkerState).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T4：shelfId = null（workerId 有效） → enabled=false → getWorkerState 调用 0 次', async () => {
    // 双参数闸门：workerId 满足但 shelfId 不满足 → 仍不发起请求
    // （避免后端 40001 BIZ_SHELF_NOT_FOUND）。
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerStateByWorkerQuery(() => '1900000000001', () => null),
      );
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realGetWorkerState).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T5：queryKey 形态正确（含 workerId + shelfId 内容）', async () => {
    const widSource = ref<string>('1900000000001');
    const sidSource = ref<string>('5000000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerStateByWorkerQuery(
          () => widSource.value,
          () => sidSource.value,
        ),
      );
    });
    await q!.refetch();
    expect(lastParams()?.worker_id).toBe('1900000000001');
    expect(lastParams()?.shelf_id).toBe('5000000000001');
    scope.stop();
  });

  it('T6：invalidateWorkerStateByWorkerQuery(qc, wid, sid) → 该 (wid, sid) 的 query 失效并重拉', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerStateByWorkerQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerStateByWorkerQuery(
          () => '1900000000001',
          () => '5000000000001',
        ),
      );
    });
    await q!.refetch();
    const callsBefore = realGetWorkerState.mock.calls.length;

    await invalidateWorkerStateByWorkerQuery(
      testQueryClient,
      '1900000000001',
      '5000000000001',
    );
    await q!.refetch();

    expect(realGetWorkerState.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T7：invalidateWorkerStateByWorkerAll(qc) → 整个 state 域失效', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateWorkerStateByWorkerAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['worker-pool', 'state'],
    });
  });
});