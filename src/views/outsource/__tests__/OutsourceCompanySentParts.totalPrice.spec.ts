// @vitest-environment happy-dom
// src/views/outsource/__tests__/OutsourceCompanySentParts.totalPrice.spec.ts
//
// 2026-10-03 新增：外协对账页「总价」链路的三个纯函数守卫 ——
// `displayTotalPrice`（列显示源）/ `totalPriceSummary`（合计行求和口径）/
// `saveEdit`（保存后就地回填）。
//
// 为什么锁这三处：本轮把 `total_price` 的真源从「前端 q × p」改成「后端直出」
// （`OutsourceSentPartItem.total_price`）。这个改动的核心承诺是**全链路只认后端值**，
// 列 / 合计行 / 保存回填三处必须口径一致 —— 任一处偷偷退回前端二次推导，对账单上的
// 数字就会和后端算的不一致，且是纯展示层的静默偏差（不报错、不空表格）。
//
// 三条各自的失败形态：
//   · displayTotalPrice 退回无条件 q × p ⇒ Decimal 末位与后端对不上（编辑态尤其明显）
//   · totalPriceSummary 改回 q × p 求和 ⇒ 合计行与「总价」列对不上
//   · saveEdit 漏回填 total_price ⇒ 刚保存完的那一行仍显示旧总价，直到下次 refetch
//
// 依赖处理沿 ShelfList.processMapping.spec.ts：列可见性（依赖 pinia）与列拖动
// （依赖 vue-draggable-plus）与被测逻辑无关，整体桩掉；el-table 走轻量 stub，
// 直接调 `<script setup>` 暴露的函数（同款理由：被测的是这三个函数本身，不是点击链路）。
// ElMessage 桩成 no-op（node/happy-dom 下真实 EP 会碰 document 与内部 normalizeAppendTo）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';

import type { OutsourceSentPartItem } from '@/types/outsource';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  // ElInputNumber / ElSwitch / ElTag 是 columnDefs 的 cellRender 里 h() 直挂的真组件，
  // 换成同名空壳即可（stub 转发的 props 不会被 cellRender 读）。
  ElInputNumber: { name: 'ElInputNumber', template: '<i class="mock-num" />' },
  ElSwitch: { name: 'ElSwitch', template: '<i class="mock-switch" />' },
  ElTag: { name: 'ElTag', template: '<span class="mock-tag"><slot /></span>' },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'C1' } }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/composables/useColumnVisibility', () => ({
  useColumnVisibility: () => ({
    currentMap: reactive<Record<string, boolean>>({}),
    isVisible: () => true,
    toggle: vi.fn(),
    update: vi.fn(),
    showAll: vi.fn(),
    hideAll: vi.fn(),
    allKeys: [] as string[],
  }),
  resolveDraggable: () => true,
}));

vi.mock('@/composables/useColumnDrag', () => ({
  useColumnDrag: () => ({
    orderedKeys: ref<string[]>([]),
    orderedDefs: ref<unknown[]>([]),
    applyDrag: vi.fn(),
    dragLabelClass: () => '',
    reset: vi.fn(),
    clear: vi.fn(),
    isBound: () => false,
  }),
  columnIdentifier: (def: { key: string }) => def.key,
}));

vi.mock('@/composables/useListFilterPersist', () => ({
  useListStatePersist: () => ({ restore: () => null, snapshot: vi.fn(), clear: vi.fn() }),
}));

const reconcileUpdateShipmentMock = vi.fn();
const listCompanySentPartsMock = vi.fn();

vi.mock('@/api/outsource', () => ({
  getOutsourceCompany: vi.fn(async () => ({ id: 'C1', name: '外协厂' })),
  listCompanySentParts: (...args: unknown[]) => listCompanySentPartsMock(...args),
  reconcileUpdateShipment: (...args: unknown[]) => reconcileUpdateShipmentMock(...args),
}));

import OutsourceCompanySentParts from '../OutsourceCompanySentParts.vue';

/** `<script setup>` 的顶层绑定经 VTU proxy 解包后可直接当普通值访问。 */
interface SentPartsVm {
  editingId: string | null;
  editBuffer: { unit_price: number | null; quantity: number | null; is_billed: boolean };
  displayTotalPrice: (row: OutsourceSentPartItem) => string;
  totalPriceSummary: (args: {
    columns: { label: string }[];
    data: OutsourceSentPartItem[];
  }) => string[];
  saveEdit: (row: OutsourceSentPartItem) => Promise<void>;
}

/** 一行合法对账记录（只填三个被测函数关心的字段）。 */
function row(overrides: Partial<OutsourceSentPartItem> = {}): OutsourceSentPartItem {
  return {
    shipment_id: 'S1',
    version: 3,
    quote_id: 'Q1',
    part_id: 'P1',
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

/** 挂载组件并返回 vm（等首屏取数落定）。 */
async function setup(): Promise<{ vm: SentPartsVm }> {
  const wrapper = mount(OutsourceCompanySentParts, {
    global: {
      stubs: { ColumnVisibilityPopover: true, ColumnDragHandle: true },
      directives: { loading: {} },
      components: {
        'el-card': { template: '<div><slot /></div>' },
        'el-button': { template: '<button><slot /></button>' },
        'el-form': { template: '<form><slot /></form>' },
        'el-form-item': { template: '<div><slot /></div>' },
        'el-input': { template: '<input />' },
        'el-date-picker': { template: '<i />' },
        'el-empty': { template: '<i />' },
        'el-table': { template: '<div><slot /></div>' },
        'el-table-column': { template: '<div><slot :row="{}" /></div>' },
      },
    },
  });
  await flushPromises();
  return { vm: wrapper.vm as unknown as SentPartsVm };
}

beforeEach(() => {
  reconcileUpdateShipmentMock.mockReset();
  reconcileUpdateShipmentMock.mockResolvedValue(undefined);
  listCompanySentPartsMock.mockReset();
  listCompanySentPartsMock.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
});

describe('displayTotalPrice：总价列的显示源', () => {
  // 真源承诺：非编辑态**原样**展示后端值，绝不用 q × p 覆盖。
  it('P1：非编辑态 → 原样返回后端 total_price（不做前端二次推导）', async () => {
    const { vm } = await setup();
    // 故意让 q × p 与后端值不同：qty=3、price=10 → q*p=30.00 与 total_price 一致，
    // 换成 total_price='30.50' 才能证明读的是后端值。
    vm.editingId = null;
    expect(vm.displayTotalPrice(row({ total_price: '30.50' }))).toBe('30.50');
  });

  it('P2：非编辑态下改数量也不影响显示（编辑缓冲不串到别的行）', async () => {
    const { vm } = await setup();
    vm.editingId = null;
    // 缓冲里留着脏值：非编辑行不得被它带偏。
    vm.editBuffer.quantity = 999;
    vm.editBuffer.unit_price = 999;
    expect(vm.displayTotalPrice(row({ total_price: '30.50' }))).toBe('30.50');
  });

  it('P3：编辑态 + 缓冲与原值一致 → 仍走后端值（避免浮点误差与 Decimal 末位对不上）', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editingId = r.shipment_id;
    vm.editBuffer.unit_price = Number(r.unit_price);
    vm.editBuffer.quantity = r.quantity;
    expect(vm.displayTotalPrice(r)).toBe(r.total_price);
  });

  it('P4：编辑态 + 改了数量 → 用缓冲实时重算（操作员敲数字时能看到总价变化）', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editingId = r.shipment_id;
    vm.editBuffer.unit_price = Number(r.unit_price);
    vm.editBuffer.quantity = 5;
    expect(vm.displayTotalPrice(r)).toBe('50.00');
  });

  it('P5：编辑态 + 改了单价 → 用缓冲实时重算', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editingId = r.shipment_id;
    vm.editBuffer.unit_price = 12.5;
    vm.editBuffer.quantity = r.quantity;
    expect(vm.displayTotalPrice(r)).toBe('37.50');
  });

  // 只重算「本行」：编辑 A 行时 B 行的总价不能被 A 的缓冲带偏。
  it('P6：编辑态只影响本行（另一行仍走自己的后端值）', async () => {
    const { vm } = await setup();
    const editing = row();
    const other = row({ shipment_id: 'S2', total_price: '99.00' });
    vm.editingId = editing.shipment_id;
    vm.editBuffer.unit_price = 1;
    vm.editBuffer.quantity = 1;
    expect(vm.displayTotalPrice(other)).toBe('99.00');
  });

  // 缓冲被改成非正数时不能算出「-30.00」或除零噪声，直接给占位符。
  it('P7：编辑态缓冲非法（非正数量 / 非有限值）→ 显示占位符而不是算出的垃圾数', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editingId = r.shipment_id;
    vm.editBuffer.unit_price = Number(r.unit_price);
    vm.editBuffer.quantity = 0;
    expect(vm.displayTotalPrice(r)).toBe('—');
    vm.editBuffer.unit_price = Number(r.unit_price);
    vm.editBuffer.quantity = r.quantity;
    expect(vm.displayTotalPrice(r)).toBe(r.total_price);
  });
});

describe('totalPriceSummary：合计行求和口径', () => {
  const COLUMNS = [{ label: '图号' }, { label: '数量' }, { label: '总价' }];

  it('P8：逐行累加后端 total_price（不重算 q × p）', async () => {
    const { vm } = await setup();
    const out = vm.totalPriceSummary({
      columns: COLUMNS,
      // 两行的 q × p 分别是 30.00 / 12.00（合计 42.00），后端值合计是 42.50。
      data: [row({ total_price: '30.50' }), row({ shipment_id: 'S2', total_price: '12.00' })],
    });
    expect(out[2]).toBe('42.50');
  });

  it('P9：首列显示本页条数，总价列给求和，其余列空串（列序由 label 定位）', async () => {
    const { vm } = await setup();
    const out = vm.totalPriceSummary({
      // 总价列不在 index 2 —— 证明是按 label 定位而不是按下标硬取。
      columns: [{ label: '图号' }, { label: '单价' }, { label: '数量' }, { label: '总价' }],
      data: [row()],
    });
    expect(out).toEqual(['合计（本页 1 条）', '', '', '30.00']);
  });

  it('P10：空数据 → 合计行不抛（求和初值 0，格式化成 "0.00"）', async () => {
    const { vm } = await setup();
    const out = vm.totalPriceSummary({ columns: COLUMNS, data: [] });
    expect(out[2]).toBe('0.00');
    expect(out[0]).toBe('合计（本页 0 条）');
  });
});

describe('saveEdit：保存后就地回填', () => {
  // 核心守卫：total_price 必须**一起**回填。不回填的话，displayTotalPrice 在
  // 非编辑态只读 row.total_price ⇒ 刚保存完的这一行显示旧总价，直到下次 refetch。
  it('P11：改数量后保存 → 行内 unit_price / quantity / total_price 一起回填', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editBuffer.unit_price = null;
    vm.editBuffer.quantity = 5;
    vm.editBuffer.is_billed = true;

    await vm.saveEdit(r);

    expect(reconcileUpdateShipmentMock).toHaveBeenCalledWith('S1', {
      version: 3,
      unit_price: null,
      quantity: 5,
      is_billed: true,
    });
    expect(r.quantity).toBe(5);
    expect(r.unit_price).toBe('10.00');
    // 3 → 5，总价必须跟着变成 50.00（而不是停在旧的 30.00）
    expect(r.total_price).toBe('50.00');
    expect(r.is_billed).toBe(true);
    // 版本乐观锁同步 +1，否则下次编辑同一行必撞 40901
    expect(r.version).toBe(4);
  });

  it('P12：改单价后保存 → total_price 用新单价重算', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editBuffer.unit_price = 12.5;
    vm.editBuffer.quantity = null;

    await vm.saveEdit(r);

    expect(r.unit_price).toBe('12.5');
    expect(r.quantity).toBe(3);
    expect(r.total_price).toBe('37.50');
  });

  // 只改对账标记时，total_price 必须按原值重算而不是被 null 打成 0.00。
  it('P13：只改对账标记 → total_price 保持原值（不被 null 打成 0.00）', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editBuffer.unit_price = null;
    vm.editBuffer.quantity = null;
    vm.editBuffer.is_billed = true;

    await vm.saveEdit(r);

    expect(r.total_price).toBe('30.00');
    expect(r.quantity).toBe(3);
  });

  it('P14：非法数量（< 1）→ 不发请求、不动行（前端先拦）', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editBuffer.quantity = 0;
    vm.editBuffer.unit_price = null;
    vm.editBuffer.is_billed = false;

    await vm.saveEdit(r);

    expect(reconcileUpdateShipmentMock).not.toHaveBeenCalled();
    expect(r.quantity).toBe(3);
    expect(r.total_price).toBe('30.00');
  });

  it('P15：非法单价（< 0）→ 不发请求、不动行', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editBuffer.unit_price = -1;
    vm.editBuffer.quantity = null;
    vm.editBuffer.is_billed = false;

    await vm.saveEdit(r);

    expect(reconcileUpdateShipmentMock).not.toHaveBeenCalled();
    expect(r.unit_price).toBe('10.00');
  });

  it('P16：保存成功后退出编辑态（否则行会卡在输入框里）', async () => {
    const { vm } = await setup();
    const r = row();
    vm.editingId = r.shipment_id;
    vm.editBuffer.quantity = 3;
    vm.editBuffer.unit_price = Number(r.unit_price);
    vm.editBuffer.is_billed = false;

    await vm.saveEdit(r);

    expect(vm.editingId).toBeNull();
  });

  it('P17：保存失败 → 不回填、不退出版本（后端没改，前端也不许假装改了）', async () => {
    const { vm } = await setup();
    const r = row();
    reconcileUpdateShipmentMock.mockRejectedValueOnce(new Error('40901 版本冲突'));
    vm.editBuffer.quantity = 5;
    vm.editBuffer.unit_price = null;
    vm.editBuffer.is_billed = false;

    await vm.saveEdit(r);

    expect(r.quantity).toBe(3);
    expect(r.total_price).toBe('30.00');
    expect(r.version).toBe(3);
  });
});
