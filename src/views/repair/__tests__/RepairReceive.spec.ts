// @vitest-environment happy-dom
// src/views/repair/__tests__/RepairReceive.spec.ts
//
// 2026-10-03 新增：RepairReceive 的「返修中」判据回归保护。
//
// 为什么要有这个 guard：后端 2026-10-01 起不再产生 `REPAIRING` 状态 —— 返修语义由
// `t_part_batch.is_repairing` 布尔列承载，`/prod/batches/repairing` 返回行的
// `status` **恒为 IN_PROCESS**。组件里两处判据都写成了 `status === 'REPAIRING'`：
//   1. 状态列 tag：`... r.status === 'REPAIRING' ? 'danger' : 'info'`
//      ⇒ 恒不命中，「返修中」Tab 的红 tag 永远不出现；
//   2. 扫码命中过滤（handleScan）⇒ 恒 false，扫中列表里的返修批次直接掉进
//      findPartBySerialAndPrompt 兜底。
// 本测试钉住「判据必须是 is_repairing，且状态列出中文 label 而不是裸 status」。
//
// 断言手法：mount + EP 最小 stub（vitest 配置只挂 vue() 插件、不挂
// unplugin-vue-components ⇒ el-* 组件在测试里解析不到，必须自己注册）。
// 状态列 cellRender 直接从组件实例的 columnDefs 取；扫码链路从 useBarcodeScanner
// 桩里抓 onScan 的 handler 手动驱动。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type VNode } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  listRepairBatches: vi.fn(),
  listRepairingBatches: vi.fn(),
  onScan: vi.fn(),
  findPartBySerialAndPrompt: vi.fn(),
  findAllByCode: vi.fn(),
  scanHandler: null as null | ((code: string) => Promise<void>),
}));

vi.mock('@/api/parts', () => ({
  listRepairBatches: mocks.listRepairBatches,
  listRepairingBatches: mocks.listRepairingBatches,
}));
// ElTag 必须给一个真组件（不是裸对象）：cellRender 里 h(ElTag, …) 的 children 是
// slot 函数，不渲染就拿不到文案。桩里直接渲染成带 data-tag-type 的 span。
vi.mock('element-plus', async () => {
  const { defineComponent: dc, h: hh } = await import('vue');
  return {
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElTag: dc({
      name: 'ElTagStub',
      props: { type: String, size: String, effect: String },
      setup(props, { slots }) {
        return () =>
          hh('span', { class: 'mock-tag', 'data-tag-type': props.type }, slots.default?.());
      },
    }),
  };
});
vi.mock('@/composables/useBarcodeScanner', () => ({
  useBarcodeScanner: () => ({ onScan: mocks.onScan }),
}));
vi.mock('@/utils/scanHelpers', () => ({
  findAllByCode: mocks.findAllByCode,
  findPartBySerialAndPrompt: mocks.findPartBySerialAndPrompt,
}));
// 客户树 / 列显隐 / 列拖动走共享 query 或 DOM 观察器，本测试不关心 ⇒ 桩成空实现。
vi.mock('@/composables/useCustomerTree', () => ({ useCustomerTree: () => ({ tree: [] }) }));
vi.mock('@/composables/useColumnVisibility', () => ({
  useColumnVisibility: () => ({ currentMap: {}, isVisible: () => true }),
  resolveDraggable: () => false,
}));
vi.mock('@/composables/useColumnDrag', () => ({
  useColumnDrag: () => ({
    orderedDefs: { value: [] },
    reset: vi.fn(),
    applyDrag: vi.fn(),
    dragLabelClass: () => '',
  }),
  columnIdentifier: (d: { key: string }) => d.key,
}));
// RepairStartDialog 是 RepairReceive 里的**局部 import** 组件，global.components 压不住，
// 必须模块级 mock —— 它内部的货架过滤 composable 走共享 query（要 VueQueryPlugin），
// 与本测试无关。
vi.mock('../RepairStartDialog.vue', () => ({
  default: { name: 'RepairStartDialogStub', template: '<div class="mock-start-dialog" />' },
}));

import RepairReceive from '../RepairReceive.vue';

/** 返修批次行：`status` 恒 IN_PROCESS，返修语义只在 is_repairing 上。 */
function makeBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: '191000000000001',
    batch_no: 1,
    quantity: 10,
    status: 'IN_PROCESS',
    is_repairing: true,
    serial_no: 'F1016',
    drawing_no: 'DWG-001',
    name: '连杆总成左前',
    customer_path: '南海集团 / 南海路厂区',
    order_no: null,
    next_process_name: null,
    planned_delivery_date: '2026-10-10',
    is_urgent: false,
    current_holder_display: '生产架 A',
    ...overrides,
  };
}

// —— EP 最小 stub ——

/** 透传 default slot 的空壳。 */
const slotOnly = (name: string) =>
  defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', slots.default?.());
    },
  });

/** el-table：只占位（行渲染不参与断言，状态列 cellRender 单独取）。 */
const ElTableStub = defineComponent({
  name: 'ElTableStub',
  setup(_props, { slots }) {
    return () => h('div', { class: 'mock-table' }, slots.default?.());
  },
});

/** el-table-column：el-table 的 scoped slot 需要一个含 row 的 scope 对象，
 *  否则模板里 `#default="{ row }"` 解构 undefined 会抛。 */
const ElTableColumnStub = defineComponent({
  name: 'ElTableColumnStub',
  setup(_props, { slots }) {
    return () => h('div', { class: 'mock-column' }, slots.default?.({ row: {} }));
  },
});

const ElTabsStub = defineComponent({
  name: 'ElTabsStub',
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'mock-tabs', 'data-active': props.modelValue }, slots.default?.());
  },
});

const globalConfig = {
  components: {
    ElTabs: ElTabsStub,
    ElTabPane: slotOnly('ElTabPane'),
    ElCard: slotOnly('ElCard'),
    ElTable: ElTableStub,
    ElTableColumn: ElTableColumnStub,
    ElIcon: slotOnly('ElIcon'),
    ElInput: slotOnly('ElInput'),
    ElButton: slotOnly('ElButton'),
    ElCheckbox: slotOnly('ElCheckbox'),
    ElPopover: slotOnly('ElPopover'),
    ElTreeSelect: slotOnly('ElTreeSelect'),
    ElPagination: slotOnly('ElPagination'),
    ElEmpty: slotOnly('ElEmpty'),
    ColumnVisibilityPopover: slotOnly('ColumnVisibilityPopover'),
    ColumnDragHandle: slotOnly('ColumnDragHandle'),
    RepairStartDialog: slotOnly('RepairStartDialog'),
  },
  directives: { loading: {} },
};

type StatusCellRender = (scope: { row: unknown }) => VNode;

function statusCellRender(wrapper: ReturnType<typeof mount>): StatusCellRender {
  const vm = wrapper.vm as unknown as {
    columnDefs: { key: string; cellRender?: unknown }[];
  };
  const def = vm.columnDefs.find((d) => d.key === 'status');
  if (!def?.cellRender) throw new Error('columnDefs 缺少 status 列或其实 cellRender');
  return def.cellRender as StatusCellRender;
}

/** 渲染状态列 cellRender 返回的 vnode，断言 tag 类型与文案。
 *  cellRender 内部是 h(ElTag, …, () => 文案)，children 是 slot 函数 —— 必须真渲染
 *  才能读到文案。 */
function renderStatusCell(vnode: VNode): { type: string | undefined; text: string } {
  const host = mount(defineComponent({ setup: () => () => h('div', [vnode]) }));
  const tag = host.find('.mock-tag');
  const out = { type: tag.attributes('data-tag-type'), text: tag.text() };
  host.unmount();
  return out;
}

async function mountReceive(): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(RepairReceive, { global: globalConfig });
  await flushPromises();
  return wrapper;
}

describe('RepairReceive — 「返修中」判据必须读 is_repairing（2026-10-03）', () => {
  beforeEach(() => {
    mocks.listRepairBatches.mockReset();
    mocks.listRepairingBatches.mockReset();
    mocks.findPartBySerialAndPrompt.mockReset();
    mocks.findAllByCode.mockReset();
    mocks.scanHandler = null;
    mocks.onScan.mockReset();
    mocks.onScan.mockImplementation((h: (code: string) => Promise<void>) => {
      mocks.scanHandler = h;
      return () => {};
    });
    const empty = { items: [], total: 0 };
    mocks.listRepairBatches.mockResolvedValue(empty);
    mocks.listRepairingBatches.mockResolvedValue(empty);
  });

  it('R1：status 恒为 IN_PROCESS 的行也判成「返修中」，出 danger tag', async () => {
    const wrapper = await mountReceive();
    const cellRender = statusCellRender(wrapper);
    const row = makeBatch();

    // 前提：后端返的就是 status = IN_PROCESS。
    expect(row.status).toBe('IN_PROCESS');
    expect(renderStatusCell(cellRender({ row })).type).toBe('danger');
    wrapper.unmount();
  });

  it('R2：状态列出中文 label（ORDER_STATUS_LABEL），不渲染裸 status', async () => {
    const wrapper = await mountReceive();
    const cellRender = statusCellRender(wrapper);

    expect(
      renderStatusCell(cellRender({ row: makeBatch({ is_repairing: false, status: 'DELIVERED' }) })),
    ).toEqual({ type: 'success', text: '已送货' });
    // 非返修、非已送货的普通在制行仍是 info，且标签回落到 ORDER_STATUS_LABEL。
    expect(
      renderStatusCell(cellRender({ row: makeBatch({ is_repairing: false, status: 'IN_PROCESS' }) })),
    ).toEqual({ type: 'info', text: '生产中' });
    wrapper.unmount();
  });

  it('R2b：is_repairing=true 的行标签出「返修中」而不是 status 的「生产中」', async () => {
    const wrapper = await mountReceive();
    const cellRender = statusCellRender(wrapper);

    // 「返修中」Tab 里的行标签必须与 tab 名一致：标「生产中」语义相反。
    expect(renderStatusCell(cellRender({ row: makeBatch({ status: 'IN_PROCESS' }) }))).toEqual({
      type: 'danger',
      text: '返修中',
    });
    wrapper.unmount();
  });

  it('R3：返修中 Tab 扫码命中按 is_repairing 判 —— 命中则不落兜底', async () => {
    const wrapper = await mountReceive();
    await wrapper.findComponent(ElTabsStub).vm.$emit('update:modelValue', 'repairing');
    await flushPromises();

    mocks.findAllByCode.mockReturnValue([makeBatch()]);
    const scan = mocks.scanHandler;
    expect(scan).toBeTypeOf('function');
    await (scan as (code: string) => Promise<void>)('F1016');
    await flushPromises();

    expect(mocks.findPartBySerialAndPrompt).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('R4：同一 Tab 下 is_repairing=false 的行不命中 → 落 findPartBySerialAndPrompt 兜底', async () => {
    const wrapper = await mountReceive();
    await wrapper.findComponent(ElTabsStub).vm.$emit('update:modelValue', 'repairing');
    await flushPromises();

    mocks.findAllByCode.mockReturnValue([makeBatch({ is_repairing: false })]);
    const scan = mocks.scanHandler as (code: string) => Promise<void>;
    await scan('F9999');
    await flushPromises();

    expect(mocks.findPartBySerialAndPrompt).toHaveBeenCalledWith('F9999');
    wrapper.unmount();
  });

  it('R5：已送货 Tab 仍按 status === DELIVERED 命中（判据没有被连带改坏）', async () => {
    const wrapper = await mountReceive();

    const scan = mocks.scanHandler as (code: string) => Promise<void>;
    mocks.findAllByCode.mockReturnValue([makeBatch({ status: 'DELIVERED', is_repairing: false })]);
    await scan('F1016');
    await flushPromises();

    // 命中已送货行 ⇒ 弹返修 dialog（不进兜底）
    expect(mocks.findPartBySerialAndPrompt).not.toHaveBeenCalled();

    // 反例：已送货 Tab 里 is_repairing=true 但 status 不是 DELIVERED ⇒ 不命中
    mocks.findPartBySerialAndPrompt.mockClear();
    mocks.findAllByCode.mockReturnValue([makeBatch({ status: 'IN_PROCESS' })]);
    await scan('F1016');
    await flushPromises();
    expect(mocks.findPartBySerialAndPrompt).toHaveBeenCalledWith('F1016');
    wrapper.unmount();
  });
});
