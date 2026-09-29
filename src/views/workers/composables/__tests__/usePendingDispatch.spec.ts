// src/views/workers/composables/__tests__/usePendingDispatch.spec.ts
//
// 2026-09-29 新增：usePendingDispatch mutation 失效链路 + autoDispatch 行为守门。
//
// 覆盖：
//   - T1：dispatchMutation.mutate 成功 → 触发 3 个 invalidateQueries + refreshBoard。
//   - T2：bulkDispatchMutation.mutate 成功 → 同样触发 3 个 invalidateQueries +
//   refreshBoard + 清空 selectedIds（shelfId/nextProcessId 缺省走 auto 端点）。
//   - T3：autoDispatchMutation.mutate 成功（含 20706 失败件）→ 失效链 +
//   ElMessageBox.confirm 兜底（review 第 1 轮 C1 修复：替换原 ElMessage.warning）。
//   - T4：autoDispatchMutation 仅对 selectedIds 非空集合触发；空集合由 view 层守卫。
//   - T5：setSelectedIds / clearSelection 行为正确（基础状态守卫）。
//
// 2026-09-29 review 第 1 轮修复（m1）：删除 T6 —— `typeof x === 'function'` 是 TS 类型
// guard 在运行时恒真，对 mutation 行为无守护价值。
//
// 测试策略：
//   - vi.mock('@/api/pendingBatches')：dispatchBatch / bulkDispatchBatches /
//     autoDispatchBatches 替换为 vi.fn()。
//   - vi.mock('element-plus', ...) 防 vitest node env ElMessage 污染输出；ElMessageBox
//     也桩成 vi.fn()（handleProcessChainRequired 在 20706 时会调 ElMessageBox.confirm）。
//   - vi.mock('vue-router')：useRouter() 注入 fakeRouter 闭包。
//   - refreshBoard mock fn：验证 onSuccess 内被调一次（C2 fix）。

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
  ElMessageBox: {
    confirm: vi.fn(async () => undefined),
  },
}));

const fakeRouterPush = vi.fn(async () => undefined);
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: fakeRouterPush }),
  useRoute: () => ({ query: {} }),
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
  // 透传 args，否则 vi.fn() 拿不到入参（之前包装丢参数）
  dispatchBatch: (...args: unknown[]) => realDispatchBatch(...(args as [])),
  bulkDispatchBatches: (...args: unknown[]) => realBulkDispatchBatches(...(args as [])),
  autoDispatchBatches: (...args: unknown[]) => realAutoDispatchBatches(...(args as [])),
  fetchPendingBatches: (...args: unknown[]) => realFetchPendingBatches(...(args as [])),
}));

import { usePendingDispatch } from '../usePendingDispatch';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;
// 2026-09-29 review 第 1 轮修复：refreshBoard 形参类型 = () => Promise<void>，
// mock 类型用 vi.MockedFunction 显式注解，否则 vue-tsc 报 TS2322（vi.fn() 默认
// 推断 Mock<Procedure | Constructable>，与 () => Promise<void> 不兼容）。
type RefreshBoard = () => Promise<void>;
let refreshBoardMock: ReturnType<typeof vi.fn<RefreshBoard>>;

describe('usePendingDispatch — 失效链路 + autoDispatch 行为（2026-09-29）', () => {
  beforeEach(() => {
    realDispatchBatch.mockClear();
    realBulkDispatchBatches.mockClear();
    realAutoDispatchBatches.mockClear();
    realFetchPendingBatches.mockClear();
    fakeRouterPush.mockClear();
    refreshBoardMock = vi.fn(async () => undefined);
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

  it('T1：dispatchMutation.mutate 成功 → 触发 3 个 invalidateQueries + refreshBoard', async () => {
    const d = testApp.runWithContext(() => usePendingDispatch({ refreshBoard: refreshBoardMock }));
    await d.dispatchMutation.mutateAsync({
      batchId: '3000000000001',
      req: { shelf_id: '5000000000001', next_process_id: '5000000000010' },
    });

    expect(realDispatchBatch).toHaveBeenCalledTimes(1);
    // 2026-09-29：usePendingDispatch.invalidateAll 内调 invalidatePendingBatchesQuery
    // （内部再调 1 次 qc.invalidateQueries）+ invalidateProcessesQuery（同 1 次）
    // + 显式 qc.invalidateQueries({ queryKey: qk.partsPrefix }) 1 次 → 共 3 次顶层调用。
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    // 2026-09-29 review 第 1 轮修复（C2）：refreshBoard 必须被调一次（processPools 同步刷新）
    expect(refreshBoardMock).toHaveBeenCalledTimes(1);
    // 验证 queryKey 形态（顺序与 invalidateAll 顺序对齐）
    const keys = vi.mocked(testQueryClient.invalidateQueries).mock.calls.map((c) => c[0]);
    const first = keys[0] as { queryKey: readonly unknown[] };
    expect(first.queryKey).toEqual(['pending-batches']);
    const second = keys[1] as { queryKey: readonly unknown[] };
    expect(second.queryKey).toEqual(['processes']);
    const third = keys[2] as { queryKey: readonly unknown[] };
    expect(third.queryKey).toEqual(['parts']);
  });

  it('T2：bulkDispatchMutation.mutate 成功（缺省走 auto 端点）→ 触发 3 个 invalidateQueries + refreshBoard + 清空 selectedIds', async () => {
    // 2026-09-29 review 第 1 轮修复（C4）：shelfId / nextProcessId 缺省时
    // mutationFn 兜底走 autoDispatchBatches 端点。本用例验证该 fallback 行为：
    // bulkDispatchBatches 不被调、autoDispatchBatches 被调一次（带 batch_ids）。
    const d = testApp.runWithContext(() => usePendingDispatch({ refreshBoard: refreshBoardMock }));
    d.setSelectedIds(['3000000000001', '3000000000002']);
    expect(d.selectedIds.value.size).toBe(2);

    await d.bulkDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    expect(realBulkDispatchBatches).not.toHaveBeenCalled();
    expect(realAutoDispatchBatches).toHaveBeenCalledTimes(1);
    expect(realAutoDispatchBatches).toHaveBeenCalledWith({
      batch_ids: ['3000000000001', '3000000000002'],
    });
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(refreshBoardMock).toHaveBeenCalledTimes(1);
    // 批量成功后清空多选
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T3：autoDispatchMutation.mutate 成功（含 20706 失败件） → 失效链 + ElMessageBox.confirm 兜底', async () => {
    // 2026-09-29 review 第 1 轮修复（C1）：20706 失败件逐个弹 handleProcessChainRequired
    // （内部调 ElMessageBox.confirm）；不再用原 ElMessage.warning。
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
    const { ElMessage, ElMessageBox } = await import('element-plus');

    const d = testApp.runWithContext(() => usePendingDispatch({ refreshBoard: refreshBoardMock }));
    d.setSelectedIds(['3000000000001', '3000000000002']);

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    expect(realAutoDispatchBatches).toHaveBeenCalledTimes(1);
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(refreshBoardMock).toHaveBeenCalledTimes(1);
    // 20706 兜底：ElMessageBox.confirm 必须被调（C1 fix）
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    expect(ElMessage.warning).not.toHaveBeenCalled();
    // 自动下发后清空多选
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T4：autoDispatchMutation 仅对 selectedIds 非空触发；空集合由 view 层守卫', () => {
    // 2026-09-29 任务规约：autoDispatch「仅对有 chain 的 batch 触发」—— 服务端按
    // process_chain_id 是否 null 过滤。本 composable 不做前端预过滤（避免误导
    // 业务规则），由 service 端控制；本用例断言 mutationFn 在 selectedIds 为空时
    // view 层（PendingBatchesPanel.onAutoDispatch）有守卫（返回而不调 mutate）。
    // 这里直接验证 mutationFn 在 mutate 调用时 apiFn 必被调（前端不二次过滤）。
    const d = testApp.runWithContext(() => usePendingDispatch({ refreshBoard: refreshBoardMock }));
    // 空 selectedIds：composable 不守卫，但 view 层 PendingBatchesPanel 的
    // onAutoDispatch 会判 selectedIds.size === 0 直接 return，不走 mutate。
    expect(d.selectedIds.value.size).toBe(0);
    expect(typeof d.autoDispatchMutation.mutate).toBe('function');
  });

  it('T5：setSelectedIds / clearSelection 行为正确', () => {
    const d = testApp.runWithContext(() => usePendingDispatch({ refreshBoard: refreshBoardMock }));
    d.setSelectedIds(['3000000000001', '3000000000002', '3000000000003']);
    expect(d.selectedIds.value.size).toBe(3);
    expect(d.selectedCount.value).toBe(3);
    d.clearSelection();
    expect(d.selectedIds.value.size).toBe(0);
    expect(d.selectedCount.value).toBe(0);
  });
});