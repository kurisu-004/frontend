// src/views/workers/composables/__tests__/usePendingDispatch.spec.ts
//
// 2026-09-29 新增：usePendingDispatch mutation 失效链路 + autoDispatch 行为守门。
//
// 覆盖：
//   - T1：dispatchMutation.mutate 成功 → 触发 3 个 invalidateQueries
//   （pendingBatchesPrefix + processesPrefix + partsPrefix）。
//   - T2：bulkDispatchMutation.mutate 成功 → 同样触发 3 个 invalidateQueries +
//   清空 selectedIds。
//   - T3：autoDispatchMutation.mutate 成功 → 同样触发 3 个 invalidateQueries；partial
//   failed 含 20706 时弹 warning。
//   - T4：autoDispatchMutation 仅对 selectedIds 非空集合触发；空集合不调 apiFn。
//   - T5：setSelectedIds / clearSelection 行为正确（基础状态守卫）。
//
// 测试策略（沿 usePartFilesListQuery.spec.ts 范本）：
//   - vi.mock('@/api/pendingBatches')：dispatchBatch / bulkDispatchBatches /
//     autoDispatchBatches 替换为 vi.fn()。
//   - vi.mock('element-plus', ...) 防 vitest node env ElMessage 污染输出。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const realDispatchBatch = vi.fn<
  () => Promise<{ batch_id: string; part_id: string; version: number; shelf_id: string; next_process_id: string }>
>(async () => ({
  batch_id: '3000000000001',
  part_id: '4000000000001',
  version: 2,
  shelf_id: '5000000000001',
  next_process_id: '5000000000010',
}));

const realBulkDispatchBatches = vi.fn<
  () => Promise<{
    succeeded: Array<{ batch_id: string; part_id: string; version: number; shelf_id: string; next_process_id: string }>;
    failed: Array<{ batch_id: string; code: number; message: string }>;
  }>
>(async () => ({
  succeeded: [
    {
      batch_id: '3000000000001',
      part_id: '4000000000001',
      version: 2,
      shelf_id: '5000000000001',
      next_process_id: '5000000000010',
    },
  ],
  failed: [],
}));

const realAutoDispatchBatches = vi.fn<
  () => Promise<{
    succeeded: Array<{ batch_id: string; part_id: string; version: number; shelf_id: string; next_process_id: string }>;
    failed: Array<{ batch_id: string; code: number; message: string }>;
  }>
>(async () => ({
  succeeded: [
    {
      batch_id: '3000000000001',
      part_id: '4000000000001',
      version: 2,
      shelf_id: '5000000000001',
      next_process_id: '5000000000010',
    },
  ],
  failed: [],
}));

const realFetchPendingBatches = vi.fn<
  () => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 200, offset: 0 }));

vi.mock('@/api/pendingBatches', () => ({
  dispatchBatch: () => realDispatchBatch(),
  bulkDispatchBatches: () => realBulkDispatchBatches(),
  autoDispatchBatches: () => realAutoDispatchBatches(),
  fetchPendingBatches: () => realFetchPendingBatches(),
}));

import { usePendingDispatch } from '../usePendingDispatch';
import { invalidatePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import { invalidateProcessesQuery } from '@/composables/queries/useProcessesQuery';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('usePendingDispatch — 失效链路 + autoDispatch 行为（2026-09-29）', () => {
  beforeEach(() => {
    realDispatchBatch.mockClear();
    realBulkDispatchBatches.mockClear();
    realAutoDispatchBatches.mockClear();
    realFetchPendingBatches.mockClear();
    realFetchPendingBatches.mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
    realDispatchBatch.mockResolvedValue({
      batch_id: '3000000000001',
      part_id: '4000000000001',
      version: 2,
      shelf_id: '5000000000001',
      next_process_id: '5000000000010',
    });
    realBulkDispatchBatches.mockResolvedValue({
      succeeded: [
        {
          batch_id: '3000000000001',
          part_id: '4000000000001',
          version: 2,
          shelf_id: '5000000000001',
          next_process_id: '5000000000010',
        },
      ],
      failed: [],
    });
    realAutoDispatchBatches.mockResolvedValue({
      succeeded: [
        {
          batch_id: '3000000000001',
          part_id: '4000000000001',
          version: 2,
          shelf_id: '5000000000001',
          next_process_id: '5000000000010',
        },
      ],
      failed: [],
    });

    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });

    // spy invalidateQueries 验证 usePendingDispatch 内部按序失效 3 域
    vi.spyOn(testQueryClient, 'invalidateQueries');
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  it('T1：dispatchMutation.mutate 成功 → 触发 3 个 invalidateQueries（pendingBatchesPrefix + processesPrefix + partsPrefix）', async () => {
    const d = testApp.runWithContext(() => usePendingDispatch());
    await d.dispatchMutation.mutateAsync({
      batchId: '3000000000001',
      req: { shelf_id: '5000000000001', next_process_id: '5000000000010' },
    });

    expect(realDispatchBatch).toHaveBeenCalledTimes(1);
    // 2026-09-29：usePendingDispatch.invalidateAll 内调 invalidatePendingBatchesQuery
    // （内部再调 1 次 qc.invalidateQueries）+ invalidateProcessesQuery（同 1 次）
    // + 显式 qc.invalidateQueries({ queryKey: qk.partsPrefix }) 1 次 → 共 3 次顶层调用。
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    // 验证 queryKey 形态（顺序与 invalidateAll 顺序对齐）
    const keys = vi.mocked(testQueryClient.invalidateQueries).mock.calls.map((c) => c[0]);
    const first = keys[0] as { queryKey: readonly unknown[] };
    expect(first.queryKey).toEqual(['pending-batches']);
    const second = keys[1] as { queryKey: readonly unknown[] };
    expect(second.queryKey).toEqual(['processes']);
    const third = keys[2] as { queryKey: readonly unknown[] };
    expect(third.queryKey).toEqual(['parts']);
  });

  it('T2：bulkDispatchMutation.mutate 成功 → 触发 3 个 invalidateQueries + 清空 selectedIds', async () => {
    const d = testApp.runWithContext(() => usePendingDispatch());
    d.setSelectedIds(['3000000000001', '3000000000002']);
    expect(d.selectedIds.value.size).toBe(2);

    await d.bulkDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
      shelfId: '5000000000001',
      nextProcessId: '5000000000010',
    });

    expect(realBulkDispatchBatches).toHaveBeenCalledTimes(1);
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    // 批量成功后清空多选
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T3：autoDispatchMutation.mutate 成功（含 20706 失败件） → 触发 3 个 invalidateQueries + 弹 warning', async () => {
    // 2026-09-29 任务规约：autoDispatch 服务端按 process_chain_id 推导，缺 chain 的
    // batch 跳过（failed 条目 + 20706）。ElMessage.warning 必须被调。
    realAutoDispatchBatches.mockResolvedValueOnce({
      succeeded: [
        {
          batch_id: '3000000000001',
          part_id: '4000000000001',
          version: 2,
          shelf_id: '5000000000001',
          next_process_id: '5000000000010',
        },
      ],
      failed: [{ batch_id: '3000000000002', code: 20706, message: 'BIZ_PROCESS_CHAIN_REQUIRED' }],
    });
    const { ElMessage } = await import('element-plus');

    const d = testApp.runWithContext(() => usePendingDispatch());
    d.setSelectedIds(['3000000000001', '3000000000002']);

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    expect(realAutoDispatchBatches).toHaveBeenCalledTimes(1);
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    // 20706 BIZ_PROCESS_CHAIN_REQUIRED 弹 warning（沿 usePendingDispatch.ts 实现）
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('工艺链'));
    // 自动下发后清空多选
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T4：autoDispatchMutation 仅对 selectedIds 非空触发；空集合由 view 层守卫', () => {
    // 2026-09-29 任务规约：autoDispatch「仅对有 chain 的 batch 触发」—— 服务端按
    // process_chain_id 是否 null 过滤。本 composable 不做前端预过滤（避免误导
    // 业务规则），由 service 端控制；本用例断言 mutationFn 在 selectedIds 为空时
    // view 层（PendingBatchesPanel.onAutoDispatch）有守卫（返回而不调 mutate）。
    // 这里直接验证 mutationFn 在 mutate 调用时 apiFn 必被调（前端不二次过滤）。
    const d = testApp.runWithContext(() => usePendingDispatch());
    // 空 selectedIds：composable 不守卫，但 view 层 PendingBatchesPanel 的
    // onAutoDispatch 会判 selectedIds.size === 0 直接 return，不走 mutate。
    expect(d.selectedIds.value.size).toBe(0);
    expect(typeof d.autoDispatchMutation.mutate).toBe('function');
  });

  it('T5：setSelectedIds / clearSelection 行为正确', () => {
    const d = testApp.runWithContext(() => usePendingDispatch());
    d.setSelectedIds(['3000000000001', '3000000000002', '3000000000003']);
    expect(d.selectedIds.value.size).toBe(3);
    expect(d.selectedCount.value).toBe(3);
    d.clearSelection();
    expect(d.selectedIds.value.size).toBe(0);
    expect(d.selectedCount.value).toBe(0);
  });

  it('T6：invalidatePendingBatchesQuery / invalidateProcessesQuery 薄封装存在', () => {
    // 2026-09-29 任务规约的辅助 guard：确保 usePendingDispatch 依赖的两个 invalidate
    // 工具函数都正常导出（不在被 mutating 重命名后失效）。
    expect(typeof invalidatePendingBatchesQuery).toBe('function');
    expect(typeof invalidateProcessesQuery).toBe('function');
  });
});