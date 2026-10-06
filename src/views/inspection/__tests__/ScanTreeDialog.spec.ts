// @vitest-environment happy-dom
// src/views/inspection/__tests__/ScanTreeDialog.spec.ts
//
// 2026-10-05 新增：扫码树弹窗的**渲染 / 交互契约**回归守卫。9 组用例（16 条）：
//
//  1. 树形结构：装配件树 = 1 个装配件行 + N 个零件行 + 每个零件下 M 个批次行；
//     独立件树没有装配件行。`row-key` 是函数且**按层加前缀**（三层 id 都来自雪花流，
//     跨层撞车会让 el-table 的展开态串行）。
//  2. `tree-props.children` 声明了子节点键（缺了就是平铺、树形失效）。
//  3. 按钮矩阵：INSPECTION → 品检通过 + 指定工序；PENDING / PROGRAMMING / IN_PROCESS
//     → 送检（IN_PROCESS 还要过 location 白名单闸门：只有生产架上才给）；READY_TO_SHIP
//     等其它状态无按钮；装配件 / 零件行不渲染操作按钮。
//  4. 返修守卫：`is_repairing` 的批次行「指定工序」禁用。
//  5. 高亮**三档**（批次层照抄后端 `is_scanned`，不在前端按 hit_kind 反推）：独立件 /
//     装配件**子件**（hit_kind 仍 PART + assembly 非空，只有被扫中那个子件亮）/
//     装配件条码（全不亮）；另断零件层的「被扫中的就是它」（零批次的子件也亮）、
//     以及加急行加 `row-urgent`。
//  6. 展示列：当前位置优先 holder 名，无 holder 退到 location 的中文兜底，
//     都没有给 `—`（不吐枚举原文）；系统交期由批次行从父零件继承。
//  7. emit 载荷：「品检通过」「指定工序」抛的是**批次**行，且 `version` 是
//     `t_part_batch.version`（不是零件节点的 version —— 两个计数器混用必 409）。
//  8. 送检：行内面板选品检架（候选来自 props）+ 数量 → 调 `toInspection`（批次 id +
//     批次 version + 目标架名）；未选品检架时「确认送检」禁用、不发请求；成功后树就地
//     更新（状态 / 当前位置 / 按钮矩阵一起变）。
//  9. 关闭弹窗清树 + 清行内面板态；`v-loading` 绑扫码请求的在飞态。
//
// 为什么用 EP 模板桩而不是真 el-table：el-table ↔ el-table-column 的插槽作用域协议
// （列的 `{row}` 由 EP 从 table 上下文注入）与三层展开都不该由本用例复刻 ——
// 被测的是「本组件有没有把 store 的树摊成正确的三层行、把状态矩阵与操作绑对」。
// 桩按 `data` 的 children 递归渲染每一行的所有列，行内面板展开后确实多出 DOM，
// 所以「点开 → 选货架 → 确认」这条交互也测得到（照
// src/views/inspection/__tests__/InspectionTable.spec.ts 的同款理由）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computed,
  defineComponent,
  h,
  inject,
  provide,
  type Directive,
  type Ref,
  type VNodeChild,
} from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { ScanPartOut, ScanTreeOut } from '@/api/inspection';
import type { Shelf } from '@/types/shelf';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const toInspectionMock = vi.fn();
vi.mock('@/api/parts', () => ({
  toShip: vi.fn(),
  toProcess: vi.fn(),
  toInspection: (...args: unknown[]) => toInspectionMock(...args),
}));
const scanInspectionMock = vi.fn();
vi.mock('@/api/inspection', () => ({
  scanInspection: (...args: unknown[]) => scanInspectionMock(...args),
  listInspectionBatches: vi.fn(async () => ({
    items: [],
    total: '0',
    limit: '20',
    offset: '0',
  })),
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));
vi.mock('@/api/process', () => ({
  listProcesses: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));
vi.mock('@/api/customer', () => ({
  listCustomers: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  softDeleteCustomer: vi.fn(),
}));

import ScanTreeDialog from '../components/ScanTreeDialog.vue';
import { useInspectionListStore } from '../composables/useInspectionListStore';

// ---------------------------------------------------------------- 数据（后端 wire 形态）
const ASSEMBLY = {
  id: '9000000000001',
  serial_no: 'F1006',
  name: '装配件 A',
  drawing_no: 'ASM-DWG',
  status: 'IN_PROCESS',
  quantity: 20,
  is_urgent: true,
  system_delivery_date: '2026-10-20',
  customer_name: '二级客户',
};

const PART_A = {
  id: '9000000000011',
  serial_no: 'F1006-01',
  name: '子件 01',
  drawing_no: 'DWG-01',
  status: 'IN_PROCESS',
  quantity: 10,
  is_urgent: false,
  system_delivery_date: '2026-10-20',
  customer_name: '二级客户',
  // 零件的 version 是 t_part.version，与批次的 version 是两个计数器（用例 6 断这个）。
  version: 3,
  children: [
    {
      id: '9000000000101',
      batch_no: 1,
      quantity: 10,
      status: 'INSPECTION',
      version: 7,
      is_repairing: false,
      location: 'INSPECTION_SHELF',
      current_holder_display: 'SH-I01',
      process_name: null,
      is_scanned: true,
    },
    {
      id: '9000000000102',
      batch_no: 2,
      quantity: 5,
      status: 'READY_TO_SHIP',
      version: 2,
      is_repairing: false,
      location: null,
      current_holder_display: null,
      process_name: null,
      // 后端 `is_scanned = (批次所属零件 == 扫中的零件)`，与批次状态无关：只要批次属于
      // 被扫中的那个零件就 true，哪怕它已经 READY_TO_SHIP。所以独立件树 / 扫子件那两档
      // 里，被扫零件的**全部**批次都是 true（含终态批次）。
      is_scanned: true,
    },
  ],
};

const PART_B = {
  ...PART_A,
  id: '9000000000012',
  serial_no: 'F1006-02',
  name: '子件 02',
  version: 4,
  children: [
    {
      id: '9000000000103',
      batch_no: 1,
      quantity: 6,
      status: 'PENDING',
      version: 1,
      is_repairing: false,
      location: null,
      current_holder_display: null,
      process_name: null,
      is_scanned: false,
    },
  ],
};

/** 把某个零件节点下所有批次的 is_scanned 抹成 false（扫装配件条码那一档的 wire 形态）。 */
function withNoScan(part: ScanPartOut): ScanPartOut {
  return { ...part, children: part.children.map((b) => ({ ...b, is_scanned: false })) };
}

/** 扫到装配件条码：顶层带 assembly，各行 is_scanned 全 false（命中的是装配件本身，
 *  它自己没有批次 ⇒ 后端无批次可标）。 */
const TREE_ASSEMBLY: ScanTreeOut = {
  hit_kind: 'ASSEMBLY',
  scanned_serial_no: 'F1006',
  assembly: ASSEMBLY,
  children: [withNoScan(PART_A), withNoScan(PART_B)],
};

/** 扫到子件条码：没有 assembly，顶层就是零件数组。 */
const TREE_PART: ScanTreeOut = {
  hit_kind: 'PART',
  scanned_serial_no: 'F1006-01',
  assembly: null,
  children: [PART_A],
};

/** 扫到**装配件的子件**条码（产线最常见的一档）：hit_kind 仍是 'PART'，但 assembly
 *  非空 ⇒ 树里带装配件根行 + 全部兄弟子件，只有被扫中那个子件的批次 is_scanned=true。 */
const TREE_ASSEMBLY_CHILD: ScanTreeOut = {
  hit_kind: 'PART',
  scanned_serial_no: 'F1006-01',
  assembly: ASSEMBLY,
  children: [PART_A, PART_B],
};

const SHELVES = [
  { id: '9000000000501', code: 'SH-I01', name: '品检架 1', zone: 'INSPECTION', is_active: true },
  { id: '9000000000502', code: 'SH-I02', name: '品检架 2', zone: 'INSPECTION', is_active: true },
] as Shelf[];

// ---------------------------------------------------------------- EP 桩
// 行上下文：el-table 逐行 provide 当前行、el-table-column 从 inject 取（复刻 EP 的
// 「列的 {row} 由 table 上下文注入」协议，但不碰 EP 的展开 / 选择态实现）。
const ROW_CTX = Symbol('scan-tree-row');
const SET_VALUE = Symbol('scan-tree-set-value');

interface StubRow {
  node_kind: string;
  id: string;
  status: string;
  is_scanned: boolean;
  quantity: number;
  children: StubRow[];
}

const MockRow = defineComponent({
  name: 'MockRow',
  props: {
    row: { type: Object, required: true },
    rowKey: { type: Function, default: null },
    rowClassName: { type: Function, default: null },
    depth: { type: Number, default: 0 },
  },
  setup(props, { slots }) {
    // provide 的值走 computed 而非 props.row 本身：vue/no-setup-props-destructure
    // 禁止在 setup 根作用域读 props（会丢响应式）。
    provide(
      ROW_CTX,
      computed(() => props.row),
    );
    return () =>
      h(
        'div',
        {
          class: ['mock-row', props.rowClassName?.({ row: props.row }) ?? ''],
          'data-key': props.rowKey ? String(props.rowKey(props.row)) : '',
          'data-kind': String(props.row.node_kind),
          'data-status': String(props.row.status),
        },
        [h('span', { class: 'mock-depth' }, String(props.depth)), slots.cells?.()],
      );
  },
});

const MockElTable = defineComponent({
  name: 'ElTable',
  props: {
    data: { type: Array, default: () => [] },
    rowKey: { type: Function, default: null },
    rowClassName: { type: Function, default: null },
    treeProps: { type: Object, default: null },
    // 2026-10-06：弹窗改定宽后表格高度由 `height="calc(100vh - 220px)"`
    // 换成 `max-height="52vh"`，此处补上声明以便断言（未声明会落进 attrs，
    // `props('maxHeight')` 取不到）。
    maxHeight: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    const render = (rows: StubRow[], depth: number): VNodeChild[] =>
      rows.flatMap((row) => [
        h(
          MockRow,
          { row, rowKey: props.rowKey, rowClassName: props.rowClassName, depth },
          // 具名 slot：MockRow 从 `slots.cells` 取列内容（h() 的第 3 参传函数会落进
          // **default** slot，`slots.cells` 会是 undefined）。
          { cells: () => slots.default?.() },
        ),
        ...render(row.children ?? [], depth + 1),
      ]);
    return () => h('div', { class: 'mock-table' }, render(props.data as StubRow[], 0));
  },
});

const MockElTableColumn = defineComponent({
  name: 'ElTableColumn',
  props: ['prop', 'label', 'minWidth', 'width', 'fixed', 'align'],
  setup(props, { slots }) {
    const rowRef = inject<Ref<StubRow>>(ROW_CTX);
    return () =>
      h('div', { class: 'mock-column', 'data-label': String(props.label ?? '') }, [
        typeof slots.default === 'function'
          ? (slots.default as (s: unknown) => VNodeChild)({
              row: rowRef?.value ?? {},
              column: {},
              $index: 0,
            })
          : null,
      ]);
  },
});

const MockElDialog = defineComponent({
  name: 'ElDialog',
  // 只声明与用例交互的 props。`width` / `top` / `fullscreen` **故意不声明** ——
  // 未声明的属性会 fall through 成根元素上的原生 attribute，于是
  // 「弹窗是否 fullscreen / 宽度多少」在测试里可直接断言
  // （`dialog.attributes('fullscreen')` 有值 = 退回了全屏，见「弹窗非全屏」用例）。
  props: ['modelValue', 'title', 'closeOnClickModal'],
  emits: ['update:modelValue', 'closed'],
  setup(props, { slots }) {
    return () =>
      h('div', { class: 'mock-dialog' }, [
        h('div', { class: 'mock-dialog-title' }, String(props.title ?? '')),
        slots.default?.(),
        slots.footer?.(),
      ]);
  },
});

// `inheritAttrs: false` 是必需的：不关掉的话 `onClick` 既被本桩手动调用、又作为
// 根元素上的原生监听被绑定 ⇒ 一次点击触发两次（面板会被立刻收起 / emit 两次）。
const ElButtonStub = defineComponent({
  name: 'ElButton',
  inheritAttrs: false,
  props: ['type', 'size', 'disabled', 'loading'],
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          class: ['mock-button', `mock-button-${props.type ?? 'default'}`],
          disabled: Boolean(props.disabled),
          onClick: () => {
            if (props.disabled) return;
            (attrs.onClick as (() => void) | undefined)?.();
          },
        },
        slots.default?.(),
      );
  },
});

// v-model 编译成 `modelValue` prop + `onUpdate:modelValue` attr（本桩不声明 emits，
// 故回调从 attrs 取）。option 桩是本组件 slot 的子节点 —— Vue 的 provide/inject 走
// 实例树，slot 内容挂在渲染它的那个组件之下，故 option 能 inject 到这里的 provide。
const MockElSelect = defineComponent({
  name: 'ElSelect',
  inheritAttrs: false,
  props: ['modelValue', 'placeholder', 'size', 'filterable', 'clearable'],
  setup(props, { slots, attrs }) {
    const attrsRecord: Record<string, unknown> = attrs;
    const update = attrsRecord['onUpdate:modelValue'];
    provide(SET_VALUE, (v: string) => {
      if (typeof update === 'function') update(v);
    });
    return () =>
      h('div', { class: 'mock-select', 'data-value': String(props.modelValue ?? '') }, [
        slots.default?.(),
      ]);
  },
});

const MockElOption = defineComponent({
  name: 'ElOption',
  props: ['value', 'label', 'disabled'],
  setup(props) {
    const setValue = inject<(v: string) => void>(SET_VALUE, () => {});
    return () =>
      h('button', {
        class: 'mock-option',
        'data-value': String(props.value),
        onClick: () => setValue(String(props.value)),
      });
  },
});

const MockElInputNumber = defineComponent({
  name: 'ElInputNumber',
  props: ['modelValue', 'min', 'max', 'precision', 'size', 'controlsPosition'],
  setup(props) {
    return () =>
      h('div', {
        class: 'mock-input-number',
        'data-model': String(props.modelValue ?? ''),
        'data-max': String(props.max ?? ''),
      });
  },
});

// v-loading 桩：把每次求值写进宿主的 data-loading。遮罩判据不落痕等于没测
// （照 InspectionTable.spec.ts 的同款桩法）。
const loadingDirective: Directive<HTMLElement, unknown> = {
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
    'el-dialog': MockElDialog,
    'el-table': MockElTable,
    'el-table-column': MockElTableColumn,
    'el-button': ElButtonStub,
    'el-tag': defineComponent({
      name: 'ElTag',
      setup(_p, { slots }) {
        return () => h('span', { class: 'mock-tag' }, slots.default?.());
      },
    }),
    'el-tooltip': defineComponent({
      name: 'ElTooltip',
      setup(_p, { slots }) {
        return () => h('span', { class: 'mock-tooltip' }, slots.default?.());
      },
    }),
    'el-select': MockElSelect,
    'el-option': MockElOption,
    'el-input-number': MockElInputNumber,
  },
};

async function mountDialog(tree: ScanTreeOut) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(ScanTreeDialog, {
    props: { modelValue: true, inspectionShelves: SHELVES },
    global: {
      ...globalConfig,
      plugins: [
        pinia,
        [
          VueQueryPlugin,
          { queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }) },
        ],
      ],
    },
  });
  const store = useInspectionListStore();
  // 深拷贝后再进 store：写后本地回写会就地改树（改的就是 store 里那个对象），
  // 共享同一份 module 级常量会让用例之间互相污染。
  store.mutations.scanTree = structuredClone(tree) as ScanTreeOut;
  await flushPromises();
  return { wrapper, store };
}

/** 按 row-key 找一行（`data-key` = `${node_kind}_${id}`）。 */
function rowBy(wrapper: ReturnType<typeof mount>, key: string) {
  return wrapper.findAll('.mock-row').find((r) => r.attributes('data-key') === key);
}

describe('ScanTreeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toInspectionMock.mockResolvedValue({ part: {}, new_batch_id: null });
  });

  it('装配件树：1 个装配件行 + 零件行 + 批次行，row-key 按层加前缀', async () => {
    const { wrapper } = await mountDialog(TREE_ASSEMBLY);
    const rows = wrapper.findAll('.mock-row');
    expect(rows.map((r) => r.attributes('data-key'))).toEqual([
      'ASSEMBLY_9000000000001',
      'PART_9000000000011',
      'BATCH_9000000000101',
      'BATCH_9000000000102',
      'PART_9000000000012',
      'BATCH_9000000000103',
    ]);
    // 层级：装配件(0) → 零件(1) → 批次(2)。
    expect(rows.map((r) => r.find('.mock-depth').text())).toEqual(['0', '1', '2', '2', '1', '2']);
    expect(wrapper.find('.mock-dialog-title').text()).toContain('装配件 / 子零件 / 批次');
    wrapper.unmount();
  });

  it('tree-props 声明 children 子节点键（缺了就是平铺、树形失效）', async () => {
    const { wrapper } = await mountDialog(TREE_ASSEMBLY);
    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.props('treeProps')).toEqual({ children: 'children' });
    wrapper.unmount();
  });

  // 2026-10-06：用户要求「扫码后弹出的批次列表不要全屏显示」。定宽后 10 列
  // （min-width 合计约 1370px）放不下，横向滚动由 el-table 自身承接 ——
  // 序列号列 fixed="left"、操作列 fixed="right"，滚动时两端始终可见。
  it('弹窗非全屏：带定宽 width，且不带 fullscreen 属性', async () => {
    const { wrapper } = await mountDialog(TREE_ASSEMBLY);
    const dlg = wrapper.find('.mock-dialog');
    expect(dlg.exists()).toBe(true);
    // MockElDialog 故意不声明 width / fullscreen，未声明的属性会 fall through
    // 成根元素 attribute —— 所以「没有 fullscreen」在这里是可直接观测的。
    expect(dlg.attributes('fullscreen')).toBeUndefined();
    expect(dlg.attributes('width')).toBe('1200');
    // 表格高度用 max-height（行数少时按内容收缩），不再是 fullscreen 专属的
    // height="calc(100vh - 220px)"。
    const table = wrapper.findComponent({ name: 'ElTable' });
    expect(table.props('maxHeight')).toBe('52vh');
    wrapper.unmount();
  });

  it('独立件树：没有装配件行，顶层直接是零件行', async () => {
    const { wrapper } = await mountDialog(TREE_PART);
    expect(wrapper.findAll('.mock-row').map((r) => r.attributes('data-key'))).toEqual([
      'PART_9000000000011',
      'BATCH_9000000000101',
      'BATCH_9000000000102',
    ]);
    wrapper.unmount();
  });

  it('按钮矩阵：INSPECTION → 品检通过 + 指定工序；PENDING → 送检；其它状态无按钮', async () => {
    const { wrapper } = await mountDialog(TREE_ASSEMBLY);
    // INSPECTION 批次 → 两个按钮。
    const inspectionRow = rowBy(wrapper, 'BATCH_9000000000101');
    expect(inspectionRow?.findAll('button').map((b) => b.text())).toEqual(['品检通过', '指定工序']);
    // READY_TO_SHIP → 没有任何按钮（只有 '—' 占位）。
    const readyRow = rowBy(wrapper, 'BATCH_9000000000102');
    expect(readyRow?.findAll('button')).toHaveLength(0);
    expect(readyRow?.text()).toContain('—');
    // PENDING → 只有「送检」。
    const pendingRow = rowBy(wrapper, 'BATCH_9000000000103');
    expect(pendingRow?.findAll('button').map((b) => b.text())).toEqual(['送检']);
    // 装配件 / 零件行不渲染操作按钮。
    expect(rowBy(wrapper, 'PART_9000000000011')?.findAll('button')).toHaveLength(0);
    expect(rowBy(wrapper, 'ASSEMBLY_9000000000001')?.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('is_repairing 的批次：指定工序禁用 + tooltip 说明', async () => {
    const tree: ScanTreeOut = {
      hit_kind: 'PART',
      scanned_serial_no: 'F1006-01',
      assembly: null,
      children: [
        {
          ...PART_A,
          children: [{ ...PART_A.children[0], status: 'INSPECTION', is_repairing: true }],
        },
      ],
    };
    const { wrapper } = await mountDialog(tree);
    const row = rowBy(wrapper, 'BATCH_9000000000101');
    const assignBtn = row?.findAll('button')[1];
    expect(assignBtn?.text()).toBe('指定工序');
    expect(assignBtn?.attributes('disabled')).toBeDefined();
    // 返修说明挂在 tooltip 上。
    expect(row?.findAll('.mock-tooltip')).toHaveLength(1);
    // 禁用态不 emit。
    await assignBtn?.trigger('click');
    expect(wrapper.emitted('assignProcess')).toBeUndefined();
    wrapper.unmount();
  });

  it('is_scanned 高亮三档：独立件 / 装配件子件 / 装配件条码，全部照抄后端 flag', async () => {
    // 档 1：扫独立件 —— 树里只有它，零件行 + 它的**全部**批次行都亮（后端判据是
    // 「批次所属零件 == 扫中的零件」，与批次状态无关）。
    const { wrapper } = await mountDialog(TREE_PART);
    const classes = wrapper.findAll('.mock-row').map((r) => r.classes().join(' '));
    expect(classes[0]).toContain('row-scanned'); // 被扫中的零件
    expect(classes[1]).toContain('row-scanned'); // 它的批次 #1
    expect(classes[2]).toContain('row-scanned'); // 它的批次 #2（READY_TO_SHIP 也亮）
    wrapper.unmount();

    // 档 2：扫**装配件的子件**（hit_kind 仍 PART、assembly 非空）—— 装配件根行与
    // 兄弟子件全不亮，只有被扫中那个子件的整棵亮。产线最常见的一档。
    const { wrapper: w2 } = await mountDialog(TREE_ASSEMBLY_CHILD);
    const byKey = (key: string) =>
      w2
        .findAll('.mock-row')
        .find((r) => r.attributes('data-key') === key)
        ?.classes() ?? [];
    expect(byKey('ASSEMBLY_9000000000001')).not.toContain('row-scanned');
    expect(byKey('PART_9000000000011')).toContain('row-scanned'); // 被扫中的子件
    expect(byKey('BATCH_9000000000101')).toContain('row-scanned'); // 它的批次 #1
    // 兄弟子件整棵（零件行 + 它的批次）都不亮 —— 这才是「兄弟不亮」的判据。
    expect(byKey('PART_9000000000012')).not.toContain('row-scanned');
    expect(byKey('BATCH_9000000000103')).not.toContain('row-scanned');
    w2.unmount();

    // 档 3：扫装配件条码 —— 后端全给 false，树上没有任何一行亮。
    const { wrapper: w3 } = await mountDialog(TREE_ASSEMBLY);
    expect(w3.findAll('.mock-row').every((r) => !r.classes().includes('row-scanned'))).toBe(true);
    w3.unmount();
  });

  it('零件层高亮看「被扫中的就是它」：批次一个都没有的子件也亮（零视觉反馈的兜底）', async () => {
    // 2026-10-05：被扫中的子件若还没下发（树里一个批次都没有），按「任一批次被扫中」
    // 反推的旧写法会让整行不亮 —— 扫了码却什么都没有。
    const tree: ScanTreeOut = {
      hit_kind: 'PART',
      scanned_serial_no: 'F1006-01',
      assembly: ASSEMBLY,
      children: [
        { ...PART_A, children: [] }, // 被扫中的子件，零批次
        PART_B, // 兄弟子件
      ],
    };
    const { wrapper } = await mountDialog(tree);
    const byKey = (key: string) =>
      wrapper
        .findAll('.mock-row')
        .find((r) => r.attributes('data-key') === key)
        ?.classes() ?? [];
    expect(byKey('PART_9000000000011')).toContain('row-scanned');
    expect(byKey('PART_9000000000012')).not.toContain('row-scanned');
    wrapper.unmount();
  });

  it('加急行加 row-urgent（照同页 InspectionTable 的红底信号），与扫码高亮可并存', async () => {
    const tree: ScanTreeOut = {
      ...TREE_PART,
      children: [
        {
          ...PART_A,
          is_urgent: true, // 装配件已加急，零件节点是权威来源
          children: [PART_A.children[0], { ...PART_A.children[1], is_scanned: false }],
        },
      ],
    };
    const { wrapper } = await mountDialog(tree);
    // 加急从零件节点摊到它的每一行批次（批次表本身没有该列）。
    const scanned = rowBy(wrapper, 'BATCH_9000000000101');
    expect(scanned?.classes()).toContain('row-urgent');
    // 被扫中 + 加急时两个类都在（底色优先级由样式书写顺序定：扫码高亮写在前者之后）。
    expect(scanned?.classes()).toContain('row-scanned');
    // 未被扫中的批次同样继承加急底色。
    const unscanned = rowBy(wrapper, 'BATCH_9000000000102');
    expect(unscanned?.classes()).toContain('row-urgent');
    expect(unscanned?.classes()).not.toContain('row-scanned');
    // 零件行自己也是加急。
    expect(rowBy(wrapper, 'PART_9000000000011')?.classes()).toContain('row-urgent');
    wrapper.unmount();
  });

  it('当前位置：holder 名优先，无 holder 退到 location 中文，都没有给 —', async () => {
    const tree: ScanTreeOut = {
      ...TREE_PART,
      children: [
        {
          ...PART_A,
          children: [
            PART_A.children[0], // 有 holder → holder 名直出
            { ...PART_A.children[1], location: 'PRODUCTION_SHELF' }, // 无 holder → 中文兜底
            { ...PART_A.children[1], id: '9000000000104', location: 'OUTSOURCE_COMPANY' },
            { ...PART_A.children[1], id: '9000000000105', location: null },
          ],
        },
      ],
    };
    const { wrapper } = await mountDialog(tree);
    const cell = (key: string) =>
      rowBy(wrapper, key)
        ?.findAll('.mock-column')
        .find((c) => c.attributes('data-label') === '当前位置')
        ?.text();
    expect(cell('BATCH_9000000000101')).toBe('SH-I01');
    expect(cell('BATCH_9000000000102')).toBe('生产架');
    expect(cell('BATCH_9000000000104')).toBe('外协');
    // location 与 holder 都没有才给占位符，不吐枚举原文。
    expect(cell('BATCH_9000000000105')).toBe('—');
    expect(cell('PART_9000000000011')).toBe('—');
    wrapper.unmount();
  });

  it('批次行的系统交期从父零件继承（批次表本身没有该列，恒 null 会整列给 —）', async () => {
    const { wrapper } = await mountDialog(TREE_PART);
    const cell = (key: string) =>
      rowBy(wrapper, key)
        ?.findAll('.mock-column')
        .find((c) => c.attributes('data-label') === '系统交期')
        ?.text();
    // 零件行与它的两个批次行都该有交期值。
    expect(cell('PART_9000000000011')).toBe('2026-10-20');
    expect(cell('BATCH_9000000000101')).toBe('2026-10-20');
    expect(cell('BATCH_9000000000102')).toBe('2026-10-20');
    wrapper.unmount();
  });

  it('IN_PROCESS 批次的送检按钮受 location 白名单约束（工人手上的、空的都不给）', async () => {
    const tree: ScanTreeOut = {
      ...TREE_PART,
      children: [
        {
          ...PART_A,
          children: [
            { ...PART_A.children[1], status: 'IN_PROCESS', location: 'PRODUCTION_SHELF' },
            {
              ...PART_A.children[1],
              id: '9000000000104',
              status: 'IN_PROCESS',
              location: 'WORKER',
            },
            // location 为空的老数据同样必被后端拒（20103），不给「注定失败」的按钮。
            { ...PART_A.children[1], id: '9000000000105', status: 'IN_PROCESS', location: null },
            { ...PART_A.children[1], id: '9000000000106', status: 'PENDING', location: 'WORKER' },
          ],
        },
      ],
    };
    const { wrapper } = await mountDialog(tree);
    // IN_PROCESS + PRODUCTION_SHELF → 给送检。
    expect(
      rowBy(wrapper, 'BATCH_9000000000102')
        ?.findAll('button')
        .map((b) => b.text()),
    ).toEqual(['送检']);
    // IN_PROCESS + WORKER → 后端必拒 20103，不给按钮。
    const workerRow = rowBy(wrapper, 'BATCH_9000000000104');
    expect(workerRow?.findAll('button')).toHaveLength(0);
    expect(workerRow?.text()).toContain('—');
    // IN_PROCESS + location 为空 → 同样必拒，不给按钮。
    const nullLocRow = rowBy(wrapper, 'BATCH_9000000000105');
    expect(nullLocRow?.findAll('button')).toHaveLength(0);
    expect(nullLocRow?.text()).toContain('—');
    // 非 IN_PROCESS 状态不受 location 闸门约束。
    expect(
      rowBy(wrapper, 'BATCH_9000000000106')
        ?.findAll('button')
        .map((b) => b.text()),
    ).toEqual(['送检']);
    wrapper.unmount();
  });

  it('「品检通过」「指定工序」emit 的是批次行，且 version 是 t_part_batch.version', async () => {
    const { wrapper } = await mountDialog(TREE_PART);
    const [passBtn, assignBtn] = rowBy(wrapper, 'BATCH_9000000000101')?.findAll('button') ?? [];
    await passBtn?.trigger('click');
    await assignBtn?.trigger('click');
    // 载荷 = 批次 VO（零件的 version 是 3、批次的是 7，两个计数器混用必 409）。
    expect(wrapper.emitted('pass')).toEqual([[PART_A.children[0]]]);
    // 事件名 camelCase（vue/custom-event-name-casing），父组件监听侧写 @assign-process。
    expect(wrapper.emitted('assignProcess')).toEqual([[PART_A.children[0]]]);
    wrapper.unmount();
  });

  it('「送检」：行内面板选品检架 + 数量 → 调 toInspection（批次 id + 批次 version）', async () => {
    const { wrapper } = await mountDialog(TREE_ASSEMBLY);
    const pendingRow = rowBy(wrapper, 'BATCH_9000000000103');
    // 面板默认收起。
    expect(pendingRow?.find('.mock-select').exists()).toBe(false);
    await pendingRow?.find('button').trigger('click');
    // 展开后：品检架候选来自 props（父组件从 store.options 传入），数量上限 = 批次数量。
    expect(pendingRow?.findAll('.mock-select')).toHaveLength(1);
    expect(pendingRow?.findAll('.mock-option').map((o) => o.attributes('data-value'))).toEqual([
      '9000000000501',
      '9000000000502',
    ]);
    const qty = pendingRow?.find('.mock-input-number');
    expect(qty?.attributes('data-model')).toBe('6');
    expect(qty?.attributes('data-max')).toBe('6');

    // 没选品检架时「确认送检」禁用，也不发请求。
    // ⚠️ 按文案定位按钮：行内 option 桩也是 <button>，按下标取会取错。
    const confirmBtn = () => pendingRow?.findAll('button').find((b) => b.text() === '确认送检');
    expect(confirmBtn()?.attributes('disabled')).toBeDefined();
    await confirmBtn()?.trigger('click');
    expect(toInspectionMock).not.toHaveBeenCalled();

    // 选品检架 2 → 可提交；payload 用批次 id + 批次 version（零件的 version 是 3）。
    // 目标品检架名一并带进 vars（写成功后 store 要用它回写「当前位置」列）。
    await pendingRow?.findAll('.mock-option')[1]?.trigger('click');
    await flushPromises();
    expect(confirmBtn()?.attributes('disabled')).toBeUndefined();
    await confirmBtn()?.trigger('click');
    await flushPromises();
    expect(toInspectionMock).toHaveBeenCalledWith('9000000000103', {
      target_inspection_shelf_id: '9000000000502',
      version: 1,
      quantity: 6,
    });
    // 提交成功后面板收起。
    expect(pendingRow?.find('.mock-select').exists()).toBe(false);
    wrapper.unmount();
  });

  it('送检成功后树就地更新：状态 / 当前位置变，操作列按钮随之换成品检侧动作', async () => {
    toInspectionMock.mockResolvedValue({
      part: { status: 'INSPECTION', version: 9 },
      new_batch_id: null,
    });
    const { wrapper, store } = await mountDialog(TREE_ASSEMBLY);
    const pendingRow = rowBy(wrapper, 'BATCH_9000000000103');
    await pendingRow?.find('button').trigger('click');
    await pendingRow?.findAll('.mock-option')[1]?.trigger('click');
    await pendingRow
      ?.findAll('button')
      .find((b) => b.text() === '确认送检')
      ?.trigger('click');
    await flushPromises();

    // store 里的树被本地回写：批次 status / version / location / holder 都跟上后端。
    const batch = store.mutations.scanTree?.children[1]?.children[0];
    expect(batch?.status).toBe('INSPECTION');
    expect(batch?.version).toBe(2);
    expect(batch?.location).toBe('INSPECTION_SHELF');
    expect(batch?.current_holder_display).toBe('品检架 2');
    expect(batch?.process_name).toBeNull();

    // 表格随之重渲染：状态标签 + 当前位置 + 操作列按钮（不再是可以再点一次的「送检」）。
    const row = rowBy(wrapper, 'BATCH_9000000000103');
    expect(row?.attributes('data-status')).toBe('INSPECTION');
    expect(
      row
        ?.findAll('.mock-column')
        .find((c) => c.attributes('data-label') === '当前位置')
        ?.text(),
    ).toBe('品检架 2');
    expect(row?.findAll('button').map((b) => b.text())).toEqual(['品检通过', '指定工序']);
    wrapper.unmount();
  });

  it('关闭弹窗清掉树与行内送检面板的选择（下一次扫码不继承上一次的展开态）', async () => {
    const { wrapper, store } = await mountDialog(TREE_ASSEMBLY);
    const pendingRow = rowBy(wrapper, 'BATCH_9000000000103');
    await pendingRow?.find('button').trigger('click');
    await pendingRow?.findAll('.mock-option')[0]?.trigger('click');
    await flushPromises();
    expect(pendingRow?.find('.mock-select').exists()).toBe(true);

    // el-dialog 的 closed 事件：清树 + 清面板态。
    wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('closed');
    await flushPromises();
    expect(store.mutations.scanTree).toBeNull();

    // 同一个组件实例上模拟下一次扫码的结果：面板不该被上一次的展开态顶出来。
    store.mutations.scanTree = structuredClone(TREE_ASSEMBLY) as ScanTreeOut;
    await flushPromises();
    expect(rowBy(wrapper, 'BATCH_9000000000103')?.find('.mock-select').exists()).toBe(false);
    wrapper.unmount();
  });

  it('v-loading 绑扫码请求的在飞态', async () => {
    const { wrapper, store } = await mountDialog(TREE_ASSEMBLY);
    expect(wrapper.find('.mock-table').attributes('data-loading')).toBe('false');
    // 用一个不 resolve 的 promise 把 mutation 挂在 pending 上（release 放数组里：
    // 赋值发生在 promise executor 回调内，用 `let x = null` 会被 TS 收窄成 never）。
    const release: Array<() => void> = [];
    scanInspectionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release.push(() => resolve(TREE_PART));
        }),
    );
    const pending = store.mutations.scanMutation.mutateAsync('F1006-01');
    await flushPromises();
    expect(wrapper.find('.mock-table').attributes('data-loading')).toBe('true');
    release[0]?.();
    await pending;
    await flushPromises();
    expect(wrapper.find('.mock-table').attributes('data-loading')).toBe('false');
    wrapper.unmount();
  });
});
