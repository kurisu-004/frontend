// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/PrintGroupTable.columnDrag.spec.ts
//
// 2026-10-08 review 第 1 轮：打印对话框**恢复列顺序拖动**后的接线守卫。
//
// 为什么用 mock 而不是真跑 Sortable：`useColumnDrag` 的落点解析（el-table 的
// `.el-table` 根 → 表头 `<tr>` → MutationObserver 自愈）在桩 DOM 上没有意义，真跑只会
// 打一串 console.warn。本用例只钉**接线契约**：
//   1. 每张分组表各拿一份 drag 实例，快照 key = `print_preview_dialog__<groupKey>`
//      （N 张表互不覆盖；错了就退回「全对话框共用一条序列」的老问题）；
//   2. 渲染顺序跟着 `drag.orderedDefs` 走（拖动生效的前提）；
//   3. 父组件的「重置列顺序」信号量自增时，本表 reset 自己那条序列。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, type PropType } from 'vue';
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

const stubs = {
  'el-table': defineComponent({
    name: 'ElTableStub',
    props: { data: { type: Array as PropType<unknown[]>, default: () => [] } },
    setup: (_props, { slots }) => () => h('div', { class: 'mock-el-table' }, slots.default?.()),
  }),
  'el-table-column': defineComponent({
    name: 'ElTableColumnStub',
    props: ['label', 'columnKey'],
    setup: (p) => () => h('span', { class: 'mock-col', 'data-label': p.label }),
  }),
  'el-button': { template: '<button><slot /></button>' },
  'el-icon': true,
  PrintSplitEditor: true,
  ColumnDragHandle: true,
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
