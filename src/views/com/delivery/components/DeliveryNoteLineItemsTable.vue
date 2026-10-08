<!--
  DeliveryNoteLineItemsTable.vue

  送货单详情「零件列表」卡（DeliveryNoteDetail 第 2 张卡）：
  - 顶部 actions：列显隐 popover + 移除选中（加件入口随 `POST /{id}/add-parts` 下线）
  - 主区域：el-table（tree-props + selection + sort-change + 列顺序拖动）
    行高亮 = 「已打印标签」绿底（行代表的所有批次里任一打过即整行绿；装配件父行不绿，
    绿底由子件行体现）。

  行形态是 `PartTreeRow`（装配件父行 + 零件行），由父 composable 派生后注入；
  本组件只负责 UI 编排 + 选择事件转发。列定义**只有一份**（域根
  `deliveryNoteLineItemsColumnDefs.ts`，含 cellRender / 宽度 / 排序等元数据），
  可见性与列顺序都直接吃它 —— 不在组件内另建副本。

  业务状态（note / treeLineItems / columnVisibility / selectedRows / role）由父组件通过
  prop 注入；状态标签的文案映射由列定义自己读 `@/types/parts`（域根那份列定义是唯一
  一份渲染逻辑，不再经 prop 注入两个等价 helper）。

  2026-08-25 frontend-overall-refactor：从 DeliveryNoteDetail.vue 抽出。
  2026-08-27 T17：接入列顺序拖动（HTMLElement 路径 — el-card v-if="note" 始终为 truthy 后 el-table 一直在 DOM）。
  2026-10-09：删掉组件内的列定义副本（本文件曾有第二份，与域根那份重复且已漂移）；
    勾选列对装配件父行也放开（INSPECTOR 能打印但不能改单，原来「装配件父行不可勾」会把
    它们挡在打印之外）；勾选列开 `reserve-selection`，打印后绿底重算不丢勾选。
-->
<template>
  <el-card v-if="note" shadow="never" class="line-items-card">
    <template #header>
      <div class="card-header">
        <span>零件列表 ({{ note.line_items.length }})</span>
        <div class="actions">
          <!-- 2026-08-02：列显隐控制；2026-08-27 T17 增 @resetOrder -->
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap"
            @update:model-value="(v: Record<string, boolean>) => columnVisibility.update(v)"
            @reset="columnVisibility.showAll"
            @resetOrder="drag.reset"
          />
          <el-button
            v-if="canEdit && selectedRows.length"
            type="danger"
            size="small"
            @click="emit('removeSelected')"
          >
            移除选中 ({{ selectedRows.length }})
          </el-button>
        </div>
      </div>
    </template>
    <!-- 2026-08-22 a11y：selection 列所在 table 加 aria-label -->
    <el-table
      ref="tableRef"
      :data="treeLineItems"
      row-key="id"
      aria-label="送货单明细列表"
      :row-class-name="deliveryLineRowClassName"
      :tree-props="{ children: 'children', hasChildren: 'has_children' }"
      default-expand-all
      stripe
      border
      height="500"
      highlight-current-row
      @selection-change="onSelectionChange"
      @sort-change="onSortChange"
    >
      <!-- selection / index 始终可见，不放 defs。
           可见条件 = 可改单 **或** 可打印：INSPECTOR 能打印但不能改单，把勾选列只挂在
           canEdit 下会让他们看不到「打印标签」要用的勾选入口。装配件父行同样可勾 ——
           它代表整套货，标签就是按套出的。`reserve-selection` 让打印后绿底触发的行重算
           不丢勾选（连续打多批时体验）。 -->
      <el-table-column v-if="showSelection" type="selection" width="50" reserve-selection />
      <el-table-column type="index" label="#" width="50" />
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
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TableInstance } from 'element-plus';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { resolveDraggable, type ColumnDef } from '@/composables/useColumnVisibility';
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag';
import { canPrint } from '@/utils/deliveryNotePermissions';
import type { DeliveryNoteDetailData } from '../composables/deliveryNoteSchema';
import type { DeliveryNoteRoleMap } from '../composables/useDeliveryNoteDetail';
import type { PartTreeRow } from '../utils/deliveryNotePartRows';

interface Props {
  note: DeliveryNoteDetailData | null;
  /** 权限 flag（可勾选移除 / 改单） */
  canEdit: boolean;
  /** 角色矩阵（打印判据 canPrint(note, role) 需要它） */
  role: DeliveryNoteRoleMap;
  /** 树形化后的行（composable 提供） */
  treeLineItems: PartTreeRow[];
  /** 列定义（域根唯一一份，含 cellRender / 宽度 / 排序元数据） */
  columnDefs: readonly ColumnDef[];
  columnVisibility: {
    isVisible: (key: string) => boolean;
    update: (next: Record<string, boolean>) => void;
    showAll: () => void;
    currentMap: Record<string, boolean>;
  };
  /** 勾选中的零件 / 装配件行（行本身可能代表多个批次） */
  selectedRows: PartTreeRow[];
  /** 行样式 helper（composable 提供；绿底判据在那侧） */
  deliveryLineRowClassName: (ctx: { row: PartTreeRow }) => string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** 点「移除选中」 */
  removeSelected: [];
  /** 勾选变化（一行 = 零件 / 装配件，不是批次 id） */
  selectionChange: [rows: PartTreeRow[]];
  /** 排序变化 */
  sortChange: [
    sort: {
      prop: string | null;
      order: 'ascending' | 'descending' | null;
    },
  ];
}>();

/** 勾选列可见：能改单（移除）或能打印（打标签）任一即可。 */
const showSelection = computed(
  () => props.canEdit || (props.note != null && canPrint(props.note, props.role)),
);

// 2026-08-27 T17：列顺序拖动接入。
// ⚠️ IIFE 读 props：`columnDefs` 在本组件生命周期内不变（父 composable 只建一次），
// 而 useColumnDrag 的 defs / listKey 都只在 setup 时读一次（沿 PrintGroupTable 写法，
// 绕开 vue/no-setup-props-destructure 的「顶层直读 props 会丢响应性」）。
const drag = (() => {
  const { columnDefs } = props;
  return useColumnDrag(columnDefs, { listKey: 'delivery_note_detail_line_items' });
})();

const tableRef = ref<TableInstance | null>(null);
// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
drag.applyDrag(tableRef);

/** 移除勾选行后清 EP 的勾选：开了 `reserve-selection` 就不主动清的话，保留集里还留着
 *  已删行的 row-key，同一零件被重新扫码入单会带着没出纸的勾选态回来。 */
function clearSelection(): void {
  tableRef.value?.clearSelection();
}
defineExpose({ clearSelection });

function onSelectionChange(rows: PartTreeRow[]): void {
  emit('selectionChange', rows);
}

function onSortChange(sort: {
  prop: string | null;
  order: 'ascending' | 'descending' | null;
}): void {
  emit('sortChange', sort);
}
</script>

<style lang="scss" scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.actions {
  display: flex;
  gap: 8px;
}
.asm-tag {
  margin-right: 6px;
}
.assembly-link {
  color: var(--primary-color);
  text-decoration: none;
}
.assembly-link:hover {
  text-decoration: underline;
}
.muted {
  color: var(--text-secondary);
}

/* ============ 已打印标签行绿底 ============ */
/* 与扫码建单页的草稿卡片同款判据（同一份 usePrintedLabels 记录）。 */
:deep(.el-table__row.row-printed) > td.el-table__cell {
  background-color: #e6f7e6 !important;
}
:deep(.el-table__row.row-printed:hover) > td.el-table__cell {
  background-color: #d6efd6 !important;
}
</style>