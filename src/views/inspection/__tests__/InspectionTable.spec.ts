// @vitest-environment happy-dom
// src/views/inspection/__tests__/InspectionTable.spec.ts
//
// 2026-10-03 新增：待品检一览表格组件的**渲染 / 交互契约**回归守卫。三组用例：
//
//  1. 列集：7 个数据列（序列号 / 图号 / 名称 / 批次 / 数量 / 系统交期 / 客户）+ 1 操作列，
//     label 与顺序逐条对齐；7 列全部 `sortable="custom"`（服务端排序）。
//  2. 表头筛选：5 个 popover（序列号 / 图号 / 名称 / 系统交期 / 客户）挂在表头插槽里。
//  3. `@sort-change` 打通到 store → queryKey 变 → refetch 带上新的 sort_by / sort_dir。
//
// 为什么用 EP 模板桩而不是真 el-table：el-table ↔ el-table-column 的插槽作用域协议
// （列的 `{row}` 由 EP 从 table 上下文注入）+ 表头 DOM 结构都不该由本用例复刻 ——
// 被测的是「本组件有没有把 store 的列定义正确地绑到 el-table-column 上，以及
// sort-change 有没有接回 store」，这两件事用桩就能断，且断点清晰（照
// src/views/production/__tests__/ProcessWorkTypeMappingTab.spec.ts 的同款理由）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Directive, VNodeChild } from 'vue';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  // 列定义（src/views/inspection/inspectionColumnDefs.ts）用 h() 直接 import 这几个 EP 组件，
  // 桩成最简可点 / 可渲染形态即可（用例 4 要点「品检通过」按钮）。
  ElButton: {
    name: 'ElButtonStub',
    props: ['link', 'type', 'size', 'loading'],
    emits: ['click'],
    template: '<button class="mock-ep-button" @click="$emit(\'click\')"><slot /></button>',
  },
  ElInput: { name: 'ElInputStub', template: '<input class="mock-ep-input" />' },
  ElDatePicker: { name: 'ElDatePickerStub', template: '<div class="mock-ep-date" />' },
  ElTreeSelect: { name: 'ElTreeSelectStub', template: '<div class="mock-ep-tree" />' },
}));

// 表头 popover / 列拖动手柄 / 列可见性弹窗都是 .vue 组件：桩成可计数 / 可断言的最小壳。
vi.mock('@/components/ColumnFilterPopover.vue', () => ({
  default: {
    name: 'ColumnFilterPopoverStub',
    props: ['label', 'active', 'visible'],
    template: '<div class="mock-cfp" :data-label="label"><slot /></div>',
  },
}));
vi.mock('@/components/ColumnDragHandle.vue', () => ({
  default: { name: 'ColumnDragHandleStub', template: '<i class="mock-drag-handle" />' },
}));
vi.mock('@/components/ColumnVisibilityPopover.vue', () => ({
  default: { name: 'ColumnVisibilityPopoverStub', template: '<div class="mock-cvp" />' },
}));

const listInspectionBatchesMock = vi.fn();
vi.mock('@/api/parts', () => ({
  toShip: vi.fn(),
  toProcess: vi.fn(),
  toInspection: vi.fn(),
}));

// 队列读端点（列表主查询的数据源）来自 `@/api/inspection`。
vi.mock('@/api/inspection', () => ({
  listInspectionBatches: (...args: unknown[]) => listInspectionBatchesMock(...args),
  scanInspection: vi.fn(),
}));

// 共享基础数据层（useCustomerTree / useProductionShelvesQuery / useProcessesQuery）
// 在 store setup 里就 fetch，不桩会走真实 axios。
vi.mock('@/api/customer', () => ({
  listCustomers: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
}));
vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));
vi.mock('@/api/process', () => ({
  listProcesses: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

import InspectionTable from '../components/InspectionTable.vue';
import { useInspectionListStore } from '../composables/useInspectionListStore';
import type { InspectionQueueItem } from '@/api/inspection';

// 后端 wire 形态：total / limit / offset 是 JSON string；item 恰 13 字段。
const ROW: InspectionQueueItem = {
  batch_id: '190000000000001',
  batch_no: 3,
  quantity: 10,
  version: 7,
  part_id: '190000000000101',
  serial_no: 'SN-A',
  drawing_no: 'DWG-A',
  name: '零件 A',
  system_delivery_date: '2026-10-20',
  is_urgent: true,
  customer_id: '9000000000001',
  customer_name: '二级客户',
  l1_customer_name: '一级客户',
};

const LIST_RESULT = { items: [ROW], total: '1', limit: '20', offset: '0' };

/** el-table-column 桩渲染插槽时注入的 row（用例 3 要断 cellRender 的输出）。 */
let slotRow: InspectionQueueItem = ROW;

// ---------------------------------------------------------------- v-loading 桩
// 把模板里 `v-loading` 的每次求值写进宿主元素的 data-loading —— 遮罩判据无论写成什么
// 都不留痕就等于没测。
const loadingDirective: Directive<HTMLElement, boolean> = {
  mounted(el, binding) {
    el.dataset.loading = String(binding.value);
  },
  updated(el, binding) {
    el.dataset.loading = String(binding.value);
  },
};

const globalConfig = {
  directives: { loading: loadingDirective },
  components: {
    'el-button': {
      name: 'ElButton',
      emits: ['click'],
      template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
    },
    'el-empty': { name: 'ElEmpty', template: '<div class="mock-empty" />' },
    'el-table': {
      name: 'ElTable',
      props: ['data', 'rowKey', 'defaultSort', 'rowClassName', 'maxHeight'],
      emits: ['sort-change'],
      template: '<div class="mock-table"><slot name="empty" /><slot /></div>',
    },
    'el-table-column': {
      name: 'ElTableColumn',
      props: [
        'prop',
        'label',
        'type',
        'width',
        'minWidth',
        'fixed',
        'sortable',
        'align',
        'headerAlign',
        'showOverflowTooltip',
        'columnKey',
        'className',
        'labelClassName',
      ],
      setup(props: Record<string, unknown>, { slots }: { slots: Record<string, unknown> }) {
        return () =>
          h(
            'div',
            {
              class: 'mock-column',
              'data-label': String(props.label ?? ''),
              'data-key': String(props.columnKey ?? ''),
              'data-sortable': String(props.sortable ?? ''),
            },
            [
              typeof slots.header === 'function'
                ? (slots.header as (s: unknown) => VNodeChild)({ column: {}, $index: 0 })
                : null,
              typeof slots.default === 'function'
                ? (slots.default as (s: unknown) => VNodeChild)({
                    row: slotRow,
                    column: {},
                    $index: 0,
                  })
                : null,
            ],
          );
      },
    },
  },
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

async function mountTable() {
  // 自己持有 pinia 引用：测试侧要用同一个 pinia 拿到组件内部那个 store 实例
  //（组件 setup 里的 useInspectionListStore() 与测试里的调用必须命中同一实例）。
  const pinia = createPinia();
  setActivePinia(pinia);
  // 名称列的 cellRender 用 RouterLink 渲染详情链接（/parts/{part_id}），必须有 router
  // 注入才能算出 href。空路由表即可 —— 用例只断渲染出来的 href 文本。
  const router = createRouter({ history: createMemoryHistory(), routes: [] });
  const wrapper = mount(InspectionTable, {
    global: {
      ...globalConfig,
      plugins: [
        pinia,
        router,
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
        ],
      ],
    },
  });
  await flushPromises();
  return wrapper;
}

describe('InspectionTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slotRow = ROW;
    listInspectionBatchesMock.mockResolvedValue(LIST_RESULT);
    localStorage.clear();
  });

  it('渲染 7 个数据列 + 1 操作列，label / 顺序与规格一致', async () => {
    const wrapper = await mountTable();
    const labels = wrapper.findAll('.mock-column').map((el) => el.attributes('data-label'));
    expect(labels).toEqual(['序列号', '图号', '名称', '批次', '数量', '系统交期', '客户', '操作']);
    // 列 key / columnKey 与数据字段对上（批次列历史上是 batch_label，已改 batch_no）。
    const keys = wrapper.findAll('.mock-column').map((el) => el.attributes('data-key'));
    expect(keys).toEqual([
      'serial_no',
      'drawing_no',
      'name',
      'batch_no',
      'quantity',
      'system_delivery_date',
      'customer',
      'actions',
    ]);
    wrapper.unmount();
  });

  it('7 个数据列全部 sortable="custom"（服务端排序），操作列不参与排序', async () => {
    const wrapper = await mountTable();
    const cols = wrapper.findAll('.mock-column');
    for (const col of cols.slice(0, 7)) {
      expect(col.attributes('data-sortable')).toBe('custom');
    }
    expect(cols[7]?.attributes('data-sortable')).toBe('');
    wrapper.unmount();
  });

  it('表头挂 5 个筛选 popover（序列号 / 图号 / 名称 / 系统交期 / 客户）', async () => {
    const wrapper = await mountTable();
    const popovers = wrapper.findAll('.mock-cfp').map((el) => el.attributes('data-label'));
    expect(popovers).toEqual(['序列号', '图号', '名称', '系统交期', '客户']);
    // 批次 / 数量 / 操作三列没有表头筛选。
    expect(popovers).toHaveLength(5);
    wrapper.unmount();
  });

  it('cellRender 渲染出名称链接 / 批次 / 系统交期 / 客户派生文本', async () => {
    const wrapper = await mountTable();
    const link = wrapper.find('a.name-link');
    expect(link.exists()).toBe(true);
    // 详情锚是 part_id（VO 没有 id —— 旧版误拼 /parts/undefined）。
    expect(link.attributes('href')).toBe(`/parts/${ROW.part_id}`);
    expect(wrapper.find('.batch-label').text()).toBe('3');
    expect(wrapper.text()).toContain('2026-10-20');
    expect(wrapper.text()).toContain('一级客户 / 二级客户');
    // 操作列三个动作。
    expect(wrapper.findAll('.mock-ep-button').map((b) => b.text())).toEqual([
      '品检通过',
      '指定工序',
      '详情',
    ]);
    wrapper.unmount();
  });

  it('@sort-change 打通到 store：改 sortBy / sortDir 并触发 refetch', async () => {
    const wrapper = await mountTable();
    // 组件自身不调 restoreState（那是壳的职责）—— 测试里手动开 enabled 闸门。
    const store = useInspectionListStore();
    store.query.restoreState();
    await flushPromises();
    await tick();
    listInspectionBatchesMock.mockClear();

    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.exists()).toBe(true);
    // 首屏排序：SYSTEM_DELIVERY_DATE / ASC。
    expect(store.query.sortBy).toBe('SYSTEM_DELIVERY_DATE');
    expect(store.query.sortDir).toBe('ASC');

    table.vm.$emit('sort-change', { prop: 'name', order: 'descending' });
    await flushPromises();
    await tick();

    expect(store.query.sortBy).toBe('NAME');
    expect(store.query.sortDir).toBe('DESC');
    // refetch 带上新排序（queryKey 变 ⇒ useQuery 自动重取）。
    expect(listInspectionBatchesMock).toHaveBeenCalled();
    const params = listInspectionBatchesMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.sort_by).toBe('NAME');
    expect(params.sort_dir).toBe('DESC');
    wrapper.unmount();
  });

  it('工具栏「重置筛选」清空全部列筛选并回第 1 页', async () => {
    const wrapper = await mountTable();
    const store = useInspectionListStore();
    store.query.search.drawingNo = 'DWG-1';
    store.query.page = 3;

    await wrapper.find('.mock-button').trigger('click');

    expect(store.query.search.drawingNo).toBe('');
    expect(store.query.page).toBe(1);
    wrapper.unmount();
  });

  it('加急行走 rowClassName 红底（row-key 用 batch_id，不用死键 id）', async () => {
    const wrapper = await mountTable();
    const table = wrapper.findComponent({ name: 'ElTable' });
    // row-key 传的是函数（取 batch_id），不是字符串 'id'。
    const rowKey = (table.props('rowKey') as (row: InspectionQueueItem) => string) ?? null;
    expect(typeof rowKey).toBe('function');
    expect(rowKey?.(ROW)).toBe(ROW.batch_id);
    const rowClassName = table.props('rowClassName') as (p: { row: InspectionQueueItem }) => string;
    expect(rowClassName({ row: ROW })).toBe('row-urgent');
    expect(rowClassName({ row: { ...ROW, is_urgent: false } })).toBe('');
    wrapper.unmount();
  });
});
