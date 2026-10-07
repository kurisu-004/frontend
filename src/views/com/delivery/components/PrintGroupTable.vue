<!--
  PrintGroupTable.vue — 打印预览的**单个分组表**（2026-10-08 新增）。

  el-tabs 的每个 tab 一张独立 el-table；本组件是那张表的 owner，因此
  `tbodyRef` / `useLazyDraggable` 实例 / `useColumnDrag` / 拆分态 / EP 表头 ref 都是
  **每 tab 一份** —— Sortable 绑的是 EP 内部渲染出的 DOM，多 tab 复用同一个实例会把
  A 表的拖拽算到 B 表的下标上。

  为什么不在父组件里统一处理：tab 是 `v-for` 出来的，模板里没法按 tab 调 composable，
  只能每个 tab 一个子组件。

  两类拖动并存，互不干扰：
  - **行拖动**（重排行序）：Sortable 绑 `<tbody>`，handle 是行内 `.drag-handle`；
  - **列拖动**（重排列序）：`useColumnDrag` 绑表头 `<tr>`，handle 是 `.col-drag-handle`，
    快照 key 带 groupKey 后缀（每张表一条独立序列）。

  ⚠️ CLAUDE.md 的「可拖元素 == vnode 的 DOM footprint ⇒ 根必须是单元素」约束**不适用
  于表格行**：Sortable 的 `draggable: 'tr'` 直接抓 EP 内部渲染的 `<tr>`，`<tbody>` 的子
  节点恒等于行集合。
-->
<template>
  <div class="print-group-table">
    <el-table
      ref="tableEl"
      :data="rows"
      row-key="id"
      aria-label="打印预览列表"
      stripe
      border
      max-height="440"
      :default-sort="{ prop: 'order_no', order: 'ascending' }"
      @sort-change="onSortChange"
    >
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :sortable="d.sortable"
          :align="d.align"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
      <!-- 数量列不进 defs：装配件父行是「只读套数 + tooltip」，散件行是纯文本，
           两套渲染不便走 cellRender；且数量只能通过「拆分」改（数量列只读）。 -->
      <el-table-column label="数量" min-width="120" align="right">
        <template #default="{ row }">
          <span v-if="row.is_asm_row" class="asm-qty" :title="asmQtyTitle(row as PrintRow)">
            {{ row.quantity ?? '—' }}<span v-if="row.quantity !== null" class="unit">套</span>
          </span>
          <span v-else>{{ row.quantity }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right" align="center">
        <template #default="{ row }">
          <el-button link size="small" :disabled="row.is_asm_row" @click="splitRowId = row.id">
            拆分
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 拆分编辑器挂在表格下方（跨列的整行控件，el-table 没有对应插槽） -->
    <PrintSplitEditor
      v-for="r in rows.filter((x) => x.id === splitRowId)"
      :key="r.id"
      :row="r"
      @done="(parts) => onSplitDone(r.id, parts)"
      @cancel="splitRowId = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { TableInstance } from 'element-plus';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import { resolveDraggable, type ColumnDef } from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import { findElTableTbody } from '@/utils/elTable';
import { printColumnOrderListKey } from '../deliveryNotePrintColumnDefs';
import { sortPrintRows, type PrintRow } from '../utils/deliveryNotePrintRows';
import PrintSplitEditor from './PrintSplitEditor.vue';

const props = defineProps<{
  /** 本 tab 的行（父组件持有；拖拽 / 排序只改这里的引用，父组件的 map 被整体替换）。 */
  rows: PrintRow[];
  /** 排序态：'column' = 表头排序，'custom' = 用户拖过（自定义顺序优先）。 */
  sortMode: 'column' | 'custom';
  /** 列定义与列可见性由**父组件**持有（N 张表共用一份可见性快照）。 */
  columnDefs: ColumnDef[];
  columnVisibility: {
    isVisible: (key: string) => boolean;
    update: (next: Record<string, boolean>) => void;
    showAll: () => void;
    currentMap: Record<string, boolean>;
  };
  /**
   * 列顺序快照的分组后缀（= 本 tab 的 groupKey）：每张表一条独立序列，
   * 快照 key 由 `printColumnOrderListKey(groupKey)` 拼出（见父组件）。
   */
  groupKey: string;
  /** 「重置列顺序」的信号量（父组件点 popover 的「重置列顺序」时自增）。 */
  resetOrderToken: number;
}>();

const emit = defineEmits<{
  /** 行数组被改动（拖拽 / 拆分）后交给父组件写回 map。 */
  'update:rows': [rows: PrintRow[]];
  'update:sortMode': [mode: 'column' | 'custom'];
}>();

const tableEl = ref<TableInstance | null>(null);
const tbodyRef = ref<HTMLElement | null>(null);
const splitRowId = ref<string | null>(null);

// 列顺序拖动：每张分组表一份 useColumnDrag（快照 key 带 groupKey 后缀 ⇒ N 张表互不覆盖）。
// 绑定目标是本表自己的 el-table 实例 ref。
// ⚠️ `columnDefs` / `groupKey` 在本组件生命周期内**不变**（父组件的 tab pane 以
// `groupKey` 为 :key，groupKey 变即整表重挂载），而 useColumnDrag 的 defs 与 listKey
// 都只在 setup 时读一次 —— 所以用 IIFE 读 props（沿 OutsourceQuoteTable 的写法，绕开
// vue/no-setup-props-destructure 的「顶层直读 props 会丢响应性」）。
const drag = (() => {
  const { columnDefs, groupKey } = props;
  return useColumnDrag(columnDefs, { listKey: printColumnOrderListKey(groupKey) });
})();
drag.applyDrag(tableEl);

// 「重置列顺序」是 popover 上的单个按钮，作用于全部 N 张表 ⇒ 父组件自增信号量，
// 各表 watch 到变化就 reset 自己那条序列（reset 会写盘）。
watch(
  () => props.resetOrderToken,
  () => drag.reset(),
);

// 拖拽：useLazyDraggable 三参形态（传 listRef）—— 真正的场景是「同容器内重排」，
// list 就是渲染源，内建 onUpdate 的 splice 与我们的 rows 一致，故不自己补 onRemove。
// rowsRef 是 props.rows 的可写镜像：库拿到的是 Ref<PrintRow[]>，写它等价于 emit
// 「行数组变了」交给父组件（父组件是 rows 的唯一持有者）。
const rowsRef = computed({
  get: () => props.rows,
  set: (v: PrintRow[]) => emit('update:rows', v),
});

useLazyDraggable(tbodyRef, rowsRef, {
  handle: '.drag-handle',
  draggable: 'tr',
  animation: 150,
  ghostClass: 'sortable-ghost',
  onEnd(evt: { oldIndex?: number; newIndex?: number }) {
    const { oldIndex, newIndex } = evt;
    if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
    const next = props.rows.slice();
    const [moved] = next.splice(oldIndex, 1);
    if (moved) next.splice(newIndex, 0, moved);
    emit('update:rows', next);
    // 拖拽 = 用户接管了顺序 ⇒ 清排序标记（也清掉 EP 的箭头，否则视觉上在骗人）。
    emit('update:sortMode', 'custom');
    tableEl.value?.clearSort();
  },
});

/** tbodyRef 在 setup 时为 null（弹窗未打开），且 el-dialog destroy-on-close 关闭时销毁
 * slot、reopen 时 <tbody> 是新元素 ⇒ 用 useLazyDraggable：refreshTbodyRef() 写 ref 即
 * 自动重绑，无需手动 start()。 */
function refreshTbodyRef(): void {
  tbodyRef.value = findElTableTbody((tableEl.value?.$el as HTMLElement | undefined) ?? null);
}

// rows 变化（排序 / 拆分 / 父组件重建）与 mount 都要重绑 tbody：EP 在 mount 与
// 数据引用变化时都会重建表体 DOM。
watch(
  () => props.rows,
  async () => {
    await nextTick();
    refreshTbodyRef();
  },
);

onMounted(() => {
  void nextTick().then(() => refreshTbodyRef());
});

function onSortChange({ prop, order }: { prop: string | null; order: string | null }): void {
  // 三态点击（order=null）不改状态，照仓内惯例。
  if (!prop || !order) return;
  // prop 是 snake_case 字段名本身，不做枚举映射、不上传后端。
  emit('update:rows', sortPrintRows(props.rows, prop, order === 'ascending' ? 'asc' : 'desc'));
  emit('update:sortMode', 'column');
}

function onSplitDone(rowId: string, parts: PrintRow[]): void {
  emit('update:rows', props.rows.flatMap((r) => (r.id === rowId ? parts : [r])));
  splitRowId.value = null;
}

/** 装配件父行数量列 tooltip：工单总套数 vs 本单可出货套数。任一项后端没给数都显示「—」。 */
function asmQtyTitle(r: PrintRow): string {
  return `工单总套数 ${r.assembly_quantity ?? '—'} 套；本单可出货 ${r.quantity ?? '—'} 套`;
}
</script>

<style scoped>
.asm-qty .unit {
  color: var(--el-text-color-secondary);
}
.drag-handle {
  cursor: grab;
  color: var(--primary-color);
  margin-right: 4px;
}
.drag-handle:active {
  cursor: grabbing;
}
.row-index {
  color: var(--text-secondary);
  font-size: 12px;
}
:deep(.sortable-ghost) {
  opacity: 0.4;
  background: #eaf2fb !important;
}
:deep(.sortable-chosen) {
  background: #cce0f4 !important;
}
</style>