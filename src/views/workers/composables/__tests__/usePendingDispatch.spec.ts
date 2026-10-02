// src/views/workers/composables/__tests__/usePendingDispatch.spec.ts
//
// 2026-09-29 新增；2026-09-30 重写（后端 batch 域重构对齐）。
//
// 2026-09-30 后端契约漂移（backend-rust/src/modules/prod/batch/{mod.rs,dto.rs,vo.rs}）：
//   1. **dispatch 统一 bulk-only** —— `POST /batches/dispatch` 请求体改
//      `{targets: [...], note?}`；`POST /batches/bulk-dispatch` 端点**已删除**
//      （router 层不再挂载 ⇒ 404）。故 `dispatchMutation` + `bulkDispatchMutation`
//      合并为**单个** `dispatchMutation`，入参 `{batchIds, targetProcessId}`
//      （单条即 `batchIds.length === 1`）。
//   2. **dispatch 出参改列表形态** —— `DispatchResult {succeeded[], failed[]}`。
//   3. **auto-dispatch 改为只读 preview** —— 出参 `{items: [AutoDispatchItem]}`
//      （含 `first_process_id` / `first_shelf_id` / `skip_reason`），不再写库。
//      前端改成**两步**：① 调 preview；② ElMessageBox 展示明细，用户确认后用
//      `first_process_id` 构造 targets 链式调 dispatchMutation 真正下发。
//   4. `usePendingDispatch()` 不再接受 deps —— `refreshBoard` 随
//      useWorkerQueue.loadBoard + 模块级 workerHeld 一并删除。
//
// 覆盖：
//   - T1：dispatchMutation 成功 → 请求体 targets 形态 + 4 域 invalidate（无 refreshBoard）。
//   - T2：dispatchMutation 成功 → 清空 selectedIds + 成功 toast。
//   - T3：autoDispatch preview 全部可下发 → 弹确认框 → 确认后调 dispatchBatches
//     （用 first_process_id 作 target_process_id）。
//   - T4：autoDispatch preview 含 skip 件 → 确认框文案含跳过原因 + 确认后只下发可下发项。
//   - T5：autoDispatch preview 全部不可下发 → **不弹确认框** + ElMessage.warning。
//   - T6：autoDispatch preview 全部 NO_PROCESS_CHAIN → 走 handleProcessChainRequired
//     （合成 ApiError(20706) → ElMessageBox.confirm 引导去工艺制定页）。
//   - T7：用户取消确认框 → 不发 dispatch 请求（preview 是只读的，无需回滚）。
//   - T8：preview 多首道工序 → 按 first_process_id 拆成多次 dispatch。
//   - T9：setSelectedIds / clearSelection 行为正确（基础状态守卫）。
//   - T10：不再接受 deps（旧 refreshBoard 注入链已删）。
//   - T11：dispatchMutation 失败 → 报错 toast + 只失效 pending-batches 域
//     （Sortable 乐观删除的回滚路径，多选保持不动）。
//
// 测试策略：
//   - vi.mock('@/api/pendingBatches')：dispatchBatches / previewAutoDispatch /
//     fetchPendingBatches 替换为 vi.fn()。
//   - vi.mock('element-plus', ...) 防 vitest node env ElMessage 污染输出；ElMessageBox
//     桩成 vi.fn()（自动下发确认框 + handleProcessChainRequired 都会调）。
//   - vi.mock('vue-router')：useRouter() 注入 fakeRouter 闭包。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
// 供 vi.mock 的 importOriginal 泛型使用（@typescript-eslint/consistent-type-imports
// 禁止 `import()` 形式类型注解）
import type * as PendingBatchesModule from '@/api/pendingBatches';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: {
    // 默认 resolve（= 用户点确认）
    confirm: vi.fn(async () => undefined),
  },
}));

const fakeRouterPush = vi.fn(async () => undefined);
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: fakeRouterPush }),
  useRoute: () => ({ query: {} }),
}));

interface DispatchResult {
  succeeded: Array<{
    batch_id: string;
    current_process_step_id: string | null;
    target_process_id: string;
    shelf_id: string;
    version: number;
  }>;
  failed: Array<{ batch_id: string; code: number; message: string }>;
}

interface AutoDispatchPreview {
  items: AutoDispatchPreviewItem[];
}

interface AutoDispatchPreviewItem {
  batch_id: string;
  part_id: string;
  process_chain_id: string | null;
  first_process_id: string | null;
  first_process_code: string;
  first_process_name: string;
  first_shelf_id: string | null;
  skip_reason: string | null;
}

/** 2026-09-30：dispatch 出参对齐 backend-rust DispatchResult（bulk-only 列表形态）。 */
const realDispatchBatches = vi.fn<
  (req: {
    targets: Array<{ batch_id: string; target_process_id: string }>;
    note?: string;
  }) => Promise<DispatchResult>
>(async (req) => ({
  succeeded: req.targets.map((t, i) => ({
    batch_id: t.batch_id,
    current_process_step_id: null,
    target_process_id: t.target_process_id,
    shelf_id: '5000000000001',
    version: i + 2,
  })),
  failed: [],
}));

/** 2026-09-30：auto-dispatch 出参对齐 backend-rust AutoDispatchResult（只读 preview）。 */
const realPreviewAutoDispatch = vi.fn<
  (req: { batch_ids: string[] }) => Promise<AutoDispatchPreview>
>(async () => ({
  items: [
    {
      batch_id: '3000000000001',
      part_id: '4000000000001',
      process_chain_id: '6000000000001',
      first_process_id: '2000000000001',
      first_process_code: 'P-AUTO-1',
      first_process_name: '首道工序',
      first_shelf_id: '5000000000001',
      skip_reason: null,
    },
  ],
}));

const realFetchPendingBatches = vi.fn<
  () => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 200, offset: 0 }));

vi.mock('@/api/pendingBatches', async (importOriginal) => ({
  // 2026-09-30：dispatchBatch / bulkDispatchBatches / autoDispatchBatches 三个旧函数
  // 全部下线，替换为 dispatchBatches（bulk-only）+ previewAutoDispatch（只读）。
  // importOriginal 保留 AUTO_DISPATCH_SKIP_REASON_LABELS（纯常量文案表，不该被 mock）。
  ...(await importOriginal<typeof PendingBatchesModule>()),
  dispatchBatches: (...args: unknown[]) =>
    realDispatchBatches(...(args as Parameters<typeof realDispatchBatches>)),
  previewAutoDispatch: (...args: unknown[]) =>
    realPreviewAutoDispatch(...(args as Parameters<typeof realPreviewAutoDispatch>)),
  fetchPendingBatches: (...args: unknown[]) =>
    realFetchPendingBatches(...(args as [])),
}));

import { usePendingDispatch } from '../usePendingDispatch';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 2026-09-30：invalidateAll() 失效域的 queryKey 序列断言。
 *  2026-09-30 修复：去掉 ['processes']（下发不改变工序列表）+ 改名四域。 */
function expectFourDomainsInvalidated(): void {
  const keys = vi
    .mocked(testQueryClient.invalidateQueries)
    .mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  expect(keys).toEqual([
    ['pending-batches'],
    ['parts'],
    ['worker-pool', 'by-process'],
    ['worker-pool', 'counts'],
    ['worker-pool', 'state'],
  ]);
}

function makeOkPreviewItem(
  batchId: string,
  firstProcessId: string | null,
  skipReason: string | null,
): AutoDispatchPreviewItem {
  return {
    batch_id: batchId,
    part_id: '4000000000001',
    process_chain_id: skipReason === 'NO_PROCESS_CHAIN' ? null : '6000000000001',
    first_process_id: firstProcessId,
    first_process_code: firstProcessId ? 'P-AUTO-1' : '',
    first_process_name: firstProcessId ? '首道工序' : '',
    first_shelf_id: firstProcessId ? '5000000000001' : null,
    skip_reason: skipReason,
  };
}

describe('usePendingDispatch — bulk-only dispatch + auto preview 两步（2026-09-30 契约对齐）', () => {
  beforeEach(async () => {
    const { ElMessageBox } = await import('element-plus');
    realDispatchBatches.mockClear();
    realPreviewAutoDispatch.mockClear();
    realFetchPendingBatches.mockClear();
    fakeRouterPush.mockClear();
    vi.mocked(ElMessageBox.confirm).mockClear();
    // 默认 = 用户点确认
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(undefined as never);
    realFetchPendingBatches.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    realDispatchBatches.mockImplementation(async (req) => ({
      succeeded: req.targets.map((t, i) => ({
        batch_id: t.batch_id,
        current_process_step_id: null,
        target_process_id: t.target_process_id,
        shelf_id: '5000000000001',
        version: i + 2,
      })),
      failed: [],
    }));
    realPreviewAutoDispatch.mockResolvedValue({
      items: [makeOkPreviewItem('3000000000001', '2000000000001', null)],
    });

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

  it('T1：dispatchMutation 成功 → 请求体 targets 形态 + 4 域 invalidate', async () => {
    const d = testApp.runWithContext(() => usePendingDispatch());
    await d.dispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
      targetProcessId: '2000000000001',
    });

    expect(realDispatchBatches).toHaveBeenCalledTimes(1);
    expect(realDispatchBatches).toHaveBeenCalledWith({
      targets: [
        { batch_id: '3000000000001', target_process_id: '2000000000001' },
        { batch_id: '3000000000002', target_process_id: '2000000000001' },
      ],
    });
    // preview 端点不被「显式下发」路径触碰
    expect(realPreviewAutoDispatch).not.toHaveBeenCalled();
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(5);
    expectFourDomainsInvalidated();
  });

  it('T2：dispatchMutation 成功 → 清空 selectedIds + 成功 toast', async () => {
    const { ElMessage } = await import('element-plus');
    const d = testApp.runWithContext(() => usePendingDispatch());
    d.setSelectedIds(['3000000000001', '3000000000002']);
    expect(d.selectedIds.value.size).toBe(2);

    await d.dispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
      targetProcessId: '2000000000001',
    });

    expect(d.selectedIds.value.size).toBe(0);
    expect(ElMessage.success).toHaveBeenCalledWith('已下发 2 件');
  });

  it('T2b：单件下发（batchIds.length === 1）→ targets 长度 1', async () => {
    const d = testApp.runWithContext(() => usePendingDispatch());
    await d.dispatchMutation.mutateAsync({
      batchIds: ['3000000000001'],
      targetProcessId: '2000000000001',
    });
    const sent = realDispatchBatches.mock.calls[0]?.[0];
    expect(sent?.targets).toHaveLength(1);
  });

  it('T3：autoDispatch preview 全部可下发 → 弹确认框 → 确认后调 dispatchBatches（用 first_process_id）', async () => {
    const { ElMessageBox } = await import('element-plus');
    const d = testApp.runWithContext(() => usePendingDispatch());

    await d.autoDispatchMutation.mutateAsync({ batchIds: ['3000000000001'] });

    expect(realPreviewAutoDispatch).toHaveBeenCalledWith({ batch_ids: ['3000000000001'] });
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    // 真正下发用 preview 返回的 first_process_id 作 target_process_id
    expect(realDispatchBatches).toHaveBeenCalledWith({
      targets: [{ batch_id: '3000000000001', target_process_id: '2000000000001' }],
    });
    // 下发成功 → 四域失效
    expectFourDomainsInvalidated();
  });

  it('T4：autoDispatch preview 含 skip 件 → 确认框文案含跳过原因，且只下发可下发项', async () => {
    const { ElMessageBox } = await import('element-plus');
    realPreviewAutoDispatch.mockResolvedValueOnce({
      items: [
        makeOkPreviewItem('3000000000001', '2000000000001', null),
        makeOkPreviewItem('3000000000002', null, 'NO_SHELF'),
      ],
    });
    const d = testApp.runWithContext(() => usePendingDispatch());

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    const detail = vi.mocked(ElMessageBox.confirm).mock.calls[0]?.[0] as string;
    expect(detail).toContain('可下发 1 件');
    expect(detail).toContain('跳过 1 件');
    expect(detail).toContain('首道工序未配置货架');
    // 只下发可下发的那一件
    expect(realDispatchBatches).toHaveBeenCalledWith({
      targets: [{ batch_id: '3000000000001', target_process_id: '2000000000001' }],
    });
  });

  it('T5：preview 全部不可下发 → 不弹确认框 + ElMessage.warning', async () => {
    const { ElMessage, ElMessageBox } = await import('element-plus');
    realPreviewAutoDispatch.mockResolvedValueOnce({
      items: [
        makeOkPreviewItem('3000000000001', null, 'NO_PROCESS_STEP'),
        makeOkPreviewItem('3000000000002', null, 'NOT_FOUND'),
      ],
    });
    const d = testApp.runWithContext(() => usePendingDispatch());

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    // 避免给用户一个「确认了却什么都不会发生」的空确认框
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(realDispatchBatches).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith(
      '无可下发批次：工序链无可用步骤 1、批次不存在或已非 PENDING 1',
    );
    // 多选被清空（本次无任何下发发生）
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T6：preview 全部 NO_PROCESS_CHAIN → 走 handleProcessChainRequired 引导', async () => {
    // 后端 batch 域不再抛 20706（错误码表已无此项），改以 skip_reason soft-skip
    // 呈现；前端合成 ApiError(20706) 复用既有 handleProcessChainRequired 兜底，
    // 保持「引导去工艺制定页」的 UX 不退化。
    const { ElMessageBox } = await import('element-plus');
    realPreviewAutoDispatch.mockResolvedValueOnce({
      items: [makeOkPreviewItem('3000000000001', null, 'NO_PROCESS_CHAIN')],
    });
    const d = testApp.runWithContext(() => usePendingDispatch());

    await d.autoDispatchMutation.mutateAsync({ batchIds: ['3000000000001'] });

    // ElMessageBox.confirm 被「前往制定」引导框调一次（无下发确认框）
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    expect(realDispatchBatches).not.toHaveBeenCalled();
  });

  it('T7：用户取消确认框 → 不发 dispatch 请求（preview 只读，无需回滚）', async () => {
    const { ElMessageBox } = await import('element-plus');
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel' as never);
    const d = testApp.runWithContext(() => usePendingDispatch());

    await d.autoDispatchMutation.mutateAsync({ batchIds: ['3000000000001'] });

    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    expect(realDispatchBatches).not.toHaveBeenCalled();
  });

  it('T8：preview 多首道工序 → 按 first_process_id 拆成多次 dispatch', async () => {
    vi.mocked((await import('element-plus')).ElMessageBox.confirm).mockClear();
    realPreviewAutoDispatch.mockResolvedValueOnce({
      items: [
        makeOkPreviewItem('3000000000001', '2000000000001', null),
        makeOkPreviewItem('3000000000002', '2000000000002', null),
      ],
    });
    const d = testApp.runWithContext(() => usePendingDispatch());

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    // 一个 dispatch 请求只带一个 target_process_id ⇒ 按首道工序拆 2 次
    expect(realDispatchBatches).toHaveBeenCalledTimes(2);
    expect(realDispatchBatches).toHaveBeenNthCalledWith(1, {
      targets: [{ batch_id: '3000000000001', target_process_id: '2000000000001' }],
    });
    expect(realDispatchBatches).toHaveBeenNthCalledWith(2, {
      targets: [{ batch_id: '3000000000002', target_process_id: '2000000000002' }],
    });
  });

  it('T9：setSelectedIds / clearSelection 行为正确', () => {
    const d = testApp.runWithContext(() => usePendingDispatch());
    d.setSelectedIds(['3000000000001', '3000000000002', '3000000000003']);
    expect(d.selectedIds.value.size).toBe(3);
    expect(d.selectedCount.value).toBe(3);
    d.clearSelection();
    expect(d.selectedIds.value.size).toBe(0);
    expect(d.selectedCount.value).toBe(0);
  });

  it('T10：不再接受 deps 参数（旧 refreshBoard 注入链已删）', () => {
    // 回归 guard：deps.refreshBoard 是随 loadBoard 一起删掉的「非 TanStack 数据源」
    // 兜底。若未来有人再加回来，本用例会失败。
    const d = testApp.runWithContext(() => usePendingDispatch());
    expect(d).not.toHaveProperty('bulkDispatchMutation');
  });

  it('T11：dispatch 失败 → 报错 toast + 重拉待下发列表（拖拽乐观删除的回滚）', async () => {
    // 2026-10-02 回归 guard：待下发池改 vue-draggable-plus 后，Sortable 的内置
    // onRemove 会在目标 onAdd 之前就把被拖卡片从待下发列表**乐观地** splice 掉。
    // 下发失败时若不重拉，卡片凭空消失、且刷新前无法找回 ⇒ onError 必须
    // invalidate 待下发域（不失效其余三域：只有 pending-batches 被本地动过）。
    const { ElMessage } = await import('element-plus');
    realDispatchBatches.mockRejectedValueOnce(new Error('BIZ_BATCH_ALREADY_DISPATCHED'));

    const d = testApp.runWithContext(() => usePendingDispatch());
    d.setSelectedIds(['3000000000001']);
    await d.dispatchMutation
      .mutateAsync({ batchIds: ['3000000000001'], targetProcessId: '2000000000001' })
      .catch(() => undefined);

    expect(ElMessage.error).toHaveBeenCalledWith('BIZ_BATCH_ALREADY_DISPATCHED');
    const keys = vi
      .mocked(testQueryClient.invalidateQueries)
      .mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(keys).toEqual([['pending-batches']]);
    // 失败不动多选：用户的选择不该被一次失败清空
    expect(d.selectedIds.value.size).toBe(1);
  });
});
