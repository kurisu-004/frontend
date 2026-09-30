// src/composables/queries/__tests__/useWorkerPoolCountsQuery.spec.ts
//
// 2026-09-30 新增：useWorkerPoolCountsQuery 常量 queryKey + 失效守门。
// 2026-09-30 重写：后端 worker-pool → pool 路径收敛 + counts 端点去掉 shelf 维度
// （handler.rs:146-153 无 Query extractor，WorkerPoolCountsOut 只有 counts + total）。
//   ⇒ queryKey 退化为常量 ['worker-pool','counts']；
//   ⇒ getWorkerPoolCounts() 不再接任何 params；
//   ⇒ workerPoolCountsSchema 删 shelf_id（此前声明为必填 nullable ⇒ parse 永远失败）。
//
// 覆盖：
//   - S1：workerPoolCountsSchema 接受 backend-rust WorkerPoolCountsOut 真契约
//     （counts[] + total）不抛错；带多余 shelf_id 时被 strip（不报错）。
//   - S2：缺 total → 抛 ZodError（M-1 strip regression guard）。
//   - S3：**多传 shelf_id 不报错**（回归 guard —— 后端不返该字段，前端传了也只能被
//     strip；此用例锁死「schema 不要求 shelf_id」这一修复）。
//   - T1：零参调用 → 正常拉取（queryFn 不传任何 params）。
//   - T2：queryKey 形态是常量 ['worker-pool','counts']（无第三项）。
//   - T3：queryKey 与 qk.workerPoolCounts 同源（禁止调用点拼字面量数组）。
//   - T4：counts[] 元素 4 字段全声明 —— 缺 count → 抛 ZodError。
//   - T5：invalidateWorkerPoolCountsQuery → 失效后下一次 refetch 重新调用 api。
//   - T6：invalidateWorkerPoolCountsQuery 走 qk.workerPoolCountsPrefix（共享失效源）。
//
// 测试策略（沿 usePendingBatchesQuery.spec.ts 范本）：
//   - vi.mock('@/api/workerPool')：getWorkerPoolCounts 替换为 vi.fn()。
//   - vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))：防 vitest
//     node env 中 ElMessage 内部 normalizeAppendTo 触发 ReferenceError。

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

// 2026-09-30：mock 沿 backend-rust WorkerPoolCountsOut 真契约 —— 只有 counts[] + total
// 两字段（后端 dto.rs 无 shelf_id）。
const realGetWorkerPoolCounts = vi.fn<() => Promise<{
  counts: Array<{
    process_id: string;
    process_code: string;
    process_name: string;
    count: number;
  }>;
  total: number;
}>>(async () => ({ counts: [], total: 0 }));

vi.mock('@/api/workerPool', () => ({
  // 2026-09-30：getWorkerPoolCounts 不再接受 params（后端端点无 Query extractor）
  getWorkerPoolCounts: () => realGetWorkerPoolCounts(),
  // 2026-09-30：worker-pool → pool 路径收敛，assign + remove 合并为 move。
  // 其它 pool 函数在本测试用不到，但 vi.mock 顶层 hoist 要求完整 module shape ——
  // 列出 stub 防止 partial mock 副作用（与 useProcessesQuery 范本一致）。
  getWorkerPoolByProcess: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
}));

import { workerPoolCountsSchema } from '../schemas';
import { qk } from '../keys';
import {
  invalidateWorkerPoolCountsQuery,
  useWorkerPoolCountsQuery,
} from '../useWorkerPoolCountsQuery';

const EMPTY_PAYLOAD = { counts: [], total: 0 };

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('workerPoolCountsSchema（2026-09-30 契约漂移修复）', () => {
  it('S1：解析 backend-rust WorkerPoolCountsOut 真契约（counts[] + total）不抛错', () => {
    const parsed = workerPoolCountsSchema.parse({
      counts: [
        { process_id: '2000000000001', process_code: 'CNC-01', process_name: '粗加工', count: 5 },
        { process_id: '2000000000002', process_code: 'QC-01', process_name: '质检', count: 2 },
      ],
      total: 7,
    });
    expect(parsed.counts).toHaveLength(2);
    expect(parsed.total).toBe(7);
    expect(parsed.counts[0].count).toBe(5);
  });

  it('S2：缺 total → 抛 ZodError（M-1 strip regression guard）', () => {
    // 必填字段被去掉的 regression guard —— 若 schema 误把 total 标成 optional，
    // 此用例会失败，必须立刻报警。
    expect(() => workerPoolCountsSchema.parse({ counts: [] })).toThrow();
  });

  it('S3：多传 shelf_id 不报错（后端已无该字段，schema 不应要求它）', () => {
    // 回归 guard：修复前 schema 声明 `shelf_id: z.string().nullable()` 必填，
    // 而后端从不返该字段 ⇒ parse 100% 失败 ⇒ tab 徽标恒 0。本用例锁死修复。
    const parsed = workerPoolCountsSchema.parse({
      shelf_id: '5000000000001',
      counts: [],
      total: 0,
    });
    // Zod 默认 strip：多余字段被丢弃，不出现在解析结果里
    expect(parsed).toEqual({ counts: [], total: 0 });
  });

  it('S4：counts 元素缺 count → 抛 ZodError（元素 4 字段全声明）', () => {
    expect(() =>
      workerPoolCountsSchema.parse({
        counts: [{ process_id: '1', process_code: 'A', process_name: '甲' }],
        total: 1,
      }),
    ).toThrow();
  });
});

describe('useWorkerPoolCountsQuery — 常量 queryKey + 失效守门（2026-09-30）', () => {
  beforeEach(() => {
    realGetWorkerPoolCounts.mockClear();
    realGetWorkerPoolCounts.mockResolvedValue(EMPTY_PAYLOAD);
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
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery());
    });
    await q!.refetch();
    expect(realGetWorkerPoolCounts).toHaveBeenCalled();
    // 后端端点无 Query extractor —— 一个参数都不能有
    expect(realGetWorkerPoolCounts.mock.calls[0]).toHaveLength(0);
    scope.stop();
  });

  it('T2：queryKey 形态是常量 [\'worker-pool\', \'counts\']（无第三项）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery());
    });
    await q!.refetch();
    // queryKey 不在 UseQueryReturnType 上，从 queryCache 反查实际落库的键
    const keys = testQueryClient.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(['worker-pool', 'counts']);
    scope.stop();
  });

  it('T3：queryKey 与 qk.workerPoolCounts 同源（禁止调用点拼字面量数组）', () => {
    expect(qk.workerPoolCounts).toEqual(['worker-pool', 'counts']);
    expect(qk.workerPoolCountsPrefix).toEqual(['worker-pool', 'counts']);
  });

  it('T4：真实 counts 数据透传到 query.data', async () => {
    realGetWorkerPoolCounts.mockResolvedValue({
      counts: [
        { process_id: '2000000000001', process_code: 'CNC-01', process_name: '粗加工', count: 5 },
      ],
      total: 5,
    });
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery());
    });
    await q!.refetch();
    expect(q!.data.value?.counts[0]?.count).toBe(5);
    expect(q!.data.value?.total).toBe(5);
    scope.stop();
  });

  it('T5：invalidateWorkerPoolCountsQuery → 失效后下一次 refetch 重新调用 api', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolCountsQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolCountsQuery());
    });
    await q!.refetch();
    const callsBefore = realGetWorkerPoolCounts.mock.calls.length;

    await invalidateWorkerPoolCountsQuery(testQueryClient);
    await q!.refetch();

    expect(realGetWorkerPoolCounts.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T6：invalidateWorkerPoolCountsQuery 走 qk.workerPoolCountsPrefix（共享失效源）', async () => {
    // 不变量：usePendingDispatch 跨域失效链与 useWorkerQueue 单点失效都通过
    // qk.workerPoolCountsPrefix 命中 counts 缓存，行为不分叉。
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateWorkerPoolCountsQuery(testQueryClient);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['worker-pool', 'counts'],
    });
  });
});
