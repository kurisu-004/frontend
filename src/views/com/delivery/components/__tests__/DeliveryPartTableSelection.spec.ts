// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryPartTableSelection.spec.ts
//
// 2026-10-09 新增：两张零件 / 装配件树表的**勾选不联动**守卫（真 el-table）。
//
// 硬不变式：**一行勾选 = 一张标签**。装配件父行的标签是「N 套」一张，打完还会把全部子件
// 批次标记上；子件行的标签是「M 件」各一张。EP 的 `treeProps.checkStrictly` 默认 `false`
// ⇒ 勾父行会级联勾上全部子件（同一批货出两轮标签），勾满子件也会把父行反过来勾上。
// 两者都是「勾一行、出了好几张纸」，且**没有任何报错**，所以只能靠用例钉住。
//
// 为什么必须挂**真** el-table（本仓先例：src/components/__tests__/BatchCardDndFootprint.spec.ts）：
// 级联发生在 EP 内部 —— `store/watcher.toggleRowSelection` 把 `treeStates.checkStrictly`
// 透传给 `util.toggleRowStatus`，后者在 `!checkStrictly` 时递归遍历 `row[children]`。
// 换成 `el-table` 桩（同目录另外两份 spec 的做法）就完全走不到那段代码，用例恒绿、
// 守不住任何东西。
//
// 勾选用的是 el-table 公开的 `toggleRowSelection(row, true)`：EP 勾选框的 `onChange`
// 就是 `store.commit('rowSelectedChanged', row)` → `store.toggleRowSelection(row)`，
// 同一段代码路径（happy-dom 下点真实 checkbox 不会派发 change，用实例方法是等价且确定的）。
//
// 列顺序拖动（useColumnDrag）与本不变式正交，桩掉：它要真实表头 DOM + sortablejs +
// MutationObserver，只会引入无关的爆炸半径。
import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ElButton, ElCard, ElIcon, ElTable, ElTableColumn, ElTag, ElTooltip } from 'element-plus';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { PartTreeRow } from '../../utils/deliveryNotePartRows';
import type { DeliveryNoteDetailData, DeliveryNoteItemData } from '../../composables/deliveryNoteSchema';
import { buildDeliveryNoteLineItemsColumnDefs } from '../../deliveryNoteLineItemsColumnDefs';

vi.mock('@/composables/useColumnDrag', () => ({
  useColumnDrag: (defs: ColumnDef[]) => ({
    orderedDefs: ref(defs),
    dragLabelClass: () => '',
    applyDrag: () => {},
    reset: () => {},
  }),
  columnIdentifier: (def: { key: string }) => def.key,
}));
vi.mock('@/components/ColumnDragHandle.vue', () => ({
  default: { name: 'ColumnDragHandleStub', template: '<i class="mock-drag-handle" />' },
}));
vi.mock('@/components/ColumnVisibilityPopover.vue', () => ({
  default: { name: 'ColumnVisibilityPopoverStub', template: '<div class="mock-cvp" />' },
}));

const { default: DeliveryNoteLineItemsTable } = await import('../DeliveryNoteLineItemsTable.vue');
const { default: DeliveryDraftCard } = await import('../DeliveryDraftCard.vue');

/** 真 EP：组件模板里的 kebab 标签要靠这里解析（`el-table` → `ElTable`）。 */
const global = {
  components: { ElButton, ElCard, ElIcon, ElTable, ElTableColumn, ElTag, ElTooltip },
  // 装配件父行的名称列渲染 RouterLink（跳 /assemblies/:id），必须有 router 上下文
  plugins: [createRouter({ history: createMemoryHistory(), routes: [] })],
};

function partRow(id: string, over: Partial<PartTreeRow> = {}): PartTreeRow {
  return {
    id,
    is_part_row: true,
    serial_no: 'S-1',
    drawing_no: 'D-1',
    name: '电容',
    order_no: 'SO-1',
    applicant_name: '张三',
    customer_name: '法拉',
    customer_path: '法拉电子 / 法拉',
    note: '',
    quantity: 5,
    unit: '件',
    batch_ids: [id],
    label_printed: false,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    status: 'READY_TO_SHIP',
    part_id: id,
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    assembly_quantity: null,
    shippable_sets: null,
    ...over,
  };
}

/** 装配件父行 + 两个子件行 + 一个散件行（`buildPartTreeRows` 的真实形状）。 */
function treeRows(): PartTreeRow[] {
  return [
    partRow('ASM_A1', {
      is_part_row: undefined,
      is_asm_row: true,
      has_children: true,
      children: [
        partRow('P:A1:PA', { batch_ids: ['13'] }),
        partRow('P:A1:PB', { batch_ids: ['14'] }),
      ],
      batch_ids: ['13', '14'],
      assembly_id: 'A1',
      assembly_name: '总装',
      unit: '套',
    }),
    partRow('P:-:PLOOSE', { batch_ids: ['99'] }),
  ];
}

/** 详情页那张表的实例（吃真实列定义，顺带守住「组件不吃副本」）。 */
function mountLineItemsTable(rows: PartTreeRow[]): VueWrapper {
  const note = {
    id: 'NOTE-1',
    version: 1,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: null,
    customer_path: null,
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    driver_worker_name: null,
    part_count: rows.length,
    note: null,
    delivery_date: null,
    // 头部计数刻意给一个**不等于展示行数**的批次条数，钉住计数走的是表体行数
    line_items: new Array(rows.length * 3).fill({}),
  } as unknown as DeliveryNoteDetailData;
  return mount(DeliveryNoteLineItemsTable, {
    props: {
      note,
      canEdit: true,
      role: { MANAGER: true, CLERK: false, INSPECTOR: false },
      treeLineItems: rows,
      columnDefs: buildDeliveryNoteLineItemsColumnDefs(),
      columnVisibility: {
        isVisible: () => true,
        update: () => {},
        showAll: () => {},
        currentMap: {},
      },
      selectedRows: [],
      deliveryLineRowClassName: () => '',
    },
    global,
    attachTo: document.body,
  });
}

function mountDraftCard(rows: PartTreeRow[]): VueWrapper {
  const draft = {
    id: 'N1',
    delivery_note_no: 'DN-001',
    status: 'DRAFT',
  } as unknown as DeliveryNoteItemData;
  return mount(DeliveryDraftCard, {
    props: {
      draft,
      rows,
      deleting: false,
      submitting: false,
      canPrint: true,
      canSubmit: true,
      rowClassName: () => '',
    },
    global,
    attachTo: document.body,
  });
}

/** 真 el-table 实例（EP 的 `name` 就是 `ElTable`）。 */
function tableOf(w: VueWrapper): { toggleRowSelection: (row: unknown, selected?: boolean) => void } {
  return w.findComponent({ name: 'ElTable' }).vm as unknown as {
    toggleRowSelection: (row: unknown, selected?: boolean) => void;
  };
}

/**
 * 表体里哪些行的勾选框已勾上（DOM 侧的第二重断言，返回 DOM 顺序下的下标）。
 *
 * 两张表都常驻 `default-expand-all`，DOM 行序固定 = 父行 0 / 子件 PA 1 / 子件 PB 2 /
 * 散件 3（`treeRows()` 的形状），所以断言下标即可，不必去猜某一列的文字。
 */
function checkedRowIndexes(w: VueWrapper): number[] {
  const hits: number[] = [];
  const root = w.element as HTMLElement;
  const trs = Array.from(root.querySelectorAll('tr.el-table__row'));
  trs.forEach((tr, i) => {
    const box = tr.querySelector('.el-checkbox');
    if (box?.classList.contains('is-checked')) hits.push(i);
  });
  return hits;
}

/** EP 的列布局 / 树展开要过几个 flush 才稳定。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick();
}

describe('零件 / 装配件树表：勾选不联动（checkStrictly）', () => {
  it('详情页表：勾装配件父行 → 只产生 1 条 selection-change，子件不被连带', async () => {
    const rows = treeRows();
    const w = mountLineItemsTable(rows);
    await settle();

    tableOf(w).toggleRowSelection(rows[0], true);
    await settle();

    const emitted = w.emitted('selectionChange');
    expect(emitted).toHaveLength(1);
    // 一行 = 一张标签：只有父行这一张「N 套」
    expect((emitted![0]![0] as PartTreeRow[]).map((r) => r.id)).toEqual(['ASM_A1']);
    // DOM 侧同样只有父行的勾选框亮
    expect(checkedRowIndexes(w)).toEqual([0]);

    w.unmount();
  });

  it('详情页表：勾满两个子件行 → 父行不会被反过来勾上', async () => {
    const rows = treeRows();
    const w = mountLineItemsTable(rows);
    await settle();

    const table = tableOf(w);
    table.toggleRowSelection(rows[0]!.children![0], true);
    table.toggleRowSelection(rows[0]!.children![1], true);
    await settle();

    const emitted = w.emitted('selectionChange');
    const last = emitted![emitted!.length - 1]![0] as PartTreeRow[];
    expect(last.map((r) => r.id).sort()).toEqual(['P:A1:PA', 'P:A1:PB']);
    expect(checkedRowIndexes(w)).toEqual([1, 2]);

    w.unmount();
  });

  it('草稿卡片表：勾装配件父行 → 只产生 1 条 update:selectedRows，子件不被连带', async () => {
    const rows = treeRows();
    const w = mountDraftCard(rows);
    await settle();

    tableOf(w).toggleRowSelection(rows[0], true);
    await settle();

    const emitted = w.emitted('update:selectedRows');
    expect(emitted).toHaveLength(1);
    expect((emitted![0]![0] as PartTreeRow[]).map((r) => r.id)).toEqual(['ASM_A1']);
    expect(checkedRowIndexes(w)).toEqual([0]);

    w.unmount();
  });

  it('草稿卡片表：勾满两个子件行 → 父行不会被反过来勾上', async () => {
    const rows = treeRows();
    const w = mountDraftCard(rows);
    await settle();

    const table = tableOf(w);
    table.toggleRowSelection(rows[0]!.children![0], true);
    table.toggleRowSelection(rows[0]!.children![1], true);
    await settle();

    const emitted = w.emitted('update:selectedRows');
    const last = emitted![emitted!.length - 1]![0] as PartTreeRow[];
    expect(last.map((r) => r.id).sort()).toEqual(['P:A1:PA', 'P:A1:PB']);
    expect(checkedRowIndexes(w)).toEqual([1, 2]);

    w.unmount();
  });
});

describe('卡片头计数 = 表体实际展示行数（不是批次条数）', () => {
  it('3 个批次 / 1 套 2 件 ⇒ 头部显示 4 行（父行 1 + 子件 2 + 散件 1）', () => {
    const w = mountLineItemsTable(treeRows());
    expect(w.text()).toContain('零件列表 (4)');
    w.unmount();
  });
});
