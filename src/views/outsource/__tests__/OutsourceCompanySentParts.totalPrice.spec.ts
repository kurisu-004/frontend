// @vitest-environment happy-dom
// src/views/outsource/__tests__/OutsourceCompanySentParts.totalPrice.spec.ts
//
// 外协对账页「总价」链路的三个纯逻辑守卫 —— `displayTotalPrice`（列显示源）/
// `summaryMethod`（合计行求和口径）/ `saveEdit`（行内保存的 payload 与 OCC 锚）。
//
// 为什么锁这三处：`total_price` 的真源是**后端直出**（`OutsourceSentPartItemSchema.
// total_price`）。这个承诺的核心是「全链路只认后端值」——列 / 合计行 / 保存三处必须
// 口径一致：任一处偷偷退回前端二次推导，对账单上的数字就会和后端算的不一致，且是纯
// 展示层的静默偏差（不报错、不空表格）。
//
// 2026-10-09：被测对象从 `<script setup>` 顶层绑定改为 composable
// `useOutsourceSentPartsPage`（页面状态整体搬进 composable 后组件顶层不再暴露这三个
// 函数）。保存后的「就地回填」也一并删除 —— 行内保存改为失效
// `invalidateOutsourceSentPartsAll` 拿后端权威值，前端不再自己算一遍总价冒充真相
// （自算的浮点末位与后端 Decimal 串对不上时，对账单上的数字会与库存系统不一致）。
//
// 依赖处理沿本仓其它 spec 同款：列可见性（依赖 pinia）与列拖动（依赖 vue-draggable-plus）
// 与被测逻辑无关，整体桩掉；ElMessage 桩成 no-op。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/composables/useColumnVisibility', () => ({
  useColumnVisibility: () => ({
    currentMap: {},
    isVisible: () => true,
    toggle: vi.fn(),
    update: vi.fn(),
    showAll: vi.fn(),
    hideAll: vi.fn(),
    allKeys: [] as string[],
  }),
  resolveDraggable: () => true,
}));

vi.mock('@/composables/useCustomerTree', () => ({
  useCustomerTree: () => ({ tree: ref([]) }),
}));

vi.mock('@/composables/queries/useProcessesQuery', () => ({
  useProcessesQuery: () => ({ data: ref({ items: [] }) }),
}));

const reconcileUpdateShipmentMock = vi.fn();
const invalidateSpy = vi.fn(() => Promise.resolve());

vi.mock('@/api/outsource', () => ({
  reconcileUpdateShipment: (...args: unknown[]) => reconcileUpdateShipmentMock(...args),
  listCompanySentParts: vi.fn(async () => ({
    outsource_company_id: 'C1',
    outsource_company_name: '外协厂',
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
  })),
}));

import { useOutsourceSentPartsPage } from '../composables/useOutsourceSentPartsPage';
import type { OutsourceSentPartItemSchema } from '../composables/outsourceListSchema';

/** 一行合法对账记录（16 字段全填，照后端 `OutsourceSentPartOut`）。 */
function row(overrides: Partial<OutsourceSentPartItemSchema> = {}): OutsourceSentPartItemSchema {
  return {
    shipment_id: 'S1',
    version: 3,
    part_drawing_no: 'DWG-1',
    part_name: '零件甲',
    customer_path: '一级/二级',
    batch_no: 2,
    process_id: 'PR1',
    process_name: '外协工序',
    quantity: 3,
    unit_price: '10.00',
    total_price: '30.00',
    sent_at: '2026-10-01T08:00:00',
    received_at: null,
    status: 'OUTSOURCING',
    is_billed: false,
    is_urgent: false,
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 在 effectScope 里跑一遍 composable（拿到真实 useQuery / useMutation 生命周期）。 */
function setup(): ReturnType<typeof useOutsourceSentPartsPage> {
  const scope = effectScope();
  let page!: ReturnType<typeof useOutsourceSentPartsPage>;
  scope.run(() => {
    page = testApp.runWithContext(() => useOutsourceSentPartsPage('C1'));
  });
  return page;
}

beforeEach(() => {
  reconcileUpdateShipmentMock.mockReset();
  reconcileUpdateShipmentMock.mockResolvedValue(undefined);
  invalidateSpy.mockClear();
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testQueryClient.invalidateQueries = invalidateSpy as never;
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
});

describe('displayTotalPrice：总价列的显示源', () => {
  // 真源承诺：非编辑态**原样**展示后端值，绝不用 q × p 覆盖。
  it('P1：非编辑态 → 原样返回后端 total_price（不做前端二次推导）', () => {
    const page = setup();
    // fixture 的 total_price 故意 ≠ q × p（3 × 10 = 30.00，这里给 30.50），
    // 否则「读后端值」与「前端重算碰巧相等」不可区分。
    expect(page.edit.displayTotalPrice(row({ total_price: '30.50' }))).toBe('30.50');
  });

  it('P2：非编辑态下改数量也不影响显示（编辑缓冲不串到别的行）', () => {
    const page = setup();
    // 缓冲里留着脏值：非编辑行不得被它带偏。
    page.edit.editBuffer.quantity = 999;
    page.edit.editBuffer.unit_price = 999;
    expect(page.edit.displayTotalPrice(row({ total_price: '30.50' }))).toBe('30.50');
  });

  it('P3：编辑态 + 缓冲与原值一致 → 仍走后端值（避免浮点误差与 Decimal 末位对不上）', () => {
    const page = setup();
    const r = row({ total_price: '30.50' });
    page.edit.editingId.value = r.shipment_id;
    page.edit.editBuffer.unit_price = Number(r.unit_price);
    page.edit.editBuffer.quantity = r.quantity;
    expect(page.edit.displayTotalPrice(r)).toBe('30.50');
  });

  it('P4：编辑态 + 改了数量 → 用缓冲实时重算（操作员敲数字时能看到总价变化）', () => {
    const page = setup();
    const r = row();
    page.edit.editingId.value = r.shipment_id;
    page.edit.editBuffer.unit_price = Number(r.unit_price);
    page.edit.editBuffer.quantity = 5;
    expect(page.edit.displayTotalPrice(r)).toBe('50.00');
  });

  it('P5：编辑态 + 改了单价 → 用缓冲实时重算', () => {
    const page = setup();
    const r = row();
    page.edit.editingId.value = r.shipment_id;
    page.edit.editBuffer.unit_price = 12.5;
    page.edit.editBuffer.quantity = r.quantity;
    expect(page.edit.displayTotalPrice(r)).toBe('37.50');
  });

  // 只重算「本行」：编辑 A 行时 B 行的总价不能被 A 的缓冲带偏。
  it('P6：编辑态只影响本行（另一行仍走自己的后端值）', () => {
    const page = setup();
    const editing = row();
    const other = row({ shipment_id: 'S2', total_price: '99.00' });
    page.edit.editingId.value = editing.shipment_id;
    page.edit.editBuffer.unit_price = 1;
    page.edit.editBuffer.quantity = 1;
    expect(page.edit.displayTotalPrice(other)).toBe('99.00');
  });

  // 缓冲被改成非正数时不能算出「-30.00」或除零噪声，直接给占位符。
  it('P7：编辑态缓冲非法（非正数量）→ 显示占位符而不是算出的垃圾数', () => {
    const page = setup();
    const r = row({ total_price: '30.50' });
    page.edit.editingId.value = r.shipment_id;
    page.edit.editBuffer.unit_price = Number(r.unit_price);
    page.edit.editBuffer.quantity = 0;
    expect(page.edit.displayTotalPrice(r)).toBe('—');
    page.edit.editBuffer.quantity = r.quantity;
    expect(page.edit.displayTotalPrice(r)).toBe('30.50');
  });
});

describe('summaryMethod：合计行求和口径', () => {
  const COLUMNS = [{ label: '图号' }, { label: '数量' }, { label: '总价' }];

  it('P8：逐行累加后端 total_price（不重算 q × p）', () => {
    const page = setup();
    // 两行的 q × p 分别是 30.00 / 12.00（合计 42.00），后端值合计是 42.50。
    const out = page.summaryMethod({
      columns: COLUMNS,
      data: [row({ total_price: '30.50' }), row({ shipment_id: 'S2', total_price: '12.00' })],
    });
    expect(out[2]).toBe('42.50');
  });

  it('P9：首列显示本页条数，总价列给求和，其余列空串（列序由 label 定位）', () => {
    const page = setup();
    const out = page.summaryMethod({
      // 总价列不在 index 2 —— 证明是按 label 定位而不是按下标硬取。
      columns: [{ label: '图号' }, { label: '单价' }, { label: '数量' }, { label: '总价' }],
      data: [row()],
    });
    expect(out).toEqual(['合计（本页 1 条）', '', '', '30.00']);
  });

  it('P10：空数据 → 合计行不抛（求和初值 0，格式化成 "0.00"）', () => {
    const page = setup();
    const out = page.summaryMethod({ columns: COLUMNS, data: [] });
    expect(out[2]).toBe('0.00');
    expect(out[0]).toBe('合计（本页 0 条）');
  });
});

describe('saveEdit：行内保存的 payload 与 OCC 锚', () => {
  // ⚠️ version 是硬约束：`POST /outsource-shipments/{id}/reconcile-update` 的
  // `version` 无 `#[serde(default)]` ⇒ 漏传是后端 HTTP 422 纯文本。
  it('P11：改数量后保存 → payload 带 version（shipment 的 OCC 锚）+ 三个可编辑字段', async () => {
    const page = setup();
    const r = row();
    page.edit.editBuffer.unit_price = null;
    page.edit.editBuffer.quantity = 5;
    page.edit.editBuffer.is_billed = true;

    await page.edit.saveEdit(r);

    expect(reconcileUpdateShipmentMock).toHaveBeenCalledWith('S1', {
      version: 3,
      unit_price: null,
      quantity: 5,
      is_billed: true,
    });
  });

  it('P12：保存成功后失效对账域（拿后端权威值，前端不自己算总价冒充真相）', async () => {
    const page = setup();
    const r = row();
    page.edit.editBuffer.quantity = 5;

    await page.edit.saveEdit(r);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['outsource', 'sent-parts'] });
  });

  it('P13：保存成功后退出编辑态（否则行会卡在输入框里）', async () => {
    const page = setup();
    const r = row();
    page.edit.editingId.value = r.shipment_id;

    await page.edit.saveEdit(r);

    expect(page.edit.editingId.value).toBeNull();
  });

  it('P14：非法数量（< 1）→ 不发请求（前端先拦）', async () => {
    const page = setup();
    const r = row();
    page.edit.editBuffer.quantity = 0;

    await page.edit.saveEdit(r);

    expect(reconcileUpdateShipmentMock).not.toHaveBeenCalled();
  });

  it('P15：非法单价（< 0）→ 不发请求', async () => {
    const page = setup();
    const r = row();
    page.edit.editBuffer.unit_price = -1;

    await page.edit.saveEdit(r);

    expect(reconcileUpdateShipmentMock).not.toHaveBeenCalled();
  });

  // 保存失败：弹窗不关、编辑态保留（用户改完能直接重试），且不发失效（没有可刷新的东西）。
  it('P16：保存失败 → 留在编辑态、不失效对账域', async () => {
    const page = setup();
    const r = row();
    reconcileUpdateShipmentMock.mockRejectedValueOnce(new Error('40901 版本冲突'));
    page.edit.editingId.value = r.shipment_id;
    page.edit.editBuffer.quantity = 5;

    await page.edit.saveEdit(r);

    expect(page.edit.editingId.value).toBe(r.shipment_id);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  // 同一时刻只允许一行处于编辑态：跨行双击必须先解决当前行，否则缓冲会被后一行覆盖、
  // 用户以为改的是 A 行。
  it('P17：另一行已在编辑态时双击本行 → 拒绝进入编辑（缓冲不被覆盖）', () => {
    const page = setup();
    page.edit.editingId.value = 'S-OTHER';
    page.edit.editBuffer.quantity = 7;

    page.edit.startEdit(row({ shipment_id: 'S1', quantity: 3 }));

    expect(page.edit.editingId.value).toBe('S-OTHER');
    expect(page.edit.editBuffer.quantity).toBe(7);
  });
});