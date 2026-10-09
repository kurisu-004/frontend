// src/views/parts/detail/composables/__tests__/usePartDetailActions.spec.ts
//
// 零件详情页 7 个写操作（`usePartDetailActions`）的回归保护。
//
// 覆盖：
//   A1 **mutationKey 是预期字面量**（全仓写 mutation 一律不从 `qk` 工厂取，登记进去只
//      会留下零消费者的死键）；顺带把 7 条都触发一遍，确保没有一条漏配。
//   A2 **成功时失效三条前缀**（partDetail / partEvents / partBatchesList），逐条断言
//      调用序 —— 少刷一条就留下一半陈旧数据（品检通过后工单标签没翻 / 历史卡没有
//      INSPECTED 事件 / 批次行还停在 INSPECTION）。
//   A3 **OCC 40901 分流**：走 `ElMessage.warning`（不是 error）+ 仍失效。
//   A4 **onError 也失效**（不只是 onSuccess）：40901 恰恰意味着服务端副本已被别人改动。
//   A5 返回值：成功 `true` / 失败 `false`。
//   A6 软删成功走**列表域** `qk.partsPrefix`（目标资源已不存在，按 part 维度失效只会
//      换来三条注定 404 的请求 + 一句假错误）；onError 仍走本页三条。
//   A7 两个品检动作打**同一个**锚批次（此前一个取 find(INSPECTION)、一个取 shell 传的
//      selectedBatchId，多批次工单上会打不同的批次而用户看不出来）。
//   A8 `POST /batches/split` 的 wire 形状：`batch_id` 是字符串、`version` / `quantity`
//      是裸 number（后端逐字段挂各自的反序列化器，发错一档都是 422 纯文本）。
//
// 测试手法与 `views/production/scan/composables/__tests__/useScanQuery.spec.ts` 同款：
// `app.runWithContext`（vue-query 的 `useQueryClient()` 走 Vue `inject()`，node env 下
// currentApp 为 null 直接抛）、每个用例一份新 QueryClient、api 层整模块桩掉、
// `element-plus` 桩掉（真 ElMessage 在 node env 下会因 `document is not defined` 污染输出，
// `ElMessageBox` 同样要桩 —— `useConfirm` 内部用它做二次确认）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, effectScope, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

const h = vi.hoisted(() => ({
  cancelPart: vi.fn(),
  cancelPartBatch: vi.fn(),
  softDeletePart: vi.fn(),
  splitBatch: vi.fn(),
  toProcess: vi.fn(),
  toShip: vi.fn(),
  updatePart: vi.fn(),
  confirm: vi.fn(),
  msg: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/parts', () => ({
  cancelPart: h.cancelPart,
  cancelPartBatch: h.cancelPartBatch,
  softDeletePart: h.softDeletePart,
  toProcess: h.toProcess,
  toShip: h.toShip,
  updatePart: h.updatePart,
}));

vi.mock('@/api/batch', () => ({ splitBatch: h.splitBatch }));

vi.mock('element-plus', () => ({
  ElMessage: h.msg,
  ElMessageBox: { confirm: h.confirm },
}));

import { ApiError } from '@/api/http';
import { qk } from '@/composables/queries/keys';
import { usePartDetailActions } from '@/views/parts/detail/composables/usePartDetailActions';
import { resolveInspectionBatch } from '@/views/parts/detail/composables/inspectionBatch';
import type { PartBatch } from '@/api/parts';
import type { PartDetailData } from '@/views/parts/detail/composables/partDetailSchema';

const PART_ID = '219276974948876288';

function makePart(overrides: Record<string, unknown> = {}): PartDetailData {
  const base: Record<string, unknown> = {
    id: PART_ID,
    serial_no: 'F1889-01',
    name: '子零件',
    drawing_no: 'DWG-1889',
    applicant_name: '张工',
    quantity: 5,
    request_date: '2026-10-01',
    planned_delivery_date: '2026-10-20',
    customer_id: '9000000000001',
    assembly_id: null,
    status: 'INSPECTION',
    is_urgent: false,
    next_process_id: null,
    order_no: null,
    system_delivery_date: null,
    note: null,
    unit_price: '12.50',
    total_price: '62.50',
    version: 3,
    created_at: '2026-10-01 09:00:00',
    created_by: null,
    updated_at: '2026-10-02 10:00:00',
    updated_by: null,
    deleted_at: null,
    process_chain_id: null,
    customer_name: null,
    l1_customer_name: null,
    current_batch_id: null,
    ...overrides,
  };
  return base as PartDetailData;
}

function makeBatch(overrides: Partial<PartBatch> = {}): PartBatch {
  const base = {
    id: '3000000000002',
    version: 7,
    part_id: PART_ID,
    batch_no: 3,
    batch_label: 'B3',
    quantity: 5,
    status: 'INSPECTION',
    is_repairing: false,
    location: null,
    current_holder_id: null,
    current_holder_display: null,
    next_process_name: null,
    delivery_note_id: null,
    delivery_note_no: null,
    parent_batch_id: null,
    created_at: '2026-10-01 09:00:00',
    updated_at: '2026-10-01 09:00:00',
    ...overrides,
  } satisfies PartBatch;
  return base;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;
let keys: unknown[][];
/** 把 invalidateQueries 的每次调用记进 `keys`，让断言能逐条比对调用序。 */
let spy: ReturnType<typeof vi.spyOn>;

/** 装配一份 bindings（默认：工单可写 + 有一条 INSPECTION 批次）。
 *  `selectedBatchId` 可变，用来覆盖「用户选中了哪一行」这一支（见 A7 组）。 */
function mountActions(
  partOverrides: Record<string, unknown> = {},
  batches: PartBatch[] = [],
  selectedBatchId: string | null = null,
) {
  const part = ref<PartDetailData | null>(makePart(partOverrides));
  const list = computed<PartBatch[]>(() =>
    batches.length ? batches : [makeBatch({ id: '3000000000002', batch_label: 'B3' })],
  );
  const selected = ref<string | null>(selectedBatchId);
  // 派生口径与 shell 完全同款（同一条纯函数），不在 spec 里复写一遍。
  const inspectionBatch = computed<PartBatch | null>(() =>
    resolveInspectionBatch(list.value, selected.value),
  );
  const actions = testApp.runWithContext(() =>
    usePartDetailActions({ partId: () => PART_ID, part, inspectionBatch }),
  );
  return { part, batches: list, selected, inspectionBatch, actions };
}

beforeEach(() => {
  h.cancelPart.mockReset().mockResolvedValue({});
  h.cancelPartBatch.mockReset().mockResolvedValue({});
  h.softDeletePart.mockReset().mockResolvedValue(undefined);
  h.toProcess.mockReset().mockResolvedValue({});
  h.toShip.mockReset().mockResolvedValue({});
  h.updatePart.mockReset().mockResolvedValue(makePart());
  h.splitBatch.mockReset().mockResolvedValue({
    batch_id: '3000000000002',
    new_batch_id: '3000000000003',
    part_id: PART_ID,
    quantity: 2,
    source_version: 8,
  });
  h.confirm.mockReset().mockResolvedValue(undefined);
  h.msg.success.mockReset();
  h.msg.error.mockReset();
  h.msg.warning.mockReset();

  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  keys = [];
  spy = vi.spyOn(testQueryClient, 'invalidateQueries').mockImplementation((q?: unknown) => {
    keys.push((q as { queryKey: unknown[] }).queryKey);
    return Promise.resolve();
  });
});

afterEach(() => {
  spy.mockRestore();
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

/** 三条本页读键前缀的**期望调用序**（见 usePartDetailActions 的失效链注释）。 */
const EXPECTED_PREFIXES = [qk.partDetailPrefix, qk.partEventsPrefix, qk.partBatchesPrefix];

describe('usePartDetailActions — 7 个写端点', () => {
  it('A1：7 条 mutationKey 都是字面量，且不从 qk 工厂取', async () => {
    const scope = effectScope();
    const { actions, batches } = scope.run(() => mountActions())!;
    const batch = batches.value[0]!;

    await actions.onSave({ name: '新名' });
    await actions.onCancelOrder();
    await actions.onDeletePart();
    await actions.onPassInspection();
    await actions.onFailInspection({ processId: '9000000000099', note: null });
    await actions.onSplitBatch(batch, 2);
    await actions.onCancelBatch(batch);

    const mutationKeys = testQueryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.options.mutationKey);
    expect(mutationKeys).toEqual([
      ['parts', 'detail', 'update'],
      ['parts', 'detail', 'cancel'],
      ['parts', 'detail', 'soft-delete'],
      ['parts', 'detail', 'inspection-to-ship'],
      ['parts', 'detail', 'inspection-to-process'],
      ['parts', 'detail', 'batch-split'],
      ['parts', 'detail', 'batch-cancel'],
    ]);
    // 断言不是从 qk 派生的（qk 里压根没有这些键）
    expect(Object.values(qk)).not.toContain('parts');
    scope.stop();
  });

  it('A2：保存成功后失效 partDetail + partEvents + partBatchesList 三条前缀（逐条有序）', async () => {
    const scope = effectScope();
    const { actions } = scope.run(() => mountActions())!;
    const ok = await actions.onSave({ name: '新名', drawing_no: 'DWG-1' });
    expect(ok).toBe(true);
    expect(keys).toEqual(EXPECTED_PREFIXES);
    // OCC 锚取 part 级 version，且被显式覆盖成 payload 里的（payload 不收 version）
    expect(h.updatePart.mock.calls[0]).toEqual([
      PART_ID,
      expect.objectContaining({ version: 3, name: '新名', drawing_no: 'DWG-1' }),
    ]);
    scope.stop();
  });

  it('A3：OCC 40901 ⇒ ElMessage.warning（不是 error）+ 仍走全套失效', async () => {
    const scope = effectScope();
    const { actions } = scope.run(() => mountActions())!;
    h.updatePart.mockReset().mockRejectedValue(new ApiError(40901, 'VERSION_CONFLICT'));

    const ok = await actions.onSave({ name: '新名' });
    expect(ok).toBe(false);
    expect(h.msg.warning).toHaveBeenCalledTimes(1);
    expect(h.msg.error).not.toHaveBeenCalled();
    expect(keys).toEqual(EXPECTED_PREFIXES);
    scope.stop();
  });

  // 40901 恰恰意味着**服务端那份已经被别人改过**、本端副本过期；非 40901 的失败
  // （20103 状态机非法等）同样可能发生在别人刚流转完之后 ⇒ 两个出口都失效。
  it('A4：非 40901 的失败同样失效三条前缀（onError 也在失效链上）', async () => {
    const scope = effectScope();
    const { actions, batches } = scope.run(() => mountActions())!;
    h.toShip.mockReset().mockRejectedValue(new ApiError(20103, '状态不允许通过品检'));

    const ok = await actions.onPassInspection();
    expect(ok).toBe(false);
    expect(h.msg.error).toHaveBeenCalledTimes(1);
    expect(h.msg.warning).not.toHaveBeenCalled();
    expect(keys).toEqual(EXPECTED_PREFIXES);
    expect(h.toShip.mock.calls[0]![0]).toBe(batches.value[0]!.id);
    scope.stop();
  });

  it('A5：拆批 / 取消批次的失败返回 null / false（不抛给 shell）', async () => {
    const scope = effectScope();
    const { actions, batches } = scope.run(() => mountActions())!;
    h.splitBatch.mockReset().mockRejectedValue(new Error('422'));
    h.cancelPartBatch.mockReset().mockRejectedValue(new Error('boom'));

    expect(await actions.onSplitBatch(batches.value[0]!, 2)).toBeNull();
    expect(await actions.onCancelBatch(batches.value[0]!)).toBe(false);
    expect(keys).toEqual([...EXPECTED_PREFIXES, ...EXPECTED_PREFIXES]);
    scope.stop();
  });

  // 软删之后 `GET /parts/{id}` 的 SQL 带 `deleted_at IS NULL`（后端 part_sql.rs
  // ::get_part_detail）⇒ 目标资源不存在，按 part 维度失效只会换来三条注定 404 的请求
  // + 一句「零件不存在」的假错误。要刷的是零件一览（列表 SQL 同样过滤软删行）。
  it('A6：软删成功 ⇒ 失效列表域 partsPrefix（不是本页三条）；软删失败 ⇒ 仍失效本页三条', async () => {
    const scope = effectScope();
    const { actions } = scope.run(() => mountActions())!;

    expect(await actions.onDeletePart()).toBe(true);
    expect(keys).toEqual([qk.partsPrefix]);
    expect(h.softDeletePart.mock.calls[0]).toEqual([PART_ID, 3]);

    keys.length = 0;
    h.softDeletePart.mockReset().mockRejectedValue(new ApiError(40901, 'VERSION_CONFLICT'));
    expect(await actions.onDeletePart()).toBe(false);
    expect(keys).toEqual(EXPECTED_PREFIXES);
    scope.stop();
  });

  // 两个品检按钮此前一个锚 find(status==='INSPECTION')、一个锚 shell 传的
  // selectedBatchId ⇒ 多批次工单上「品检通过」打 A 批、「指定工序」打 B 批，用户看不出来。
  // 2026-10-10 review 第 1 轮：两条动作共用**一条**派生（`resolveInspectionBatch`），
  // 口径是「选中的批次是品检中就用它，否则回落 find(INSPECTION)」—— 既保证同批，又不
  // 忽略用户选择（review 指出「只按 find 取」是把「尊重选择」改成了「忽略选择」）。
  it('A7：品检通过与指定工序打**同一个**锚批次（共用 resolveInspectionBatch 一条派生）', async () => {
    const scope = effectScope();
    const twoBatches: PartBatch[] = [
      makeBatch({ id: 'B_PENDING', batch_label: 'B1', status: 'PENDING' }),
      makeBatch({ id: 'B_INSPECT', batch_label: 'B2', status: 'INSPECTION', version: 11 }),
    ];
    const { actions, inspectionBatch } = scope.run(() => mountActions({}, twoBatches))!;
    expect(inspectionBatch.value?.id).toBe('B_INSPECT');

    await actions.onPassInspection();
    await actions.onFailInspection({ processId: '9000000000099', note: '返修' });

    expect(h.toShip.mock.calls[0]![0]).toBe('B_INSPECT');
    expect(h.toShip.mock.calls[0]![1]).toEqual({ version: 11, quantity: null });
    expect(h.toProcess.mock.calls[0]![0]).toBe('B_INSPECT');
    expect(h.toProcess.mock.calls[0]![1]).toEqual({
      next_process_id: '9000000000099',
      version: 11,
      note: '返修',
    });
    // 二次确认文案里带出了批次标识，用户能看见这次打的是哪一批
    // （ElMessageBox.confirm(message, title, opts) —— 批次标识在 message 里）
    expect(h.confirm.mock.calls[0]![0]).toContain('B2');
    scope.stop();
  });

  // 三种派生：选中的是品检批次 / 选中的不是 / 没选中。后者两条都退回 find(INSPECTION)。
  it('A7c：两条 INSPECTION 批次时锚「选中的那条」，不是列表序第一条', async () => {
    const scope = effectScope();
    const twoInspections: PartBatch[] = [
      makeBatch({ id: 'B_A', batch_label: 'B1', status: 'INSPECTION', version: 11 }),
      makeBatch({ id: 'B_B', batch_label: 'B2', status: 'INSPECTION', version: 22 }),
    ];
    // (1) 没选中 → find(INSPECTION) = 列表序第一条
    const none = scope.run(() => mountActions({}, twoInspections))!;
    expect(none.inspectionBatch.value?.id).toBe('B_A');
    // (2) 选中第二条品检批次 → 尊重选择（此前会打在 B_A 上）
    const second = scope.run(() => mountActions({}, twoInspections, 'B_B'))!;
    expect(second.inspectionBatch.value?.id).toBe('B_B');
    await second.actions.onPassInspection();
    await second.actions.onFailInspection({ processId: 'p', note: null });
    expect(h.toShip.mock.calls[0]![0]).toBe('B_B');
    expect(h.toShip.mock.calls[0]![1]).toEqual({ version: 22, quantity: null });
    expect(h.toProcess.mock.calls[0]![0]).toBe('B_B');
    expect(h.toProcess.mock.calls[0]![1]).toMatchObject({ version: 22 });
    scope.stop();
  });

  it('A7d：选中的是**非**品检批次时回落到 find(INSPECTION)，且按钮组显示的锚随之变化', () => {
    const scope = effectScope();
    const batches: PartBatch[] = [
      makeBatch({ id: 'B_PENDING', batch_label: 'B1', status: 'PENDING' }),
      makeBatch({ id: 'B_INSPECT', batch_label: 'B2', status: 'INSPECTION' }),
    ];
    const { inspectionBatch } = scope.run(() => mountActions({}, batches, 'B_PENDING'))!;
    // 静默回落是**正确**的：用户选中的不是品检批次，本来就不该把品检流转打到它身上；
    // 按钮组与弹窗都显式展示「目标批次 X」（`PartActionBar.vue` 的 .inspection-anchor /
    // `PartFailInspectionDialog.vue` 的「目标批次」表单项），所以这个回落在界面上是
    // 看得见的，不是暗改。
    expect(inspectionBatch.value?.id).toBe('B_INSPECT');
    scope.stop();
  });

  it('A7b：没有 INSPECTION 批次 ⇒ 两个品检动作都拒绝且不发请求', async () => {
    const scope = effectScope();
    const none: PartBatch[] = [makeBatch({ id: 'B1', status: 'IN_PROCESS' })];
    const { actions } = scope.run(() => mountActions({}, none))!;

    expect(await actions.onPassInspection()).toBe(false);
    expect(await actions.onFailInspection({ processId: 'p', note: null })).toBe(false);
    expect(h.toShip).not.toHaveBeenCalled();
    expect(h.toProcess).not.toHaveBeenCalled();
    expect(h.msg.warning).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  // batch_id 走 body 且是**字符串**；version / quantity 是**裸 number**。后端逐字段挂了各自
  // 的反序列化器，发错一档都是 HTTP 422 纯文本（响应里没有 code）。
  it('A8：拆批 body 的 wire 形状（batch_id 字符串 / version、quantity 裸 number）', async () => {
    const scope = effectScope();
    const { actions, batches } = scope.run(() => mountActions())!;
    const batch = batches.value[0]!;
    const result = await actions.onSplitBatch(batch, 2);

    expect(h.splitBatch.mock.calls[0]![0]).toEqual({
      batch_id: batch.id,
      quantity: 2,
      version: 7,
    });
    expect(typeof (h.splitBatch.mock.calls[0]![0] as { batch_id: unknown }).batch_id).toBe(
      'string',
    );
    expect(result?.new_batch_id).toBe('3000000000003');
    scope.stop();
  });

  it('A9：文件不动 —— composable 不 import vue-router（跳转由 shell 决定）', async () => {
    // 静态守卫：actions 文件里若出现 vue-router 的 import，这条会红。
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../usePartDetailActions.ts', import.meta.url).pathname, 'utf8'),
    );
    expect(src).not.toMatch(/from ['"]vue-router['"]/);
  });
});
