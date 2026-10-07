// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/PrintGroupTable.columnDrag.spec.ts
//
// 打印分组表的**接线**守卫：
//   1. 列顺序拖动（2026-10-08 review 第 1 轮恢复）：
//      每张分组表各拿一份 drag 实例，快照 key = `print_preview_dialog__<groupKey>`
//      （N 张表互不覆盖；错了就退回「全对话框共用一条序列」的老问题）；渲染顺序跟着
//      `drag.orderedDefs` 走（拖动生效的前提）；父组件的「重置列顺序」信号量自增时 reset。
//   2. 标签模式勾选列（2026-10-08 恢复打印标签时新增）：固定最左、不进 columnDefs、
//      不可被列拖动换位，勾选状态完全由父组件的 selectedIds 驱动。
//
// 为什么用 mock 而不是真跑 Sortable：`useColumnDrag` 的落点解析（el-table 的
// `.el-table` 根 → 表头 `<tr>` → MutationObserver 自愈）在桩 DOM 上没有意义，真跑只会
// 打一串 console.warn。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import {
  defineComponent,
  h,
  inject,
  provide,
  toRef,
  type InjectionKey,
  type PropType,
  type Ref,
} from 'vue';
import type { ColumnDef } from '@/composables/useColumnVisibility';

const { useColumnDragMock, dragApi } = vi.hoisted(() => {
  const api = {
    orderedKeys: { value: [] as string[] },
    orderedDefs: { value: [] as unknown[] },
    applyDrag: vi.fn(),
    dragLabelClass: vi.fn((d: { key: string }) => `col-draggable col-key-${d.key}`),
    reset: vi.fn(),
    clear: vi.fn(),
    isBound: () => true,
  };
  // 显式标注形参：vi.fn(() => ...) 的 calls 是零参元组，取不到第 2 个实参。
  const mock = vi.fn((_defs: readonly ColumnDef[], _opts: { listKey: string }) => api);
  return { useColumnDragMock: mock, dragApi: api };
});

vi.mock('@/composables/useColumnDrag', () => ({
  useColumnDrag: useColumnDragMock,
  columnIdentifier: (d: { key: string }) => d.key,
}));

// 行拖动的 Sortable 依赖真实 DOM（EP 内部 tbody），本用例不关心，直接桩掉。
vi.mock('@/composables/useLazyDraggable', () => ({ useLazyDraggable: vi.fn() }));

const { default: PrintGroupTable } = await import('../PrintGroupTable.vue');

const DEFS: ColumnDef[] = [
  { key: 'index', label: '序号' },
  { key: 'order_no', label: '订单号' },
  { key: 'customer_name', label: '分厂' },
];

/** 桩 el-table 把 data 下发给列桩，列桩据此逐行渲染**行内受控列**的默认插槽 ——
 *  真实 EP 就是这么做的；不这么做的话「勾选框」「拆分」按钮在桩 DOM 里根本不存在，
 *  对它们的断言会变成空跑。 */
const ROWS_KEY: InjectionKey<Readonly<Ref<readonly Record<string, unknown>[]>>> =
  Symbol('mock-table-rows');

const stubs = {
  'el-table': defineComponent({
    name: 'ElTableStub',
    props: { data: { type: Array as PropType<Record<string, unknown>[]>, default: () => [] } },
    setup(props, { slots }) {
      // toRef 而不是直接 provide props.data：后者在 setup 根作用域读 prop，rows 若晚于
      // setup 填好就永远停在初值（且触发 vue/no-setup-props-destructure）。
      provide(ROWS_KEY, toRef(props, 'data'));
      return () => h('div', { class: 'mock-el-table' }, slots.default?.());
    },
  }),
  'el-table-column': defineComponent({
    name: 'ElTableColumnStub',
    // labelClassName 透出来供「哪一列可被列拖动」断言用（真实 EP 用它挂 col-drag-handle）
    props: ['label', 'columnKey', 'labelClassName'],
    setup(p, { slots }) {
      const rowsRef = inject(ROWS_KEY, null);
      /** 勾选列 / 操作列的行内渲染（defs 列在真实 EP 里也是这么出格子的，
       *  但它们的断言只看列头，这里不必逐行展开）。 */
      const perRow = p.columnKey === 'label_select' || p.label === '操作';
      return () =>
        h(
          'span',
          {
            class: 'mock-col',
            'data-label': p.label,
            'data-column-key': p.columnKey ?? '',
            'data-label-class': p.labelClassName ?? '',
          },
          perRow ? (rowsRef?.value ?? []).map((row) => slots.default?.({ row })) : undefined,
        );
    },
  }),
  'el-checkbox': defineComponent({
    name: 'ElCheckboxStub',
    props: ['modelValue'],
    emits: ['change'],
    setup: (p, { emit }) => () =>
      h('input', {
        class: 'mock-el-checkbox',
        type: 'checkbox',
        checked: p.modelValue === true,
        onChange: () => emit('change', p.modelValue !== true),
      }),
  }),
  'el-button': { template: '<button><slot /></button>' },
  'el-icon': true,
  ColumnDragHandle: true,
  PrintSplitEditor: defineComponent({
    name: 'PrintSplitEditorStub',
    template: '<div class="mock-split-editor" />',
  }),
};

function visibleMap(): Record<string, boolean> {
  return { index: true, order_no: true, customer_name: true };
}

beforeEach(() => {
  useColumnDragMock.mockClear();
  dragApi.reset.mockClear();
  dragApi.orderedDefs.value = [];
});

async function mountTable(props: Record<string, unknown> = {}) {
  return mount(PrintGroupTable, {
    props: {
      rows: [
        {
          id: 'r1',
          order_no: 'SO-1',
          l2_customer: '法拉',
          applicant_name: '张三',
          drawing_no: 'D-1',
          name: '电容',
          quantity: 1,
          unit: '',
          system_delivery_date: null,
          note: '',
        },
      ],
      sortMode: 'column',
      columnDefs: DEFS,
      columnVisibility: {
        isVisible: (k: string) => visibleMap()[k] !== false,
        update: vi.fn(),
        showAll: vi.fn(),
        currentMap: visibleMap(),
      },
      groupKey: 'g_7',
      resetOrderToken: 0,
      ...props,
    },
    global: { stubs },
  });
}

describe('PrintGroupTable 列顺序拖动接线', () => {
  it('快照 key 带 groupKey 后缀（每张分组表一条独立序列）', async () => {
    await mountTable({ groupKey: 'g_7' });
    expect(useColumnDragMock).toHaveBeenCalledTimes(1);
    expect(useColumnDragMock.mock.calls[0]![1]).toEqual({ listKey: 'print_preview_dialog__g_7' });
    expect(dragApi.applyDrag).toHaveBeenCalledTimes(1);
  });

  it('渲染顺序跟 drag.orderedDefs 走（拖动后的顺序才是渲染顺序）', async () => {
    dragApi.orderedDefs.value = [DEFS[2]!, DEFS[0]!, DEFS[1]!];
    const w = await mountTable();
    // 前 3 项来自 orderedDefs；「数量 / 操作」两列是 defs 之外的固定列，永远在最后。
    expect(w.findAll('.mock-col').map((e) => e.attributes('data-label'))).toEqual([
      '分厂',
      '序号',
      '订单号',
      '数量',
      '操作',
    ]);
  });

  it('「重置列顺序」信号量自增 → 本表 reset（写盘）', async () => {
    const w = await mountTable({ resetOrderToken: 0 });
    expect(dragApi.reset).not.toHaveBeenCalled();
    await w.setProps({ resetOrderToken: 1 });
    expect(dragApi.reset).toHaveBeenCalledTimes(1);
  });
});

// 标签模式的受控勾选列（2026-10-08 恢复打印标签时新增）。
describe('PrintGroupTable 标签模式勾选列', () => {
  it('勾选列固定在最左（在 drag.orderedDefs 循环之前渲染）', async () => {
    dragApi.orderedDefs.value = [DEFS[2]!, DEFS[0]!, DEFS[1]!];
    const w = await mountTable({ selectable: true });
    expect(w.findAll('.mock-col').map((e) => e.attributes('data-label'))).toEqual([
      '勾选',
      '分厂',
      '序号',
      '订单号',
      '数量',
      '操作',
    ]);
  });

  it('送货单模式（默认）不渲染勾选列', async () => {
    dragApi.orderedDefs.value = [DEFS[0]!, DEFS[1]!, DEFS[2]!];
    const w = await mountTable();
    expect(w.findAll('.mock-col').map((e) => e.attributes('data-label'))).not.toContain('勾选');
  });

  it('勾选列**不进** columnDefs（useColumnDrag 拿到的 defs 里没有它 ⇒ 顺序快照不含它）', async () => {
    await mountTable({ selectable: true });
    expect(useColumnDragMock.mock.calls[0]![0].map((d) => d.key)).toEqual([
      'index',
      'order_no',
      'customer_name',
    ]);
    expect(useColumnDragMock.mock.calls[0]![0].map((d) => d.key)).not.toContain('label_select');
  });

  it('勾选列不可被列拖动（无 label-class-name ⇒ 没有拖手柄），相邻 defs 列有', async () => {
    dragApi.orderedDefs.value = [DEFS[0]!, DEFS[1]!];
    const w = await mountTable({ selectable: true });
    const cols = w.findAll('.mock-col');
    const byKey = (k: string) => cols.find((c) => c.attributes('data-column-key') === k)!;
    expect(byKey('label_select').attributes('data-label-class')).toBe('');
    expect(byKey('index').attributes('data-label-class')).toContain('col-draggable');
    expect(byKey('order_no').attributes('data-label-class')).toContain('col-draggable');
  });

  it('标签模式不渲染拆分编辑器（标签没有「客户要求拆多条」这层）', async () => {
    dragApi.orderedDefs.value = [DEFS[0]!];
    const on = await mountTable({ selectable: true });
    expect(on.findComponent({ name: 'PrintSplitEditorStub' }).exists()).toBe(false);
    // 对照：送货单模式点「拆分」会拉起编辑器（证明上一条不是因为按钮没渲染才空过）
    const off = await mountTable();
    await off.findAll('.mock-col button').at(-1)!.trigger('click');
    expect(off.findComponent({ name: 'PrintSplitEditorStub' }).exists()).toBe(true);
  });

  it('勾选框的勾选态由父组件的 selectedIds 决定，点一下 emit 整份新集合', async () => {
    dragApi.orderedDefs.value = [DEFS[0]!];
    const w = await mountTable({ selectable: true, selectedIds: new Set(['r1']) });
    const boxes = w.findAll('input.mock-el-checkbox');
    expect(boxes).toHaveLength(1);
    expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true);

    await boxes[0]!.setValue(false);
    const emitted = w.emitted('update:selectedIds');
    expect(emitted).toHaveLength(1);
    expect([...(emitted![0]![0] as ReadonlySet<string>)]).toEqual([]);
  });

  it('勾选态跟随 props.selectedIds（受控：集合本体归父组件，本表不自管）', async () => {
    dragApi.orderedDefs.value = [DEFS[0]!];
    const w = await mountTable({ selectable: true, selectedIds: new Set<string>() });
    const checked = () =>
      (w.find('input.mock-el-checkbox').element as HTMLInputElement).checked;
    expect(checked()).toBe(false);
    await w.setProps({ selectedIds: new Set(['r1']) });
    expect(checked()).toBe(true);
    await w.setProps({ selectedIds: new Set(['r2']) });
    expect(checked()).toBe(false);
  });
});
