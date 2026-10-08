// src/views/production/queue/composables/__tests__/useQueueRecall.spec.ts
//
// 「已下发批次召回为待下发」的写操作 composable 行为 spec（生产队列右键召回通路）。
//
// 后端契约：`POST /api/v2/prod/queue/recall`，入参 `{ batch_id, version, note? }`，
// 其中 **`batch_id` 是 body 字段且必须发 JSON 字符串**（后端 `deserialize_i64` 只接受
// 字符串，发数字返 40001 —— 这是 2026-10-08 契约变更里最容易踩的一处）；
// `version` 必填（无 `#[serde(default)]`，缺省 40001）。RBAC：MANAGER 或 CLERK。
//
// 覆盖：
//   - R1：recallBatch 以**单参数对象** `{ batch_id, version }` 调 recallToPending；
//   - R1b：canRecall 与后端 MANAGER/CLERK 对齐；
//   - R1c：出参缺字段 → mutationFn 的 Zod 守门抛错（契约漂移不会静默通过）；
//   - R2：用户取消确认弹窗 → 不发请求；
//   - R2b：确认弹窗文案（标题 / 正文 / 按钮）；
//   - R3：卡片缺 version → 早退 + warning，不发请求（后端必填，发了必然 40001）；
//   - R4：角色既非 MANAGER 也非 CLERK → 早退不发请求（后端返 40300）；
//   - R5：onSuccess 触发四域失效（pending / board / snapshot + qk.partsPrefix）+ 成功 toast；
//   - R6：onError 也跑同一串失效 + 错误 toast（409 OCC 必须与服务器对账）；
//   - R6b：mutation 不重试（信任 main.ts 全局 mutations.retry: 0）。
//
// 测试策略：
//   - vi.mock('@/api/productionQueue') 桩掉 recallToPending —— 只关心入参形态与调用
//     次数（出参 RecallOut 经 schema 守门后零消费，取舍见该 composable 文件头）；
//   - vi.mock('element-plus')：ElMessage 桩成 no-op（node env 下真实 ElMessage 会因
//     `document is not defined` 污染输出），ElMessageBox.confirm 桩成可控 resolve /
//     reject（reject = 用户点「取消」）；
//   - vi.mock('@/stores/auth')：只桩 useQueueRecall 消费的那一面（hasRole），避免把
//     整个 auth store 拉进本 spec；
//   - app.use(VueQueryPlugin) + 传 QueryClient，并 vi.spyOn(qc, 'invalidateQueries')
//     验证失效链的 queryKey 序列。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => undefined) },
}));

/** 出参对齐 queue 域 RecallOut（version = batch.version + 1）。 */
const realRecallToPending = vi.fn<
  (req: { batch_id: string; version: number; note?: string }) => Promise<unknown>
>(async () => ({ batch_id: '3000000000001', part_id: '4000000000001', version: 8 }));

vi.mock('@/api/productionQueue', () => ({
  recallToPending: (...args: unknown[]) =>
    realRecallToPending(...(args as Parameters<typeof realRecallToPending>)),
  // 本 spec 只消费 recallToPending；列出 stub 防止 partial mock 副作用
  fetchQueueSnapshot: vi.fn(),
  fetchQueueBoard: vi.fn(),
  fetchPendingBatches: vi.fn(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
  refillQueue: vi.fn(),
}));

/** 角色桩：默认 MANAGER + CLERK 都有权；用例内可改。 */
const roles = vi.hoisted(() => ({ list: ['MANAGER', 'CLERK'] as string[] }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    hasRole: (r: string) => roles.list.includes(r),
  }),
}));

import { useQueueRecall } from '../useQueueRecall';
import { qk } from '@/composables/queries/keys';
import type { BatchCardModel } from '@/types/batchCard';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function makeCard(overrides: Partial<BatchCardModel> = {}): BatchCardModel {
  return {
    batch_id: '3000000000001',
    part_id: '4000000000001',
    batch_no: 'B1024',
    part_name: '连杆',
    drawing_no: 'DRW-1',
    serial_no: 'SN-0001',
    quantity: 12,
    system_delivery_date: '2026-10-20',
    planned_delivery_date: null,
    is_urgent: false,
    has_process_chain: false,
    has_cnc_program: false,
    customer_l1: '某某集团',
    customer_l2: null,
    applicant_name: '张三',
    note: null,
    location: 'PRODUCTION_SHELF',
    shelf_id: '5000000000001',
    version: 7,
    ...overrides,
  };
}

/** onSuccess / onError 应触发的四域失效序列（键一律来自 qk 工厂）。
 *  全部前缀失效：批次可能来自任意工序的候选池或任意工人的手里，菜单只带卡片 model，
 *  拿不到「它原本在哪个 processId / workerId」。 */
function expectFourDomainsInvalidated(): void {
  const keys = vi
    .mocked(testQueryClient.invalidateQueries)
    .mock.calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  expect(keys).toEqual([
    ['production-queue', 'pending'],
    ['production-queue', 'board'],
    ['production-queue', 'snapshot'],
    qk.partsPrefix,
  ]);
}

describe('useQueueRecall（已下发批次召回）', () => {
  beforeEach(async () => {
    const { ElMessage, ElMessageBox } = await import('element-plus');
    realRecallToPending.mockClear();
    vi.mocked(ElMessage.success).mockClear();
    vi.mocked(ElMessage.error).mockClear();
    vi.mocked(ElMessage.warning).mockClear();
    vi.mocked(ElMessageBox.confirm).mockClear();
    // 默认 = 用户点确认
    vi.mocked(ElMessageBox.confirm).mockResolvedValue(undefined as never);
    roles.list = ['MANAGER', 'CLERK'];

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

  it('R1：recallBatch 以单参数对象 { batch_id, version } 调 recallToPending', async () => {
    const r = testApp.runWithContext(() => useQueueRecall());
    await r.recallBatch(makeCard({ batch_id: '3000000000009', version: 12 }));

    expect(realRecallToPending).toHaveBeenCalledTimes(1);
    // batch_id 是 body 字段且必须是**字符串**（后端 deserialize_i64 只收字符串）；
    // version 必填（缺省后端 40001）。
    expect(realRecallToPending).toHaveBeenCalledWith({
      batch_id: '3000000000009',
      version: 12,
    });
  });

  it('R1c：出参缺字段 → Zod 守门抛错（契约漂移不静默通过）', async () => {
    realRecallToPending.mockResolvedValueOnce({ batch_id: '3000000000001' });
    const r = testApp.runWithContext(() => useQueueRecall());
    await expect(
      r.recallMutation.mutateAsync({ batchId: '3000000000001', version: 7 }),
    ).rejects.toThrow();
  });

  it('R1b：canRecall 与后端 MANAGER/CLERK 对齐', () => {
    const r = testApp.runWithContext(() => useQueueRecall());
    expect(r.canRecall.value).toBe(true);

    roles.list = ['CLERK'];
    expect(testApp.runWithContext(() => useQueueRecall()).canRecall.value).toBe(true);

    roles.list = ['MANAGER'];
    expect(testApp.runWithContext(() => useQueueRecall()).canRecall.value).toBe(true);

    roles.list = ['INSPECTOR'];
    expect(testApp.runWithContext(() => useQueueRecall()).canRecall.value).toBe(false);
  });

  it('R2：用户取消确认弹窗 → 不发请求', async () => {
    const { ElMessageBox } = await import('element-plus');
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel' as never);
    const r = testApp.runWithContext(() => useQueueRecall());

    await r.recallBatch(makeCard());

    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1);
    expect(realRecallToPending).not.toHaveBeenCalled();
  });

  it('R2b：确认弹窗文案（标题 / 正文 / 按钮）', async () => {
    const { ElMessageBox } = await import('element-plus');
    const r = testApp.runWithContext(() => useQueueRecall());
    await r.recallBatch(makeCard({ batch_no: 'B2048' }));

    const [message, title, options] = vi.mocked(ElMessageBox.confirm).mock.calls[0]!;
    expect(title).toBe('召回确认');
    expect(message).toBe(
      '确认将批次「B2048」召回到待下发？召回后该批次将从货架/工人处移除，回到待下发池。',
    );
    expect(options).toMatchObject({
      type: 'warning',
      confirmButtonText: '召回',
      cancelButtonText: '取消',
    });
  });

  it('R3：卡片缺 version → 早退 + warning，不发请求', async () => {
    const { ElMessage, ElMessageBox } = await import('element-plus');
    const r = testApp.runWithContext(() => useQueueRecall());

    await r.recallBatch(makeCard({ version: undefined }));

    expect(ElMessage.warning).toHaveBeenCalledWith('批次版本信息缺失，无法召回');
    // 早退发生在确认弹窗之前：缺 version 的请求必然被后端 40001 拒，不该弹窗也不该发
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(realRecallToPending).not.toHaveBeenCalled();
  });

  it('R4：既非 MANAGER 也非 CLERK → 早退不发请求', async () => {
    const { ElMessage, ElMessageBox } = await import('element-plus');
    roles.list = ['INSPECTOR'];
    const r = testApp.runWithContext(() => useQueueRecall());

    await r.recallBatch(makeCard());

    expect(r.canRecall.value).toBe(false);
    expect(ElMessage.warning).toHaveBeenCalledWith('没有召回已下发批次的权限');
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(realRecallToPending).not.toHaveBeenCalled();
  });

  it('R5：onSuccess 触发四域失效（含 qk.partsPrefix）+ 成功 toast', async () => {
    const { ElMessage } = await import('element-plus');
    const r = testApp.runWithContext(() => useQueueRecall());

    await r.recallMutation.mutateAsync({ batchId: '3000000000001', version: 7 });

    expect(realRecallToPending).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      version: 7,
    });
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(4);
    expectFourDomainsInvalidated();
    expect(ElMessage.success).toHaveBeenCalledWith('已召回到待下发');
  });

  it('R6：onError 报错 toast + 同一串失效（409 OCC 必须与服务器对账）', async () => {
    const { ElMessage } = await import('element-plus');
    realRecallToPending.mockRejectedValueOnce(new Error('批次已被他人修改'));
    const r = testApp.runWithContext(() => useQueueRecall());

    await expect(
      r.recallMutation.mutateAsync({ batchId: '3000000000001', version: 7 }),
    ).rejects.toThrow('批次已被他人修改');

    expect(ElMessage.error).toHaveBeenCalledWith('批次已被他人修改');
    expect(testQueryClient.invalidateQueries).toHaveBeenCalledTimes(4);
    expectFourDomainsInvalidated();
  });

  it('R6b：mutation 不重试（信任 main.ts 全局 mutations.retry: 0）', async () => {
    realRecallToPending.mockRejectedValue(new Error('boom'));
    const r = testApp.runWithContext(() => useQueueRecall());
    // 客户端 QueryClient 显式配了 retry:0；这里断言的是「请求只打一次」这一可观测行为，
    // 组件内没有自己的 retry 覆盖（配 retry 时首打也会被延后，行为等价但次数断言不直观）
    await expect(
      r.recallMutation.mutateAsync({ batchId: '3000000000001', version: 7 }),
    ).rejects.toThrow('boom');
    expect(realRecallToPending).toHaveBeenCalledTimes(1);
  });
});
