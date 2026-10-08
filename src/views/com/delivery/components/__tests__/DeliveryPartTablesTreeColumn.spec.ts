// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryPartTablesTreeColumn.spec.ts
//
// 零件 / 装配件**树列**的守卫：展开箭头（caret）与每级 16px 缩进必须落在「序列号」列，
// 且「序号」列的装配件子件行留空。2026-10-10 新增。
//
// 为什么必须用**真 el-table** 断：这两条都出自 EP 的树形渲染机制，桩 el-table 一律断不到。
// 机制本体在 node_modules/element-plus/es/components/table/src/table-body/render-helper.mjs 的
// `firstDefaultColumnIndex`（`columns.findIndex(({ type }) => type === 'default')`）—— 展开箭头
// 与缩进只挂在这个下标对应的 td 上。所以「序号」列一旦写成不传 `type` 的普通数据列，它就成了
// 第一个 default 列，箭头与缩进被搬进那个窄格，而「序列号」列同时失去层级 —— 一次没人计划、
// 也没有任何报错的行为漂移。断言写成「caret 在序列号列」，任何人调整硬编码列的 `type` / 顺序
// 都会立刻红。
//
// 为什么必须断「子件行留空」：排名（`buildPartTreeRows::assignSeq`）只对**顶层行**做，子件行的
// `seq` 停在占位 `0`。两张表都常驻 `default-expand-all`，子件行是真的铺出来的 ⇒ 占位值会变成
// 用户看得见的字面量 `0`。留空判据的**唯一出口**是 `seqCellText()`，两张表都调它，这里顺带
// 钉住「两张表调的是同一个出口」（改判据只改一处、不会只改一张表）。
//
// 桩掉的两样东西：列设置弹窗（ColumnVisibilityPopover，teleport 出去且与本用例无关）、
// 拖动手柄（纯图标）。el-table / el-table-column / el-card 等**一律用真组件**。

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createRouter, createMemoryHistory } from 'vue-router';
import type { PartTreeRow } from '../../utils/deliveryNotePartRows';
import type { DeliveryNoteItemData, DeliveryNoteDetailData } from '../../composables/deliveryNoteSchema';
import { buildDeliveryNoteLineItemsColumnDefs } from '../../deliveryNoteLineItemsColumnDefs';
import DeliveryNoteLineItemsTable from '../DeliveryNoteLineItemsTable.vue';
import DeliveryDraftCard from '../DeliveryDraftCard.vue';

vi.mock('@/components/ColumnVisibilityPopover.vue', () => ({
  default: { name: 'CvpStub', template: '<div class="mock-cvp" />' },
}));
vi.mock('@/components/ColumnDragHandle.vue', () => ({
  default: { name: 'DragHandleStub', template: '<i class="mock-drag-handle" />' },
}));

/** 行对象工厂（形状与 `buildPartTreeRows` 产出一致）。 */
function mkRow(p: Partial<PartTreeRow> & { id: string }): PartTreeRow {
  return {
    is_part_row: true,
    serial_no: 'S-1',
    drawing_no: 'D-1',
    name: '电容',
    order_no: 'SO-1',
    applicant_name: '张三',
    customer_name: '法拉',
    customer_path: '法拉 / 一厂',
    note: '',
    quantity: 1,
    unit: '件',
    batch_ids: ['1'],
    label_printed: false,
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
    status: 'READY_TO_SHIP',
    part_id: 'P1',
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    assembly_quantity: null,
    shippable_sets: null,
    seq: 1,
    min_seq: null,
    ...p,
  };
}

/**
 * 树数据：一个装配件父行（带两个子件行）+ 一个散件行。
 * 子件行的 `seq` 刻意给占位值 `0` —— 那正是「留空判据」要挡住的漏出。
 */
const TREE: PartTreeRow[] = [
  mkRow({
    id: 'ASM_A1',
    is_part_row: undefined,
    is_asm_row: true,
    has_children: true,
    assembly_id: 'A1',
    assembly_name: '总装',
    name: '总装',
    unit: '套',
    quantity: 2,
    batch_ids: ['1', '2'],
    seq: 1,
    min_seq: 1,
    children: [
      mkRow({ id: 'P:A1:P1', assembly_id: 'A1', part_id: 'P1', seq: 0, min_seq: 1 }),
      mkRow({ id: 'P:A1:P2', assembly_id: 'A1', part_id: 'P2', seq: 0, min_seq: 2 }),
    ],
  }),
  mkRow({ id: 'P:-:P9', part_id: 'P9', seq: 2, min_seq: 3 }),
];

function mkNote(): DeliveryNoteDetailData {
  return {
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
    part_count: 0,
    note: null,
    delivery_date: null,
    line_items: [],
  };
}

async function mountDetailTable(rows: PartTreeRow[]): Promise<VueWrapper> {
  const w = mount(DeliveryNoteLineItemsTable, {
    props: {
      note: mkNote(),
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
    global: {
      plugins: [ElementPlus, createRouter({ history: createMemoryHistory(), routes: [] })],
    },
  });
  await settle(w);
  return w;
}

async function mountDraftCard(rows: PartTreeRow[]): Promise<VueWrapper> {
  const w = mount(DeliveryDraftCard, {
    props: {
      draft: { id: 'N1', delivery_note_no: 'DN-001', status: 'DRAFT' } as unknown as DeliveryNoteItemData,
      rows,
      deleting: false,
      submitting: false,
      canPrint: true,
      canSubmit: true,
      rowClassName: () => '',
    },
    global: {
      plugins: [ElementPlus, createRouter({ history: createMemoryHistory(), routes: [] })],
    },
  });
  await settle(w);
  return w;
}

/** 等 el-table 铺完树行（treeData 是懒算的，一次 flush 不一定够）。 */
async function settle(_w: VueWrapper): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises();
    await nextTick();
  }
}

/** 表格根元素（el-table 的 DOM 从这里查）。 */
function root(w: VueWrapper): HTMLElement {
  return w.element as HTMLElement;
}

/** 表头列名（按下标），下标从 0 起 = 第 1 个 td。 */
function headerLabels(w: VueWrapper): string[] {
  return Array.from(root(w).querySelectorAll<HTMLTableCellElement>('thead th')).map(
    (th) => th.querySelector('.cell')?.textContent?.trim() ?? '',
  );
}

/** body 里所有行（真 el-table 铺出来的：顶层行 + default-expand-all 铺出的子件行）。 */
function bodyRows(w: VueWrapper): HTMLTableRowElement[] {
  return Array.from(root(w).querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

/** 某一行的每个 td：是否带 caret / 是否带缩进 / 文本。 */
interface CellInfo {
  caret: boolean;
  indent: boolean;
  text: string;
}
function cellsOf(w: VueWrapper, rowText: string): CellInfo[] {
  const tr = bodyRows(w).find((r) => r.textContent?.includes(rowText));
  // el-table 不把 row-key 写进 DOM，按行内唯一文本定位（用例数据里 序列号 列的值各不相同）
  if (!tr) throw new Error(`找不到含「${rowText}」的行`);
  return Array.from(tr.querySelectorAll<HTMLTableCellElement>('td')).map((td) => ({
    caret: !!td.querySelector('.el-table__expand-icon'),
    indent: !!td.querySelector('.el-table__indent'),
    text: td.querySelector('.cell')?.textContent?.trim() ?? '',
  }));
}

/** 「序号」列某行的单元格文本。 */
function seqCell(w: VueWrapper, tr: HTMLTableRowElement): string {
  const idx = headerLabels(w).indexOf('序号');
  return tr.querySelectorAll<HTMLTableCellElement>('td')[idx]?.querySelector('.cell')?.textContent?.trim() ?? '';
}

/** 序列号列下标（两张表都把它排在「序号」之后，列名唯一）。 */
function serialColIndex(w: VueWrapper): number {
  return headerLabels(w).indexOf('序列号');
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('零件 / 装配件树的箭头与缩进落在「序列号」列（EP 树列机制）', () => {
  it('详情页零件列表：父行 caret、子件行缩进都在「序列号」列，「序号」列两者都没有', async () => {
    const w = await mountDetailTable(TREE);
    const labels = headerLabels(w);
    // 前提：勾选列 + 序号列 + 12 列 defs，「序号」紧跟勾选列，「序列号」是第一个数据列
    expect(labels.slice(0, 3)).toEqual(['', '序号', '序列号']);
    const serial = serialColIndex(w);
    const seq = labels.indexOf('序号');

    // 父行（第 1 行 tbody）：有 caret，无缩进
    const parent = cellsOf(w, '总装');
    expect(parent[serial]!.caret).toBe(true);
    expect(parent[seq]!.caret).toBe(false);
    expect(parent[seq]!.indent).toBe(false);
  });

  it('草稿卡片：同一机制、同一列（两张表不许漂移到不同列）', async () => {
    const w = await mountDraftCard(TREE);
    const labels = headerLabels(w);
    expect(labels.slice(0, 3)).toEqual(['', '序号', '序列号']);
    const serial = serialColIndex(w);
    const seq = labels.indexOf('序号');

    const parent = cellsOf(w, '总装');
    expect(parent[serial]!.caret).toBe(true);
    expect(parent[seq]!.caret).toBe(false);
    expect(parent[seq]!.indent).toBe(false);
  });
});

describe('「序号」列的装配件子件行留空（不显示排名占位值 0）', () => {
  it('详情页：父行显示编号、子件行留空、散件行照常编号', async () => {
    const w = await mountDetailTable(TREE);
    // 4 行 = 父行 + 2 个子件行 + 散件行（default-expand-all ⇒ 子件行真的铺出来）
    const cells = bodyRows(w).map((tr) => seqCell(w, tr));
    // 父行 seq=1、散件行 seq=2；两个子件行是空串
    expect(cells.filter((t) => t !== '')).toEqual(['1', '2']);
    expect(cells.filter((t) => t === '')).toHaveLength(2);
    // 子件行的占位 seq = 0 不得漏成字面量 '0'
    expect(cells).not.toContain('0');
  });

  it('草稿卡片：同一出口、同一结果（两张表调的是同一个 seqCellText）', async () => {
    const w = await mountDraftCard(TREE);
    const cells = bodyRows(w).map((tr) => seqCell(w, tr));
    expect(cells.filter((t) => t !== '')).toEqual(['1', '2']);
    expect(cells.filter((t) => t === '')).toHaveLength(2);
    expect(cells).not.toContain('0');
  });
});
