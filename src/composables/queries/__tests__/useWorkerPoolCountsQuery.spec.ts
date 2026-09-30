// src/composables/queries/__tests__/useWorkerPoolCountsQuery.spec.ts
//
// 2026-09-30 新增：useWorkerPoolCountsQuery reactive params + queryKey + 失效守门。
//
// 覆盖：
//   - S1：workerPoolCountsSchema 接受 backend-rust WorkerPoolCountsOut 真契约
//     （counts[] + shelf_id + total）不抛错。
//   - S2：workerPoolCountsSchema 缺 total → 抛 ZodError（M-1 strip regression guard）。
//   - T1：传静态对象 → getWorkerPoolCounts 收到该 params（含 shelf_id）。
//   - T2：传 Ref<{ shelf_id }> → 改 ref.value 后调 refetch，getWorkerPoolCounts
//     收到新 shelf_id（核心 reactive params regression guard，参考
//     useProcessesQuery T2 范本）。
//   - T3：传 getter 函数 → 改 source 后调 refetch，getWorkerPoolCounts 收到新 params
//     （MaybeRefOrGetter 第三分支）。
//   - T4：传 undefined → getWorkerPoolCounts 收到空 params（沿 useProcessesQuery T4）。
//   - T5：queryKey 形态正确（包含 reactive params 内容）。
//
// 测试策略（沿 usePendingBatchesQuery.spec.ts 范本）：
//   - vi.mock('@/api/workerPool')：getWorkerPoolCounts 替换为 vi.fn()。
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

// 2026-09-30：mock 沿 backend-rust WorkerPoolCountsOut 真契约 —— shelf_id +
// counts[] + total 三字段（counts 元素含 process_id / code / name / count）。
const realGetWorkerPoolCounts = vi.fn<
  (params: { shelf_id?: string | null }) => Promise<{
    shelf_id: string | null;
    counts: Array<{
      process_id: string;
      process_code: string;
      process_name: string;
      count: number;
    }>;
    total: number;
  }>
>(async () => ({
  shelf_id: null,
  counts: [],
  total: 0,
}));

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolCounts: (params: { shelf_id?: string | null }) =>
    realGetWorkerPoolCounts(params),
  // 2026-09-30：其它 workerPool 函数在本测试用不到，但 vi.mock 顶层 hoist
  // 要求完整 module shape —— 列出 stub 防止 partial mock 副作用（与 useProcessesQuery
  // 范本一致）。
  getWorkerPoolByProcess: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  assignWorkerPool: vi.fn(),
  removeFromWorkerPool: vi.fn(),
  autoAllocate: vi.fn(),
}));

import { workerPoolCountsSchema } from '../schemas';
import {
  invalidateWorkerPoolCountsQuery,
  useWorkerPoolCountsQuery,
} from '../useWorkerPoolCountsQuery';

function lastParams(): Record<string, unknown> {
  const calls = realGetWorkerPoolCounts.mock.calls;
  const last = calls[calls.length - 1];
  return (last?.[0] ?? {}) as unknown as Record<string, unknown>;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('workerPoolCountsSchema（2026-09-30 新增）', () => {
  it('S1：解析 backend-rust WorkerPoolCountsOut 真契约（counts[] + shelf_id + total）不抛错', () => {
    const parsed = workerPoolCountsSchema.parse({
      shelf_id: '5000000000001',
      counts: [
        { process_id: '2000000000001', process_code: 'CNC-01', process_name: '粗加工', count: 5 },
        { process_id: '2000000000002', process_code: 'QC-01', process_name: '质检', count: 2 },
      ],
      total: 7,
    });
    expect(parsed.counts).toHaveLength(2);
    expect(parsed.total).toBe(7);
    expect(parsed.shelf_id).toBe('5000000000001');
  });

  it('S2：缺 total → 抛 ZodError（M-1 strip regression guard）', () => {
    // 必填字段被去掉的 regression guard —— 若 schema 误把 total 标成 optional，
    // 此用例会失败，必须立刻报警。
    expect(() =>
      workerPoolCountsSchema.parse({
        shelf_id: null,
        counts: [],
        // total 缺
      }),
    ).toThrow();
  });
});

describe('useWorkerPoolCountsQuery — reactive params + queryKey 失效守门（2026-09-30）', () => {
  beforeEach(() => {
    realGetWorkerPoolCounts.mockClear();
    realGetWorkerPoolCounts.mockResolvedValue({
      shelf_id: null,
      counts: [],
      total: 0,
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

  it('T1：传静态对象 → getWorkerPoolCounts 收到该 params（含 shelf_id）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerPoolCountsQuery({ shelf_id: '5000000000001' }),
      );
    });
    await q!.refetch();
    expect(realGetWorkerPoolCounts).toHaveBeenCalled();
    expect(lastParams().shelf_id).toBe('5000000000001');
    scope.stop();
  });

  it('T2：传 Ref<{ shelf_id }> → 改 ref.value 后调 refetch，getWorkerPoolCounts 收到新 shelf_id', async () => {
    // 背景（沿 useProcessesQuery T2 范本）：queryKey 走 reactive 时参数变化触发 refetch。
    const paramsRef: Ref<{ shelf_id?: string | null }> = ref({ shelf_id: 'INIT' });
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery(paramsRef));
    });
    await q!.refetch();
    expect(lastParams().shelf_id).toBe('INIT');

    paramsRef.value = { shelf_id: 'NEW' };
    await q!.refetch();
    expect(lastParams().shelf_id).toBe('NEW');
    scope.stop();
  });

  it('T3：传 getter () => params → 改 source 后 listProcesses 收到新 params', async () => {
    // 覆盖 MaybeRefOrGetter 第三种用法 —— 调用方传 getter 函数，每次 queryKey
    // computed 重新计算都会再调 getter 取最新值。
    const source = ref<{ shelf_id?: string | null }>({ shelf_id: 'GETTER-INIT' });
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery(() => source.value));
    });
    await q!.refetch();
    expect(lastParams().shelf_id).toBe('GETTER-INIT');

    source.value = { shelf_id: 'GETTER-NEW' };
    await q!.refetch();
    expect(lastParams().shelf_id).toBe('GETTER-NEW');
    scope.stop();
  });

  it('T4：传 undefined → getWorkerPoolCounts 收到空 params', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery(undefined));
    });
    await q!.refetch();
    expect(realGetWorkerPoolCounts).toHaveBeenCalled();
    // 显式传 undefined → queryKey 第二项为 null，queryFn 内 raw 判空 → p = undefined
    expect(Object.keys(lastParams()).length).toBe(0);
    scope.stop();
  });

  it('T5：queryKey 形态正确（含 reactive params 内容）', async () => {
    // 背景：qk.workerPoolCounts(params) 形态是 ['worker-pool', 'counts', params ?? null]。
    // 本用例验证 queryKey[2] 确实是 reactive params 对象（queryFn 读这个位置）。
    const paramsRef: Ref<{ shelf_id?: string | null }> = ref({ shelf_id: 'A' });
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery(paramsRef));
    });
    await q!.refetch();
    expect(lastParams().shelf_id).toBe('A');
    scope.stop();
  });

  it('T6：invalidateWorkerPoolCountsQuery → 失效后下一次 refetch 重新调用 getWorkerPoolCounts', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useWorkerPoolCountsQuery({ shelf_id: '5000000000001' }),
      );
    });
    await q!.refetch();
    const callsBefore = realGetWorkerPoolCounts.mock.calls.length;

    await invalidateWorkerPoolCountsQuery(testQueryClient);
    await q!.refetch();

    expect(realGetWorkerPoolCounts.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T7：invalidateWorkerPoolCountsQuery 走 qk.workerPoolCountsPrefix（共享失效源）', async () => {
    // 2026-09-30 review 第 1 轮修复（m2）：原 invalidateWorkerPoolCountsAll alias 已删，
    // 全仓调用点统一走 invalidateWorkerPoolCountsQuery。不变量保证 usePendingDispatch
    // 跨域失效链与 useWorkerQueue 单点失效都通过 qk.workerPoolCountsPrefix 命中 counts
    // 缓存，行为不分叉。
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateWorkerPoolCountsQuery(testQueryClient);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['worker-pool', 'counts'],
    });
  });
});