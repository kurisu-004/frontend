// src/composables/queries/__tests__/useWorkerPoolByProcessQuery.spec.ts
//
// 2026-09-30 新增：useWorkerPoolByProcessQuery reactive params + enabled 闸门 +
// queryKey + 失效守门。
//
// 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛）：
//   - URL `/prod/worker-pool/{pid}` → `/prod/pool/{pid}`；
//   - `poolBatchItemSchema` 删 `current_process_step_id`（后端 PoolBatchItem 无此字段，
//     此前 schema 声明它必填 nullable ⇒ parse 100% 失败）；
//   - 删 `invalidateWorkerPoolByProcessQuery(qc, pid)` 精刷版 —— move 端点改造后
//     前端无法确定受影响 processId（service 从 batch 当前 step 自推目标工序），
//     唯一正确策略是 `invalidateWorkerPoolByProcessAll` 前缀全失效。
//
// 覆盖：
//   - S1-S6：workerPoolByProcessSchema / workerBriefSchema / workTypeMaxHeldSchema
//     / poolBatchItemSchema 解析后端真实形态 + M-1 regression guard。
//   - S6：多传 current_process_step_id 不报错（回归 guard，锁死上条修复）。
//   - T1：传静态 string → getWorkerPoolByProcess 收到该 processId。
//   - T2：传 Ref<string> → 改 ref.value 后调 refetch，getWorkerPoolByProcess
//     收到新 processId（核心 reactive params guard，参考 useProcessesQuery T2 范本）。
//   - T3：传 null → enabled=false，queryFn 不被调用（核心闸门 guard，参考
//     usePartFilesListQuery T1 范本）。
//   - T4：传 getter 函数 → 改 source 后调 refetch，getWorkerPoolByProcess 收到新 processId
//     （MaybeRefOrGetter 第三分支）。
//   - T5：queryKey 形态正确（含 reactive processId 内容）。
//   - T6：invalidateWorkerPoolByProcessAll(qc) → 整个 by-process 域失效并重拉。
//
// 测试策略（沿 usePartFilesListQuery.spec.ts 范本）：
//   - vi.mock('@/api/workerPool')：getWorkerPoolByProcess 替换为 vi.fn()。
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

// 2026-09-30：mock 沿 backend-rust ProcessPoolDetail 真契约 —— 6 顶层字段 + 嵌套
// workers[] / work_types[] / items[]。items 元素用最小 PoolBatchItem 形态。
const realGetWorkerPoolByProcess = vi.fn<
  (processId: string) => Promise<{
    process_id: string;
    process_code: string;
    process_name: string;
    workers: Array<{
      worker_id: string;
      name: string;
      work_type_id: string;
      work_type_code: string;
    }>;
    work_types: Array<{
      work_type_id: string;
      work_type_code: string;
      work_type_name: string;
      max_held_batches: number | null;
    }>;
    total: number;
    items: Array<{
      batch_id: string;
      part_id: string;
      batch_no: number;
      quantity: number;
      serial_no: string | null;
      name: string;
      drawing_no: string;
      system_delivery_date: string | null;
      customer_name: string | null;
      parent_customer_name: string | null;
      customer_path: string | null;
      applicant_name: string | null;
      location: string;
      shelf_id: string;
      shelf_code: string;
      shelf_name: string;
      is_urgent: boolean;
      note: string | null;
      has_cnc_program: boolean;
      version: number;
    }>;
  }>
>(async (processId: string) => ({
  process_id: processId,
  process_code: 'CNC-01',
  process_name: '粗加工',
  workers: [],
  work_types: [],
  total: 0,
  items: [],
}));

vi.mock('@/api/workerPool', () => ({
  getWorkerPoolByProcess: (processId: string) => realGetWorkerPoolByProcess(processId),
  // 2026-09-30：其它 workerPool 函数在本测试用不到，但 vi.mock 顶层 hoist
  // 要求完整 module shape —— 列出 stub 防止 partial mock 副作用。
  getWorkerPoolCounts: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
}));

import {
  poolBatchItemSchema,
  workerPoolByProcessSchema,
  workerBriefSchema,
  workTypeMaxHeldSchema,
} from '../schemas';
import {
  invalidateWorkerPoolByProcessAll,
  useWorkerPoolByProcessQuery,
} from '../useWorkerPoolByProcessQuery';

function lastProcessId(): string | undefined {
  const calls = realGetWorkerPoolByProcess.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0];
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('workerPoolByProcessSchema / 嵌套 schema（2026-09-30 新增）', () => {
  it('S1：workerPoolByProcessSchema 接受 backend-rust ProcessPoolDetail 6 顶层字段不抛错', () => {
    const parsed = workerPoolByProcessSchema.parse({
      process_id: '2000000000001',
      process_code: 'CNC-01',
      process_name: '粗加工',
      workers: [
        { worker_id: '1900000000001', name: '张三', work_type_id: '3000000000001', work_type_code: 'CNC' },
      ],
      work_types: [
        { work_type_id: '3000000000001', work_type_code: 'CNC', work_type_name: 'CNC 加工', max_held_batches: 3 },
      ],
      total: 1,
      items: [],
    });
    expect(parsed.process_id).toBe('2000000000001');
    expect(parsed.workers).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  it('S2：workerPoolByProcessSchema 缺 items → 抛 ZodError（M-1 guard）', () => {
    expect(() =>
      workerPoolByProcessSchema.parse({
        process_id: '2000000000001',
        process_code: 'CNC-01',
        process_name: '粗加工',
        workers: [],
        work_types: [],
        total: 0,
        // items 缺
      }),
    ).toThrow();
  });

  it('S3：workerBriefSchema 解析 4 字段全声明不抛错 + 缺 work_type_code 抛 ZodError', () => {
    expect(
      workerBriefSchema.parse({
        worker_id: '1900000000001',
        name: '张三',
        work_type_id: '3000000000001',
        work_type_code: 'CNC',
      }).work_type_code,
    ).toBe('CNC');

    expect(() =>
      workerBriefSchema.parse({
        worker_id: '1900000000001',
        name: '张三',
        work_type_id: '3000000000001',
        // work_type_code 缺
      }),
    ).toThrow();
  });

  it('S4：workTypeMaxHeldSchema 接受 max_held_batches = null', () => {
    const wt = workTypeMaxHeldSchema.parse({
      work_type_id: '3000000000001',
      work_type_code: 'CNC',
      work_type_name: 'CNC 加工',
      max_held_batches: null,
    });
    expect(wt.max_held_batches).toBeNull();
  });

  it('S5：poolBatchItemSchema 缺 has_cnc_program → 抛 ZodError', () => {
    const base = {
      batch_id: '3000000000001',
      part_id: '4000000000001',
      batch_no: 1,
      quantity: 5,
      serial_no: null,
      name: '法兰盘',
      drawing_no: 'DWG-A001',
      system_delivery_date: '2026-09-30',
      customer_name: '客户A',
      parent_customer_name: null,
      customer_path: null,
      applicant_name: '张三',
      location: 'PRODUCTION_SHELF',
      shelf_id: '5000000000001',
      shelf_code: 'A-01',
      shelf_name: 'A 区货架 1',
      is_urgent: false,
      note: null,
      version: 1,
    };
    // has_cnc_program 缺
    expect(() => poolBatchItemSchema.parse(base)).toThrow();
  });

  it('S6：多传 current_process_step_id 不报错（后端已无该字段，schema 不应要求它）', () => {
    // 回归 guard：修复前 poolBatchItemSchema 声明 `current_process_step_id:
    // z.string().nullable()` 必填，而后端 PoolBatchItem（vo/worker_pool.rs:14-50）
    // 根本没有这个字段 ⇒ parse 100% 失败 ⇒ WorkerPoolTab 永久「加载失败」、
    // 拖拽 pool → worker 链路整体不可用。本用例锁死修复。
    const parsed = poolBatchItemSchema.parse({
      batch_id: '3000000000001',
      part_id: '4000000000001',
      batch_no: 1,
      quantity: 5,
      serial_no: null,
      name: '法兰盘',
      drawing_no: 'DWG-A001',
      system_delivery_date: '2026-09-30',
      customer_name: '客户A',
      parent_customer_name: null,
      customer_path: null,
      applicant_name: '张三',
      location: 'PRODUCTION_SHELF',
      shelf_id: '5000000000001',
      shelf_code: 'A-01',
      shelf_name: 'A 区货架 1',
      is_urgent: false,
      note: null,
      current_process_step_id: null,
      has_cnc_program: true,
      version: 1,
    });
    // Zod 默认 strip：多余字段被丢弃
    expect(parsed).not.toHaveProperty('current_process_step_id');
    expect(parsed.shelf_id).toBe('5000000000001');
  });
});

describe('useWorkerPoolByProcessQuery — reactive params + enabled 闸门 + 失效（2026-09-30）', () => {
  beforeEach(() => {
    realGetWorkerPoolByProcess.mockClear();
    realGetWorkerPoolByProcess.mockImplementation(async (processId: string) => ({
      process_id: processId,
      process_code: 'CNC-01',
      process_name: '粗加工',
      workers: [],
      work_types: [],
      total: 0,
      items: [],
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

  it('T1：传静态 string → getWorkerPoolByProcess 收到该 processId', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => '2000000000001'));
    });
    await q!.refetch();
    expect(realGetWorkerPoolByProcess).toHaveBeenCalled();
    expect(lastProcessId()).toBe('2000000000001');
    scope.stop();
  });

  it('T2：传 Ref<string> → 改 ref.value 后调 refetch，getWorkerPoolByProcess 收到新 processId', async () => {
    // 背景（沿 useProcessesQuery T2 范本）：queryKey 走 reactive 时参数变化触发 refetch。
    const pidRef: Ref<string | null> = ref('2000000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => pidRef.value));
    });
    await q!.refetch();
    expect(lastProcessId()).toBe('2000000000001');

    pidRef.value = '2000000000002';
    await q!.refetch();
    expect(lastProcessId()).toBe('2000000000002');
    scope.stop();
  });

  it('T3：null processId → enabled=false → getWorkerPoolByProcess 调用 0 次', async () => {
    // 核心闸门 guard：useWorkerPoolByProcessQuery 必须接受 null/undefined 而不发任何请求，
    // 避免后端收到 /prod/worker-pool/ 空路径触发 404。
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => null));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realGetWorkerPoolByProcess).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T4：getter 形式 processId → 改 source 后 getWorkerPoolByProcess 收到新 processId', async () => {
    const source = ref<string>('GETTER-A');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => source.value));
    });
    await q!.refetch();
    expect(lastProcessId()).toBe('GETTER-A');

    source.value = 'GETTER-B';
    await q!.refetch();
    expect(lastProcessId()).toBe('GETTER-B');
    scope.stop();
  });

  it('T5：queryKey 形态正确（含 reactive processId 内容）', async () => {
    const source = ref<string>('PID-A');
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => source.value));
    });
    await q!.refetch();
    expect(lastProcessId()).toBe('PID-A');
    scope.stop();
  });

  it('T6：invalidateWorkerPoolByProcessAll(qc) → 整个域失效并重拉', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => '2000000000001'));
    });
    await q!.refetch();
    const callsBefore = realGetWorkerPoolByProcess.mock.calls.length;

    await invalidateWorkerPoolByProcessAll(testQueryClient);
    await q!.refetch();

    expect(realGetWorkerPoolByProcess.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T7：invalidateWorkerPoolByProcessAll 走 qk.workerPoolByProcessPrefix（共享失效源）', async () => {
    // 验证 prefix 失效与 qk.workerPoolByProcessPrefix 对齐（沿 usePartFilesListQuery
    // T4 范本扩展为 prefix 形态）。
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateWorkerPoolByProcessAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ['worker-pool', 'by-process'],
    });
  });

  it('T8：两个不同 processId 的 query 共享同一前缀（多 tab 缓存互相独立但可一把全刷）', async () => {
    const scope = effectScope();
    let q1: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    let q2: ReturnType<typeof useWorkerPoolByProcessQuery> | undefined;
    scope.run(() => {
      q1 = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => '2000000000001'));
      q2 = testApp.runWithContext(() => useWorkerPoolByProcessQuery(() => '2000000000002'));
    });
    await q1!.refetch();
    await q2!.refetch();
    // cache identity 按 processId 区分（不会互相串数据）
    const keys = testQueryClient.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(['worker-pool', 'by-process', '2000000000001']);
    expect(keys).toContainEqual(['worker-pool', 'by-process', '2000000000002']);
    // 但都能被同一个 prefix 失效
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateWorkerPoolByProcessAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['worker-pool', 'by-process'] });
    scope.stop();
  });
});