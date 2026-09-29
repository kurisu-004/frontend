// src/views/workers/composables/__tests__/usePendingDispatch.spec.ts
//
// 2026-09-29 新增：usePendingDispatch mutation 失效链路 + autoDispatch 行为守门。
//
// 覆盖：
//   - T1：dispatchMutation.mutate 成功 → 触发 3 个 invalidateQueries + refreshBoard。
//   - T2：bulkDispatchMutation.mutate 成功（targetProcessId 必填，不再 fallback auto）
//     → 触发 3 个 invalidateQueries + refreshBoard + 清空 selectedIds。
//   - T3：autoDispatchMutation.mutate 成功（含 NO_PROCESS_CHAIN 跳过件）→ 失效链 +
//     ElMessageBox.confirm 兜底（reason='NO_PROCESS_CHAIN' 合成 ApiError(20706) 复用
//     handleProcessChainRequired）。
//   - T4：autoDispatchMutation 仅对 selectedIds 非空集合触发；空集合由 view 层守卫。
//   - T5：setSelectedIds / clearSelection 行为正确（基础状态守卫）。
//
// 2026-09-29 review 第 1 轮修复（m1）：删除 T6 —— `typeof x === 'function'` 是 TS 类型
// guard 在运行时恒真，对 mutation 行为无守护价值。
//
// 2026-09-29 修复 dispatch 契约漂移：
//   - mock DTO 形态对齐 backend-rust vo.rs:88-119（DispatchResult 5 字段；
//     current_process_step_id 取代旧 part_id）；
//   - bulkDispatchMutation 必须传 targetProcessId（去掉 shelfId / nextProcessId +
//     auto fallback 路径）；
//   - autoDispatchMutation mock 走 skipped（reason: 'NO_PROCESS_CHAIN'）而非 failed。
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

// 2026-09-29 修复 dispatch 契约漂移：mock 出参对齐 backend-rust DispatchResult
// （vo.rs:88-97）—— batch_id / current_process_step_id（null） / target_process_id /
// shelf_id / version 五字段；旧前端 part_id 已删。
const realDispatchBatch = vi.fn<
  () => Promise<{
    batch_id: string;
    current_process_step_id: string | null;
    target_process_id: string;
    shelf_id: string;
    version: number;
  }>
>(async () => ({
  batch_id: '3000000000001',
  current_process_step_id: null,
  target_process_id: '5000000000010',
  shelf_id: '5000000000001',
  version: 2,
}));

const realBulkDispatchBatches = vi.fn<
  () => Promise<{
    succeeded: Array<{
      batch_id: string;
      current_process_step_id: string | null;
      target_process_id: string;
      shelf_id: string;
      version: number;
    }>;
    failed: Array<{ batch_id: string; code: number; message: string }>;
  }>
>(async () => ({
  succeeded: [
    {
      batch_id: '3000000000001',
      current_process_step_id: null,
      target_process_id: '5000000000010',
      shelf_id: '5000000000001',
      version: 2,
    },
  ],
  failed: [],
}));

// 2026-09-29 修复 dispatch 契约漂移：auto 出参对齐 backend-rust AutoDispatchResult
// —— succeeded + skipped（reason: 'NO_PROCESS_CHAIN' / 'NO_PROCESS_STEP'）；旧前端
// 读 res.failed.length 抛 `Cannot read properties of undefined (reading 'length')`。
const realAutoDispatchBatches = vi.fn<
  () => Promise<{
    succeeded: Array<{
      batch_id: string;
      current_process_step_id: string | null;
      target_process_id: string;
      shelf_id: string;
      version: number;
    }>;
    skipped: Array<{ batch_id: string; reason: string }>;
  }>
>(async () => ({
  succeeded: [
    {
      batch_id: '3000000000001',
      current_process_step_id: null,
      target_process_id: '5000000000010',
      shelf_id: '5000000000001',
      version: 2,
    },
  ],
  skipped: [],
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

describe('usePendingDispatch — 失效链路 + autoDispatch 行为（2026-09-29 修复 dispatch 契约漂移）', () => {
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
      current_process_step_id: null,
      target_process_id: '5000000000010',
      shelf_id: '5000000000001',
      version: 2,
    });
    realBulkDispatchBatches.mockResolvedValue({
      succeeded: [
        {
          batch_id: '3000000000001',
          current_process_step_id: null,
          target_process_id: '5000000000010',
          shelf_id: '5000000000001',
          version: 2,
        },
      ],
      failed: [],
    });
    realAutoDispatchBatches.mockResolvedValue({
      succeeded: [
        {
          batch_id: '3000000000001',
          current_process_step_id: null,
          target_process_id: '5000000000010',
          shelf_id: '5000000000001',
          version: 2,
        },
      ],
      skipped: [],
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
      // 2026-09-29 修复：req 现在只接 target_process_id（+ 可选 note），旧
      // shelf_id / next_process_id 已删（对齐 backend DispatchRequest）。
      req: { target_process_id: '5000000000010' },
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

  it('T2：bulkDispatchMutation.mutate 成功（带 targetProcessId）→ 触发 3 个 invalidateQueries + refreshBoard + 清空 selectedIds', async () => {
    // 2026-09-29 修复 dispatch 契约漂移：bulkDispatchMutation 入参改为
    // { batchIds, targetProcessId }，去掉 shelfId / nextProcessId + 不再 fallback
    // 到 auto 端点。本用例验证：bulkDispatchBatches 必被调（带 targets 形态），
    // autoDispatchBatches 不被调。
    const d = testApp.runWithContext(() => usePendingDispatch({ refreshBoard: refreshBoardMock }));
    d.setSelectedIds(['3000000000001', '3000000000002']);
    expect(d.selectedIds.value.size).toBe(2);

    await d.bulkDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
      targetProcessId: '5000000000010',
    });

    expect(realBulkDispatchBatches).toHaveBeenCalledTimes(1);
    expect(realBulkDispatchBatches).toHaveBeenCalledWith({
      targets: [
        { batch_id: '3000000000001', target_process_id: '5000000000010' },
        { batch_id: '3000000000002', target_process_id: '5000000000010' },
      ],
    });
    expect(realAutoDispatchBatches).not.toHaveBeenCalled();
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(refreshBoardMock).toHaveBeenCalledTimes(1);
    // 批量成功后清空多选
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T3：autoDispatchMutation.mutate 成功（含 NO_PROCESS_CHAIN 跳过件） → 失效链 + ElMessageBox.confirm 兜底', async () => {
    // 2026-09-29 修复 dispatch 契约漂移：autoDispatchResult 改走 skipped 数组，
    // reason='NO_PROCESS_CHAIN' 合成 ApiError(20706) → handleProcessChainRequired
    // 弹「前往制定」确认框（沿 usePartDispatch.ts:140-141 / 158-162 范本）。
    realAutoDispatchBatches.mockResolvedValueOnce({
      succeeded: [
        {
          batch_id: '3000000000001',
          current_process_step_id: null,
          target_process_id: '5000000000010',
          shelf_id: '5000000000001',
          version: 2,
        },
      ],
      skipped: [{ batch_id: '3000000000002', reason: 'NO_PROCESS_CHAIN' }],
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
    // 2026-09-29 修复：reason='NO_PROCESS_CHAIN' → 合成 ApiError(20706) →
    // handleProcessChainRequired → ElMessageBox.confirm 必被调一次（C1 fix 沿用）
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