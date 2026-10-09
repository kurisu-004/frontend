// src/views/production/queue/composables/__tests__/useQueueDispatch.spec.ts
//
// 「待下发」Tab 的视图层 composable：待下发列表（读）+ 下发 / 自动下发（写）。
//
// 2026-10-08 改名与域收敛：composable 从「pending_dispatch」改名 queue_dispatch，
// 落到 `views/production/queue/composables/`；api 函数从已删除的 pending-batches 模块迁到
// `@/api/productionQueue`（端点 `/prod/batches/{pending,dispatch,auto-dispatch}` →
// `/prod/queue/{pending,dispatch,auto-dispatch}`）；queryKey 从 `pending-batches` 域改成
// `production-queue/pending`；失效链从「pending-batches + parts + pool 三域」改成
// 「pending + board + snapshot + parts」。
//
// 两个 mutation 的语义逐字不变：dispatch 是 bulk-only（单条即 targets.length === 1），
// auto-dispatch 是**只读预览 + 确认后链式下发**两步。
//
// 覆盖：
//   - T1：dispatchMutation 成功 → 请求体 targets 形态 + 失效四域（无 refreshBoard）。
//   - T2：dispatchMutation 成功 → 清空 selectedIds + 成功 toast。
//   - T3：autoDispatch preview 全部可下发 → 弹确认框 → 确认后调 dispatchBatches
//     （用 first_process_id 作 target_process_id），响应按**有链工单**真实形态
//     （current_process_step_id 非空字符串）走完 mutation 全链。
//   - T4：autoDispatch preview 含 skip 件 → 确认框文案含跳过原因 + 确认后只下发可下发项。
//   - T5：autoDispatch preview 全部不可下发 → **不弹确认框** + ElMessage.warning。
//   - T6：preview 多件 NO_PROCESS_CHAIN → **只弹一次** handleProcessChainRequired
//     引导框（合成 ApiError(20706) → ElMessageBox.confirm），文案带件数、深链只带
//     第一件的 part_id、零下发请求。
//   - T6b：引导框被用户取消 → 仍只弹一次、不跳页、不发下发请求。
//   - T7：用户取消确认框 → 不发 dispatch 请求（preview 是只读的，无需回滚）。
//   - T8：preview 多首道工序 → 按 first_process_id 拆成多次 dispatch。
//   - T9：setSelectedIds / clearSelection 行为正确（基础状态守卫）。
//   - T10：不再导出 bulkDispatchMutation（批量端点已下线）。
//   - T11：dispatchMutation 失败 → 报错 toast + 与成功同款的**四域**失效链（多选保持
//     不动）。失败不等于「什么都没发生」：40901 / 20120 意味着别人已经把这批下发了。
//   - T11b：auto-dispatch 预览失败 → 只报错 toast、零失效（只读预览不写库）。
//
// 测试策略：
//   - vi.mock('@/api/productionQueue')：dispatchBatches / previewAutoDispatch /
//     fetchPendingBatches 替换为 vi.fn()。
//   - vi.mock('element-plus', ...) 防 vitest node env ElMessage 污染输出；ElMessageBox
//     桩成 vi.fn()（自动下发确认框 + handleProcessChainRequired 都会调）。
//   - vi.mock('vue-router')：useRouter() 注入 fakeRouter 闭包。
//   - T6 / T6b 用 qc.setQueryData 预置待下发列表（引导框 part_id 深链的唯一数据源是
//     批次列表的 batch_id → part_id 反查表），使深链可断言。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
// 供 vi.mock 的 importOriginal 泛型使用（@typescript-eslint/consistent-type-imports
// 禁止 `import()` 形式类型注解）
import type * as ProductionQueueModule from '@/api/productionQueue';

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
    current_process_id: string | null;
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

/** dispatch 出参对齐 queue 域 DispatchResult（bulk-only 列表形态）。 */
const realDispatchBatches = vi.fn<
  (req: {
    targets: Array<{ batch_id: string; target_process_id: string }>;
    note?: string;
  }) => Promise<DispatchResult>
>(async (req) => ({
  succeeded: req.targets.map((t, i) => ({
    batch_id: t.batch_id,
    current_process_step_id: null,
    current_process_id: t.target_process_id,
    target_process_id: t.target_process_id,
    shelf_id: '5000000000001',
    version: i + 2,
  })),
  failed: [],
}));

/** auto-dispatch 出参对齐 queue 域 AutoDispatchResult（只读 preview）。 */
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

vi.mock('@/api/productionQueue', async (importOriginal) => ({
  // importOriginal 保留 AUTO_DISPATCH_SKIP_REASON_LABELS（纯常量文案表，不该被 mock）。
  ...(await importOriginal<typeof ProductionQueueModule>()),
  dispatchBatches: (...args: unknown[]) =>
    realDispatchBatches(...(args as Parameters<typeof realDispatchBatches>)),
  previewAutoDispatch: (...args: unknown[]) =>
    realPreviewAutoDispatch(...(args as Parameters<typeof realPreviewAutoDispatch>)),
  fetchPendingBatches: (...args: unknown[]) =>
    realFetchPendingBatches(...(args as [])),
}));

import { useQueueDispatch } from '../useQueueDispatch';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** invalidateAll() 失效域的 queryKey 序列断言（**顺序敏感**：先刷待下发列表，再刷
 *  工序看板 + 队列快照，最后跨域刷 parts；parts 放最后是因为它最热、一次失效会连带
 *  零件一览与批次列表的多个 query）。 */
function expectFourDomainsInvalidated(): void {
  const keys = vi
    .mocked(testQueryClient.invalidateQueries)
    .mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  expect(keys).toEqual([
    ['production-queue', 'pending'],
    ['production-queue', 'board'],
    ['production-queue', 'snapshot'],
    ['parts'],
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

/** 2026-10-04 新增：待下发列表行 fixture（只填 usePendingDispatch 反查表要用的
 *  batch_id / part_id，其余字段占位满足 pendingBatchItemSchema 的必填声明）。 */
function makePendingBatchItem(batchId: string, partId: string) {
  return {
    batch_id: batchId,
    part_id: partId,
    batch_no: 1,
    quantity: 1,
    serial_no: 'SN-1',
    name: '零件',
    drawing_no: 'D-1',
    planned_delivery_date: '2026-11-01',
    system_delivery_date: null,
    customer_name: null,
    parent_customer_name: null,
    applicant_name: null,
    is_urgent: false,
    note: null,
    version: 1,
  };
}

describe('useQueueDispatch — bulk-only dispatch + auto preview 两步', () => {
  beforeEach(async () => {
    const { ElMessage, ElMessageBox } = await import('element-plus');
    realDispatchBatches.mockClear();
    realPreviewAutoDispatch.mockClear();
    realFetchPendingBatches.mockClear();
    fakeRouterPush.mockClear();
    vi.mocked(ElMessageBox.confirm).mockClear();
    // ElMessage 的四个桩是 vi.mock 工厂里的**裸** vi.fn()：afterEach 的
    // vi.restoreAllMocks() 只还原 vi.spyOn、不清它们的调用历史，不在这里清就会把
    // 上一例的 toast 带进下一例的断言（对「不应报错」「已下发 N 件」这类断言是恒真陷阱）。
    vi.mocked(ElMessage.success).mockClear();
    vi.mocked(ElMessage.error).mockClear();
    vi.mocked(ElMessage.warning).mockClear();
    vi.mocked(ElMessage.info).mockClear();
    // 默认 = 用户点确认
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(undefined as never);
    realFetchPendingBatches.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });
    realDispatchBatches.mockImplementation(async (req) => ({
      succeeded: req.targets.map((t, i) => ({
        batch_id: t.batch_id,
        current_process_step_id: null,
        current_process_id: t.target_process_id,
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
    const d = testApp.runWithContext(() => useQueueDispatch());
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
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(4);
    expectFourDomainsInvalidated();
  });

  it('T2：dispatchMutation 成功 → 清空 selectedIds + 成功 toast', async () => {
    const { ElMessage } = await import('element-plus');
    const d = testApp.runWithContext(() => useQueueDispatch());
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
    const d = testApp.runWithContext(() => useQueueDispatch());
    await d.dispatchMutation.mutateAsync({
      batchIds: ['3000000000001'],
      targetProcessId: '2000000000001',
    });
    const sent = realDispatchBatches.mock.calls[0]?.[0];
    expect(sent?.targets).toHaveLength(1);
  });

  it('T3：autoDispatch preview 全部可下发 → 弹确认框 → 确认后调 dispatchBatches（用 first_process_id）', async () => {
    const { ElMessage, ElMessageBox } = await import('element-plus');
    // 这条路径打的正是**有链工单**（preview 的 first_process_id 取自链首 step），
    // 后端回的 current_process_step_id 非空、current_process_id 是链首工序。
    // mutationFn 走 dispatchResultSchema.parse ⇒ 这个形态必须整链通过；反之该字段
    // 退回 number 形态时 parse 抛在 HTTP 200 之后，已提交的下发会被报成失败。本例是
    // 该字段「必须是字符串」的端到端守卫，后端样本落在 Q-D5 的 schema 层负向守卫。
    realDispatchBatches.mockResolvedValueOnce({
      succeeded: [
        {
          batch_id: '3000000000001',
          current_process_step_id: '1900000000000000001',
          current_process_id: '2000000000001',
          target_process_id: '2000000000001',
          shelf_id: '5000000000001',
          version: 2,
        },
      ],
      failed: [],
    });
    const d = testApp.runWithContext(() => useQueueDispatch());

    await d.autoDispatchMutation.mutateAsync({ batchIds: ['3000000000001'] });

    expect(realPreviewAutoDispatch).toHaveBeenCalledWith({ batch_ids: ['3000000000001'] });
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    // 真正下发用 preview 返回的 first_process_id 作 target_process_id
    expect(realDispatchBatches).toHaveBeenCalledWith({
      targets: [{ batch_id: '3000000000001', target_process_id: '2000000000001' }],
    });
    // 有链形态过 parse → onSuccess 照常报数；反过来 parse 抛错会走 onError，
    // 而 onError 同样打四域 invalidate，故必须用「无报错 toast」把两条分支劈开。
    expect(ElMessage.success).toHaveBeenCalledWith('已下发 1 件');
    expect(ElMessage.error).not.toHaveBeenCalled();
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
    const d = testApp.runWithContext(() => useQueueDispatch());

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
    const d = testApp.runWithContext(() => useQueueDispatch());

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002'],
    });

    // 避免给用户一个「确认了却什么都不会发生」的空确认框
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(realDispatchBatches).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith(
      '无可下发批次：工序链无可用步骤 1、批次不存在或状态不可下发 1',
    );
    // 多选被清空（本次无任何下发发生）
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T6：preview 多件 NO_PROCESS_CHAIN → 只弹一次引导框，文案带件数、深链只带第一件 part_id', async () => {
    // 后端不再抛 20706（错误码表已无此项），改以 skip_reason soft-skip
    // 呈现；前端合成 ApiError(20706) 复用既有 handleProcessChainRequired 兜底，
    // 保持「引导去工艺制定页」的 UX 不退化。一次操作只弹一次 —— 多选 N 件未制定
    // 工序链的工单不该弹 N 个一模一样的弹窗。
    const { ElMessageBox } = await import('element-plus');
    const noChain = [
      makeOkPreviewItem('3000000000001', null, 'NO_PROCESS_CHAIN'),
      makeOkPreviewItem('3000000000002', null, 'NO_PROCESS_CHAIN'),
      makeOkPreviewItem('3000000000003', null, 'NO_PROCESS_CHAIN'),
    ];
    realPreviewAutoDispatch.mockResolvedValueOnce({ items: noChain });
    // 预置待下发列表：引导框的 part_id 深链来自批次列表的 batch_id → part_id 反查表
    testQueryClient.setQueryData(qk.productionQueuePending({ limit: 200 }), {
      items: [
        makePendingBatchItem('3000000000001', '4000000000001'),
        makePendingBatchItem('3000000000002', '4000000000002'),
        makePendingBatchItem('3000000000003', '4000000000003'),
      ],
      total: 3,
      limit: 200,
      offset: 0,
    });
    const d = testApp.runWithContext(() => useQueueDispatch());

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002', '3000000000003'],
    });

    // 3 件未制定工序链 ⇒ 引导框只弹一次（无下发确认框）
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    const message = vi.mocked(ElMessageBox.confirm).mock.calls[0]?.[0] as string;
    expect(message).toContain('3 件工单未制定工序链');
    // 深链只带第一件的 part_id，最多跳一次页
    expect(fakeRouterPush).toHaveBeenCalledTimes(1);
    expect(fakeRouterPush).toHaveBeenCalledWith('/production/process-design?part_id=4000000000001');
    expect(realDispatchBatches).not.toHaveBeenCalled();
  });

  it('T6b：引导框被用户取消 → 仍只弹一次、不跳页、不发下发请求', async () => {
    const { ElMessageBox } = await import('element-plus');
    realPreviewAutoDispatch.mockResolvedValueOnce({
      items: [
        makeOkPreviewItem('3000000000001', null, 'NO_PROCESS_CHAIN'),
        makeOkPreviewItem('3000000000002', null, 'NO_PROCESS_CHAIN'),
        makeOkPreviewItem('3000000000003', null, 'NO_PROCESS_CHAIN'),
      ],
    });
    testQueryClient.setQueryData(qk.productionQueuePending({ limit: 200 }), {
      items: [
        makePendingBatchItem('3000000000001', '4000000000001'),
        makePendingBatchItem('3000000000002', '4000000000002'),
        makePendingBatchItem('3000000000003', '4000000000003'),
      ],
      total: 3,
      limit: 200,
      offset: 0,
    });
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel' as never);
    const d = testApp.runWithContext(() => useQueueDispatch());

    await d.autoDispatchMutation.mutateAsync({
      batchIds: ['3000000000001', '3000000000002', '3000000000003'],
    });

    // 取消后不再弹下一个：一次操作一次弹窗
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    expect(fakeRouterPush).not.toHaveBeenCalled();
    expect(realDispatchBatches).not.toHaveBeenCalled();
  });

  it('T7：用户取消确认框 → 不发 dispatch 请求（preview 只读，无需回滚）', async () => {
    const { ElMessageBox } = await import('element-plus');
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel' as never);
    const d = testApp.runWithContext(() => useQueueDispatch());

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
    const d = testApp.runWithContext(() => useQueueDispatch());

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
    const d = testApp.runWithContext(() => useQueueDispatch());
    d.setSelectedIds(['3000000000001', '3000000000002', '3000000000003']);
    expect(d.selectedIds.value.size).toBe(3);
    d.clearSelection();
    expect(d.selectedIds.value.size).toBe(0);
  });

  it('T10：不再导出 bulkDispatchMutation（批量下发端点已下线）', () => {
    // 回归 guard：bulkDispatchMutation 对应的后端端点已下线；若未来有人再加回来，
    // 本用例会失败。
    const d = testApp.runWithContext(() => useQueueDispatch());
    expect(d).not.toHaveProperty('bulkDispatchMutation');
  });

it('T11：dispatch 失败 → 报错 toast + 走全套四域失效链（多选保持不动）', async () => {
    // 回归 guard（2026-10-02）：失败时卡片本来就不会从待下发池消失，onError 里的重拉
    // 是「失败即对账」的兜底。2026-10-08 修正覆盖面：原先 onError 只失效待下发列表域，
    // 但 dispatch 最常见的失败恰是 40901 OCC / 20120 状态不允许 —— 那意味着**别人已经
    // 把这批下发出去**（批次真的离开待下发池、进了目标工序候选池），只刷 pending 会让
    // 目标工序列凭空少卡、tab 徽标过期。故 onError 与 onSuccess 同款走四域。
    const { ElMessage } = await import('element-plus');
    realDispatchBatches.mockRejectedValueOnce(new Error('BIZ_BATCH_ALREADY_DISPATCHED'));

    const d = testApp.runWithContext(() => useQueueDispatch());
    d.setSelectedIds(['3000000000001']);
    await d.dispatchMutation
      .mutateAsync({ batchIds: ['3000000000001'], targetProcessId: '2000000000001' })
      .catch(() => undefined);

    expect(ElMessage.error).toHaveBeenCalledWith('BIZ_BATCH_ALREADY_DISPATCHED');
    // 与 onSuccess 同一条失效链、同一顺序
    expectFourDomainsInvalidated();
    // 失败不动多选：用户的选择不该被一次失败清空
    expect(d.selectedIds.value.size).toBe(1);
  });

  it('T11b：auto-dispatch 预览失败 → 只报错 toast，零失效（预览不写库）', async () => {
    // 对照 T11：auto-dispatch 是**只读预览**（后端不写库、不发 WS），失败不可能让
    // 任何域的数据变旧 ⇒ 不该失效任何 query。多失效只会白拉一遍。
    const { ElMessage } = await import('element-plus');
    realPreviewAutoDispatch.mockRejectedValueOnce(new Error('preview failed'));

    const d = testApp.runWithContext(() => useQueueDispatch());
    await d.autoDispatchMutation.mutateAsync({ batchIds: ['3000000000001'] }).catch(() => undefined);

    expect(ElMessage.error).toHaveBeenCalledWith('preview failed');
    expect(testQueryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
