// @vitest-environment happy-dom
// src/views/com/delivery/components/__tests__/DeliveryPartTableSelection.spec.ts
//
// 2026-10-09 新增：两张零件 / 装配件树表的**勾选不联动**守卫（真 el-table）。
// 2026-10-11 追加：装配件**子件行不可勾选**，且这一条同时兜住表头全选。
//
// 硬不变式：**一行勾选 = 一张标签，且标签按套出**。装配件父行的标签是「N 套」一张，打完
// 还会把全部子件批次标记上；子件不是独立打印单元（标签贴在装配件箱上），所以它连
// 单独勾选的资格都没有。
// EP 的 `treeProps.checkStrictly` 默认 `false` ⇒ 勾父行会级联勾上全部子件（同一批货出两轮
// 标签）；它又管不到表头全选（`_toggleAllSelection` 另建 treeProps 并写死 `checkStrictly:
// false`）⇒ 全选那条路只能靠 selection 列上的 `:selectable` 拦。
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
// 表头全选用的是公开的 `toggleAllSelection()`，与用户点表头那个 checkbox 同一段代码
// （`onSelectAll` → `store.commit('toggleAllSelection')`）。
//
// 列顺序拖动（useColumnDrag）与本不变式正交，桩掉：它要真实表头 DOM + sortablejs +
// MutationObserver，只会引入无关的爆炸半径。
import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ElButton, ElCard, ElIcon, ElTable, ElTableColumn, ElTag, ElTooltip } from 'element-plus';
import type { ColumnDef } from '@/composables/useColumnVisibility';
import type { PartTreeRow } from '../../utils/deliveryNotePartRows';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteItemData,
} from '../../composables/deliveryNoteSchema';
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
    seq: 1,
    min_seq: null,
    ...over,
  };
}

/**
 * 装配件父行 + 两个子件行 + 一个散件行（`buildPartTreeRows` 的真实形状）。
 *
 * 子件行必须带 `assembly_id`（`buildPartTreeRows` 由 `asmIdOf(li)` 写上）：那是
 * `canSelectPartRow` / `seqCellText` 判「这是子件行」的唯一依据，fixture 漏了它，
 * 两条判据都会把子件当散件放行。
 */
function treeRows(): PartTreeRow[] {
  return [
    partRow('ASM_A1', {
      is_part_row: undefined,
      is_asm_row: true,
      has_children: true,
      children: [
        partRow('P:A1:PA', { batch_ids: ['13'], assembly_id: 'A1' }),
        partRow('P:A1:PB', { batch_ids: ['14'], assembly_id: 'A1' }),
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
function tableOf(w: VueWrapper): {
  toggleRowSelection: (row: unknown, selected?: boolean) => void;
  toggleAllSelection: () => void;
} {
  return w.findComponent({ name: 'ElTable' }).vm as unknown as {
    toggleRowSelection: (row: unknown, selected?: boolean) => void;
    toggleAllSelection: () => void;
  };
}

/** el-table 内部 store（EP 在 `insertColumn` 时把 selection 列的 `reserveSelection` / `selectable` 镜像进来）。 */
function storeOf(w: VueWrapper): {
  states: { reserveSelection: Ref<boolean> };
  commit: (name: string, ...args: unknown[]) => void;
} {
  return (
    w.findComponent({ name: 'ElTable' }).vm as unknown as {
      store: {
        states: { reserveSelection: Ref<boolean> };
        commit: (name: string, ...args: unknown[]) => void;
      };
    }
  ).store;
}

/**
 * 走**勾选框那条**代码路径（EP 的 selection 单元格 `onChange` 就是
 * `store.commit('rowSelectedChanged', row)`）。
 *
 * ⚠️ 不能用公开的 `table.toggleRowSelection(row, true)` 代替：它的第三参
 * `ignoreSelectable` **默认 true**（table/utils-helper.mjs），会把 `selectable` 整个
 * 绕过去 —— 拿它断言「子件行不可选」恒绿，守不住任何东西（EP 内部注释：修 #14075）。
 */
function clickRowCheckbox(w: VueWrapper, row: unknown): void {
  storeOf(w).commit('rowSelectedChanged', row);
}

/** 表里 type="selection" 的那个列实例。 */
function selectionColumnOf(w: VueWrapper): VueWrapper | undefined {
  return w
    .findAllComponents({ name: 'ElTableColumn' })
    .find((c) => c.props('type') === 'selection');
}

/** 表体里哪些行的勾选框被禁用（EP 的 selection 单元格按 `column.selectable` 置 disabled）。 */
function disabledRowIndexes(w: VueWrapper): number[] {
  const hits: number[] = [];
  const root = w.element as HTMLElement;
  Array.from(root.querySelectorAll('tr.el-table__row')).forEach((tr, i) => {
    const box = tr.querySelector('.el-checkbox');
    if (box?.classList.contains('is-disabled')) hits.push(i);
  });
  return hits;
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

/** 表头全选框是否呈「已勾上」态（EP 的 `isAllSelected` state）。 */
function isAllSelected(w: VueWrapper): boolean {
  const vm = w.findComponent({ name: 'ElTable' }).vm as unknown as {
    store: { states: { isAllSelected: Ref<boolean> } };
  };
  return vm.store.states.isAllSelected.value;
}

/**
 * EP 的列布局 / 树展开要过几个 flush 才稳定。
 *
 * `waitDebounce` 真等一次定时器：EP 把 `store.toggleAllSelection` 包成
 * `debounce(_toggleAllSelection, 10)`（store/helper.mjs），只 `nextTick` 的话全选那步
 * 根本还没跑，断言会读到「什么都没发生」。
 */
async function settle(waitDebounce = false): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick();
  if (waitDebounce) await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 2; i += 1) await nextTick();
}

describe('零件 / 装配件树表：勾选不联动（checkStrictly）+ 子件行不可勾选', () => {
  /** 两张表的挂载函数，跑同一批断言（表结构一致，差异只在 emit 名）。 */
  const tables: [
    string,
    (rows: PartTreeRow[]) => VueWrapper,
    { mount: string; event: 'selectionChange' | 'update:selectedRows' },
  ][] = [
    ['详情页表', mountLineItemsTable, { mount: '详情页', event: 'selectionChange' }],
    ['草稿卡片表', mountDraftCard, { mount: '草稿卡片', event: 'update:selectedRows' }],
  ];

  it.each(tables)(
    '%s：勾装配件父行 → 只产生 1 条勾选事件，子件不被连带',
    async (_n, mountFn, ev) => {
      const rows = treeRows();
      const w = mountFn(rows);
      await settle();

      tableOf(w).toggleRowSelection(rows[0], true);
      await settle();

      const emitted = w.emitted(ev.event);
      expect(emitted).toHaveLength(1);
      // 一行 = 一张标签：只有父行这一张「N 套」
      expect((emitted![0]![0] as PartTreeRow[]).map((r) => r.id)).toEqual(['ASM_A1']);
      // DOM 侧同样只有父行的勾选框亮
      expect(checkedRowIndexes(w)).toEqual([0]);

      w.unmount();
    },
  );

  // 2026-10-11：`checkStrictly` 只管逐行点击，管不到表头全选（EP 的 `_toggleAllSelection`
  // 另建 treeProps 并把 `checkStrictly` 写死 false）⇒ 勾上父行时子件被连带进 selection，
  // 「默认只打装配件本身」这条产品口径在**全选**这条路上漏掉。selection 列的 `:selectable`
  // 是唯一能同时兜住两端的地方（`util.toggleRowStatus` 递归时把同一个 selectable 一路下传）。
  it.each(tables)(
    '%s：表头全选 → 只勾顶层行（装配件父行 + 散件），子件一律不进',
    async (_n, mountFn, ev) => {
      const rows = treeRows();
      const w = mountFn(rows);
      await settle();

      tableOf(w).toggleAllSelection();
      await settle(true);

      const emitted = w.emitted(ev.event);
      const last = emitted![emitted!.length - 1]![0] as PartTreeRow[];
      expect(last.map((r) => r.id)).toEqual(['ASM_A1', 'P:-:PLOOSE']);
      // DOM 侧：父行（0）与散件（3）的勾选框亮，两个子件行（1 / 2）不亮
      expect(checkedRowIndexes(w)).toEqual([0, 3]);

      w.unmount();
    },
  );

  it.each(tables)(
    '%s：表头全选后表头勾选态仍显示「全选」（不可选行不参与计数）',
    async (_n, mountFn, _ev) => {
      const w = mountFn(treeRows());
      await settle();

      tableOf(w).toggleAllSelection();
      await settle(true);

      // EP 的 `updateAllSelected` 对「未选中的不可选行」放行 ⇒ isAllSelected 应为 true
      expect(isAllSelected(w)).toBe(true);

      w.unmount();
    },
  );

  it.each(tables)(
    '%s：子件行的勾选框是禁用态，且走 onChange 那条路也进不去',
    async (_n, mountFn, ev) => {
      const rows = treeRows();
      const w = mountFn(rows);
      await settle();

      // EP 的 selection 单元格按 `column.selectable(row, index)` 置 checkbox 的 disabled
      // （table/config.mjs 的 selection.renderCell）⇒ 子件行（DOM 序 1 / 2）该亮 is-disabled，
      // 父行（0）与散件（3）不该亮。
      expect(disabledRowIndexes(w)).toEqual([1, 2]);

      // 再走勾选框 onChange 的等价路径（commit 'rowSelectedChanged'）钉一次：它内部调的
      // watcher.toggleRowSelection **默认 ignoreSelectable = false**，会读 selectable。
      clickRowCheckbox(w, rows[0]!.children![0]);
      clickRowCheckbox(w, rows[0]!.children![1]);
      await settle();

      expect(w.emitted(ev.event)).toBeFalsy();
      expect(checkedRowIndexes(w)).toEqual([]);

      // 散件行仍可逐行勾选（确认不是把整列 selectable 关掉了）
      clickRowCheckbox(w, rows[1]);
      await settle();
      const emitted = w.emitted(ev.event);
      expect((emitted![emitted!.length - 1]![0] as PartTreeRow[]).map((r) => r.id)).toEqual([
        'P:-:PLOOSE',
      ]);

      w.unmount();
    },
  );
});

describe('卡片头计数 = 表体实际展示行数（不是批次条数）', () => {
  it('3 个批次 / 1 套 2 件 ⇒ 头部显示 4 行（父行 1 + 子件 2 + 散件 1）', () => {
    const w = mountLineItemsTable(treeRows());
    expect(w.text()).toContain('零件列表 (4)');
    w.unmount();
  });
});

describe('勾选列开 reserve-selection（打印后绿底刷新不丢勾选）', () => {
  // 打印后会用已打印批次重算 `treeLineItems`（绿底刷新），行对象被整体替换。若勾选列没开
  // `reserve-selection`，EP 在 setData 时走 `clearSelection()` 分支 → 用户刚勾好、点完打印
  // 选区就空了，得重勾一遍。它是这条体验的**唯一**开关，删掉不会有任何报错，只能靠用例钉住。
  const cases: [string, (rows: PartTreeRow[]) => VueWrapper][] = [
    ['详情页表', mountLineItemsTable],
    ['草稿卡片表', mountDraftCard],
  ];

  it.each(cases)(
    '%s：selection 列的 reserveSelection 为 true（且已镜像进 store）',
    async (_name, mountFn) => {
      const w = mountFn(treeRows());
      await settle();

      const col = selectionColumnOf(w);
      expect(col, '没找到 type="selection" 的列').toBeTruthy();
      // 列实例上的 prop 是声明源头；store 里的那份是 EP 在 insertColumn 时抄进去的运行时值，
      // reserve 逻辑读的是后者 ⇒ 两处都断掉才算守住。
      expect((col!.props() as Record<string, unknown>).reserveSelection).toBe(true);
      expect(storeOf(w).states.reserveSelection.value).toBe(true);

      w.unmount();
    },
  );
});
