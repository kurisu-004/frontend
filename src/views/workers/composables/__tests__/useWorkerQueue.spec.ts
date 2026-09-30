// src/views/workers/composables/__tests__/useWorkerQueue.spec.ts
//
// 2026-09-30 重写：useWorkerQueue mutation onSuccess + invalidate helpers + loadBoard
// workerHeld 路径守门。
//
// 2026-09-30 改造要点：
// - 删 `processPools` / `filteredWorkers` / `moveBatchToWorker`/`Pool` 乐观更新路径
//   —— pool 数据流已迁到 useWorkerPoolByProcessQuery，mutation 走 TanStack useMutation
//   + onSuccess invalidate；
// - loadBoard 简化为「并发拉 cache 内所有 worker 的 state」—— 必须先 queryClient
//   setQueryData 注入 worker-pool by-process 缓存，loadBoard 才能拿到 worker_ids；
// - 3 个 mutation 走 TanStack —— assignMutation / removeMutation / autoAllocateMutation
//   的 mutateAsync 包装，断言 onSuccess 调 invalidateWorkerPoolByProcessQuery +
//   invalidateWorkerPoolCountsQuery。
//
// 覆盖：
//   - T1：loadBoard 从 cache 内收集 worker_ids → 并发 getWorkerState → workerHeld 写入
//     HeldBatchItem 全字段；
//   - T2：loadBoard（shelfId = null）→ workerHeld 清空，跳过 GET；
//   - T3：moveBatchToWorker 成功 → assignWorkerPool 被调 + 2 个 invalidate helpers 被调；
//   - T4：moveBatchToWorker 失败 → catch 路径返回 false + error.value 写入 + ElMessage.error；
//   - T5：moveBatchToPool 成功 → removeFromWorkerPool 被调 + 2 个 invalidate helpers 被调；
//   - T6：runAutoAllocate 成功 → autoAllocate 被调 + 2 个 invalidate helpers 被调；
//   - T7：runAutoAllocate 失败 → onError 路径 error.value 写入。
//
// 测试策略：
//   - vi.mock('@/api/workerPool') + vi.mock('@/api/processChain') + vi.mock('element-plus')；
//   - vi.spyOn(qc, 'invalidateQueries') 验证 mutation onSuccess 失效链；
//   - 每个测试用 testApp.runWithContext(() => useWorkerQueue()) 注入 QueryClient；
//   - 必须先 queryClient.setQueryData 注入 by-process 缓存，否则 loadBoard 收集不到
//     worker_ids（这是新行为 —— 旧版本 loadBoard 是主动拉 processes + 各 worker-pool，
//     现在是被动消费 cache）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { WorkerStateDto } from '@/api/workerPool.contract';
import { qk } from '@/composables/queries/keys';
import { ApiError } from '@/api/http';

// stub WorkerStateDto（每个 worker 一条；W001 含 1 个 HeldBatchItemDto 全字段）
const STUB_STATES: Record<string, WorkerStateDto> = {
  '1900000000001': {
    worker_id: '1900000000001',
    worker_name: '张三',
    work_type_code: 'CNC',
    max_held: 3,
    current_held: 1,
    capacity_remaining: 2,
    pool_count_by_process: [{ process_id: '2000000000001', pool_count: 2 }],
    held_batches: [
      {
        batch_id: '2100000000001',
        part_id: '1800000000001',
        batch_no: 1,
        quantity: 5,
        serial_no: 'F001-001',
        drawing_no: 'DWG-001',
        name: '零件甲',
        system_delivery_date: '2026-09-30',
        planned_delivery_date: '2026-10-15',
        is_urgent: true,
        customer_name: '法拉电子',
        parent_customer_name: null,
        applicant_name: '张三',
        location: 'WORKER',
        shelf_code: 'A-01',
        note: '加急',
        has_cnc_program: true,
        version: 3,
      },
    ],
  },
  '1900000000002': {
    worker_id: '1900000000002',
    worker_name: '李四',
    work_type_code: 'CNC',
    max_held: 3,
    current_held: 0,
    capacity_remaining: 3,
    pool_count_by_process: [{ process_id: '2000000000001', pool_count: 2 }],
    held_batches: [],
  },
  '1900000000003': {
    worker_id: '1900000000003',
    worker_name: '王五',
    work_type_code: 'QC',
    max_held: 2,
    current_held: 2,
    capacity_remaining: 0,
    pool_count_by_process: [{ process_id: '2000000000002', pool_count: 1 }],
    held_batches: [],
  },
};

// mock api/workerPool：保留 assignWorkerPool / removeFromWorkerPool / autoAllocate /
// getWorkerState 四个端点（commit 4 起 useWorkerQueue 不再调 listProcesses +
// getWorkerPoolByProcess）。
const realAssignWorkerPool = vi.fn<
  (req: { worker_id: string; batch_id: string }) => Promise<{
    worker_id: string;
    batch_id: string;
    shelf_id: string;
    taken: { batch_id: string; part_id: string; batch_no: number; version: number };
    current_held: number;
    max_held: number;
  }>
>(async (req: { worker_id: string; batch_id: string }) => ({
  worker_id: req.worker_id,
  batch_id: req.batch_id,
  shelf_id: '5000000000001',
  taken: {
    batch_id: req.batch_id,
    part_id: '4000000000001',
    batch_no: 1,
    version: 2,
  },
  current_held: 1,
  max_held: 3,
}));

const realRemoveFromWorkerPool = vi.fn<
  () => Promise<{
    batch_id: string;
    part_id: string;
    batch_no: number;
    version: number;
  }>
>(async () => ({
  batch_id: '3000000000010',
  part_id: '4000000000010',
  batch_no: 10,
  version: 2,
}));

const realAutoAllocate = vi.fn<
  () => Promise<{
    process_id: string;
    shelf_id: string;
    filled: unknown[];
    pool_empty: boolean;
  }>
>(async () => ({
  process_id: '2000000000001',
  shelf_id: '5000000000001',
  filled: [],
  pool_empty: false,
}));

const realGetWorkerState = vi.fn<
  (params: { worker_id: string; shelf_id: string }) => Promise<WorkerStateDto>
>(async (params: { worker_id: string; shelf_id: string }) => {
  const s = STUB_STATES[params.worker_id];
  if (!s) throw new Error('unknown worker');
  return s;
});

vi.mock('@/api/workerPool', () => ({
  // 2026-09-30：commit 4 起 useWorkerQueue 不再调 listProcesses / getWorkerPoolByProcess，
  // 保留 assignWorkerPool / removeFromWorkerPool / autoAllocate / getWorkerState 4 个端点。
  assignWorkerPool: (...args: unknown[]) => realAssignWorkerPool(...(args as Parameters<typeof realAssignWorkerPool>)),
  removeFromWorkerPool: (...args: unknown[]) => realRemoveFromWorkerPool(...(args as Parameters<typeof realRemoveFromWorkerPool>)),
  autoAllocate: (...args: unknown[]) => realAutoAllocate(...(args as Parameters<typeof realAutoAllocate>)),
  getWorkerState: (...args: unknown[]) => realGetWorkerState(...(args as Parameters<typeof realGetWorkerState>)),
  // 列出 stub 防止 partial mock 副作用（commit 4 不再消费）
  getWorkerPoolCounts: vi.fn(),
  getWorkerPoolByProcess: vi.fn(),
  refillWorkerPool: vi.fn(),
}));

// 2026-09-30：commit 4 起 useWorkerQueue 不再调 listProcesses，mock 不需要。
// 保留 mock 占位以防 vi.mock hoist 副作用。

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  // 每个测试前重置 QueryClient，确保 cache 干净（避免 by-process cache 跨 test 复用）
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  vi.spyOn(testQueryClient, 'invalidateQueries');
});

afterEach(() => {
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

/** 2026-09-30 工具：在 testQueryClient 内预先 setQueryData by-process 缓存，
 *  让 loadBoard 收集 worker_ids（commit 4 起 loadBoard 不再主动拉 processes +
 * 各 worker-pool）。 */
function seedByProcessCache() {
  // 注入两条 by-process 缓存：2000000000001 含 W001/W002；2000000000002 含 W003。
  testQueryClient.setQueryData(qk.workerPoolByProcess('2000000000001'), {
    process_id: '2000000000001',
    process_code: 'CNC-01',
    process_name: '粗加工',
    workers: [
      { worker_id: '1900000000001', name: '张三', work_type_id: '3000000000001', work_type_code: 'CNC' },
      { worker_id: '1900000000002', name: '李四', work_type_id: '3000000000001', work_type_code: 'CNC' },
    ],
    work_types: [],
    total: 2,
    items: [],
  });
  testQueryClient.setQueryData(qk.workerPoolByProcess('2000000000002'), {
    process_id: '2000000000002',
    process_code: 'QC-01',
    process_name: '质检',
    workers: [
      { worker_id: '1900000000003', name: '王五', work_type_id: '3000000000002', work_type_code: 'QC' },
    ],
    work_types: [],
    total: 1,
    items: [],
  });
}

describe('useWorkerQueue — 2026-09-30 重构：mutations + invalidate + workerHeld seed', () => {
  it('T1：loadBoard 从 cache 收集 worker_ids → 并发 getWorkerState → workerHeld 写入 HeldBatchItem 全字段', async () => {
    // 2026-09-30：必须先 setQueryData 注入 by-process 缓存，loadBoard 才能收集到 worker_ids
    // （commit 4 起 loadBoard 不再主动拉 processes + 各 worker-pool）。
    seedByProcessCache();
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    await q.loadBoard('5000000000001');

    // W001 含 1 item 全字段
    expect(q.workerHeld.value['1900000000001']).toHaveLength(1);
    const card = q.workerHeld.value['1900000000001']![0]!;
    expect(card.part_name).toBe('零件甲');
    expect(card.customer).toBe('法拉电子');
    expect(card.applicant).toBe('张三');
    expect(card.location).toBe('WORKER');
    expect(card.has_cnc_program).toBe(true);
    expect(card.drawing_no).toBe('DWG-001');
    expect(card.batch_no).toBe('B1');
    // W002/W003 空
    expect(q.workerHeld.value['1900000000002']).toEqual([]);
    expect(q.workerHeld.value['1900000000003']).toEqual([]);
  });

  it('T2：loadBoard（shelfId = null）→ workerHeld 清空，跳过 GET', async () => {
    // 2026-09-30：shelfId 缺 → loadBoard 直接清空 workerHeld，不发任何请求。
    seedByProcessCache();
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    // 预填 workerHeld 以验证 loadBoard 会清空
    q.workerHeld.value['1900000000001'] = [];
    await q.loadBoard(null);
    expect(q.workerHeld.value).toEqual({});
    expect(realGetWorkerState).not.toHaveBeenCalled();
  });

  it('T3：moveBatchToWorker 成功 → assignWorkerPool 被调 + invalidateWorkerPoolByProcessQuery + invalidateWorkerPoolCountsQuery 被调', async () => {
    // 2026-09-30：mutation onSuccess 失效链 —— invalidateWorkerPoolByProcessQuery(qc, processId)
    // + invalidateWorkerPoolCountsQuery(qc)。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000001',
    );
    expect(ok).toBe(true);
    expect(realAssignWorkerPool).toHaveBeenCalledTimes(1);
    expect(realAssignWorkerPool).toHaveBeenCalledWith({
      worker_id: '1900000000002',
      batch_id: '3000000000001',
      shelf_id: '5000000000001',
      process_id: '2000000000001',
    });
    // 失效链：invalidateWorkerPoolByProcessQuery（调 1 次 invalidateQueries）+ invalidateWorkerPoolCountsQuery（同 1 次）
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(testQueryClient.invalidateQueries).mock.calls;
    const first = calls[0]?.[0] as { queryKey: readonly unknown[] };
    expect(first.queryKey).toEqual(['worker-pool', 'by-process', '2000000000001']);
    const second = calls[1]?.[0] as { queryKey: readonly unknown[] };
    expect(second.queryKey).toEqual(['worker-pool', 'counts']);
  });

  it('T4：moveBatchToWorker 失败 → 返回 false + error.value 写入 + ElMessage.error', async () => {
    // 2026-09-30：mutation onError 路径 —— 写 error.value + ElMessage.error，
    // moveBatchToWorker 包 try/catch 返回 false（保持原签名兼容 view 调用点）。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { ElMessage } = await import('element-plus');
    realAssignWorkerPool.mockRejectedValueOnce(
      new ApiError(20204, 'WORKER_CAPACITY_EXCEEDED'),
    );
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000001',
    );
    expect(ok).toBe(false);
    expect(q.error.value).toContain('WORKER_CAPACITY_EXCEEDED');
    expect(ElMessage.error).toHaveBeenCalledWith('WORKER_CAPACITY_EXCEEDED');
  });

  it('T5：moveBatchToPool 成功 → removeFromWorkerPool 被调 + 2 个 invalidate helpers 被调', async () => {
    // 2026-09-30：mutation onSuccess 失效链 —— 同 T3。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToPool(
      '3000000000001',
      '1900000000002',
      '5000000000001',
      '2000000000002',
    );
    expect(ok).toBe(true);
    expect(realRemoveFromWorkerPool).toHaveBeenCalledTimes(1);
    expect(realRemoveFromWorkerPool).toHaveBeenCalledWith({
      worker_id: '1900000000002',
      batch_id: '3000000000001',
      shelf_id: '5000000000001',
      next_process_id: '2000000000002',
    });
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(testQueryClient.invalidateQueries).mock.calls;
    const first = calls[0]?.[0] as { queryKey: readonly unknown[] };
    expect(first.queryKey).toEqual(['worker-pool', 'by-process', '2000000000002']);
  });

  it('T6：runAutoAllocate 成功 → autoAllocate 被调 + 2 个 invalidate helpers 被调', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    await q.runAutoAllocate({
      process_id: '2000000000001',
      shelf_id: '5000000000001',
      mode: 'COUNT',
      fill_ratio: 0.5,
    });
    expect(realAutoAllocate).toHaveBeenCalledTimes(1);
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(testQueryClient.invalidateQueries).mock.calls;
    const first = calls[0]?.[0] as { queryKey: readonly unknown[] };
    expect(first.queryKey).toEqual(['worker-pool', 'by-process', '2000000000001']);
    const second = calls[1]?.[0] as { queryKey: readonly unknown[] };
    expect(second.queryKey).toEqual(['worker-pool', 'counts']);
  });

  it('T7：runAutoAllocate 失败 → onError 路径 error.value 写入', async () => {
    // 2026-09-30：mutation 失败 onError 路径 —— error.value + ElMessage.error。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    realAutoAllocate.mockRejectedValueOnce(
      new ApiError(20704, 'BIZ_AUTO_ALLOCATE_INVALID_RATIO'),
    );
    const q = testApp.runWithContext(() => useWorkerQueue());
    await expect(
      q.runAutoAllocate({
        process_id: '2000000000001',
        shelf_id: '5000000000001',
        mode: 'COUNT',
        fill_ratio: 1.5,
      }),
    ).rejects.toThrow();
    expect(q.error.value).toContain('BIZ_AUTO_ALLOCATE_INVALID_RATIO');
  });
});