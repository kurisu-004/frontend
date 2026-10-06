<!--
  InspectionTable.vue

  2026-10-03 新建：待品检一览的表格。状态全部来自 `useInspectionListStore`
  （Pinia setup store），本组件只持有 el-table 的 DOM 逻辑：列拖动 + tableRef 暴露 +
  排序箭头恢复。形态照 `views/parts/list/components/PartsTable.vue`。

  为什么不用 `ListShell`：ListShell 自管分页 / 勾选 / 排序的本地状态机，filter 插槽与
  `ColumnDef.headerRender`（表头筛选 popover）不在同一层，挂不进去；且它的 fetcher 范式
  没有缓存 / 失效点。详见 useInspectionListStore.ts 文件头。

  row-key 用 `batch_id`：待品检 VO 没有 `id` 字段（那是 t_part.id 的另一个名字），
  沿用 ListShell 的死键 row-key="id" 会让整表 key 全是 undefined。
-->
<template>
  <div class="inspection-table-wrap">
    <div class="inspection-table-toolbar">
      <el-button link @click="store.query.resetAllFilters()">重置筛选</el-button>
      <ColumnVisibilityPopover
        :defs="store.columnDefs"
        :model-value="store.columnVisibility.currentMap"
        @update:model-value="store.columnVisibility.update"
        @reset="store.columnVisibility.showAll"
        @resetOrder="drag.reset"
      />
    </div>

    <el-table
      ref="tableRef"
      v-loading="store.query.loading"
      :data="store.query.items"
      :row-key="rowKey"
      :default-sort="store.query.defaultSort"
      :row-class-name="rowClassName"
      max-height="calc(100vh - 280px)"
      highlight-current-row
      aria-label="待品检列表"
      stripe
      border
      size="small"
      style="width: 100%"
      @sort-change="store.query.onSortChange"
    >
      <template #empty>
        <el-empty :description="store.query.emptyText" />
      </template>

      <!--
        7 数据列 + 1 操作列，全部由 store.columnDefs 驱动（顺序走 drag.orderedDefs，
        可见性走 store.columnVisibility）。#header 插槽 = headerRender（表头筛选
        popover）或 d.label + ColumnDragHandle；#default 插槽 = cellRender。
        ColumnFilterPopover 内部已把 .el-table .cell 排成 flex 并给 .cfp-header
        order:2，所以表头 popover 与 EP 排序箭头能排在一行。
      -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="store.columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :type="d.type"
          :width="d.width"
          :min-width="d.minWidth"
          :fixed="d.fixed"
          :sortable="d.sortable"
          :align="d.align"
          :header-align="d.headerAlign"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :formatter="d.formatter"
          :filters="d.filters"
          :filter-multiple="d.filterMultiple"
          :filter-method="d.filterMethod"
          :filtered-value="d.filteredValue"
          :sort-method="d.sortMethod"
          :sort-by="d.sortBy"
          :sort-orders="d.sortOrders"
          :resizable="d.resizable"
          :class-name="d.className"
          :label-class-name="drag.dragLabelClass(d)"
          :column-key="d.columnKey ?? d.key"
        >
          <template
            v-if="d.headerRender || (resolveDraggable(d) && !d.type && !d.fixed)"
            #header="scope"
          >
            <component :is="d.headerRender(scope)" v-if="d.headerRender" />
            <span v-else>{{ d.label }}</span>
            <ColumnDragHandle
              v-if="resolveDraggable(d) && !d.type && !d.fixed"
              :title="`拖动 ${d.label} 列`"
            />
          </template>
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
        </el-table-column>
      </template>
    </el-table>
  </div>
</template>

<script setup lang="ts">
// views/inspection/components/InspectionTable.vue
//
// 2026-10-03 新建：见文件头。本组件 0 业务状态 —— 所有数据 / 筛选 / 排序都来自 store。

import { onMounted, ref } from 'vue';
import type { TableInstance } from 'element-plus';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import { resolveDraggable } from '@/composables/useColumnVisibility';
import type { InspectionQueueItem } from '@/api/parts';
import { useInspectionListStore } from '../composables/useInspectionListStore';

const store = useInspectionListStore();

// ============ 列顺序拖动 ============
// 与 store.columnVisibility 共享同一 columnDefs 数组；各自读自己的 localStorage key
// （`inspection_pending_columnOrder` / `inspection_pending_columns`），互不污染。
// 拖动实例必须在组件里（列定义在 store，DOM 在组件）—— 与 PartsTable 同款分工。
const drag = useColumnDrag(store.columnDefs, { listKey: 'inspection_pending' });

// ============ 表格 ref（暴露给父组件做排序箭头恢复）============
const tableRef = ref<TableInstance | null>(null);
defineExpose({ tableRef });

// ============ 本地辅助函数 ============
function rowKey(row: InspectionQueueItem): string {
  return row.batch_id;
}

/** 加急行整行红底（与零件一览同款视觉信号）。 */
function rowClassName({ row }: { row: InspectionQueueItem }): string {
  return row.is_urgent ? 'row-urgent' : '';
}

onMounted(() => {
  drag.applyDrag(tableRef);
});
</script>

<style lang="scss" scoped>
.inspection-table-wrap {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 4px;
  overflow-x: auto;
}

.inspection-table-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 8px;
  min-height: 32px;
}

// 操作列三个按钮挤在一格：左对齐 + 小间距。
:deep(.row-actions) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

// 列定义在 src/views/inspection/inspectionColumnDefs.ts 里用 h() 造的单元格节点（空值占位 /
// 名称链接 / 批次等宽 chip）。它们不在本组件模板的渲染输出里 ⇒ scoped 选择器带不上
// scopeId，必须用 :deep() 才能命中（scoped 写法会静默失效）。
:deep(.muted) {
  color: var(--text-secondary);
}
:deep(.name-link) {
  color: var(--el-color-primary);
  text-decoration: none;
}
:deep(.name-link:hover) {
  text-decoration: underline;
}
:deep(.batch-label) {
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
  font-weight: 600;
}

// 加急行：dashboard 同款红底 #fde2e2（与默认 .el-table 浅灰底可叠加）。
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
:deep(.el-table__row.row-urgent.current-row > td.el-table__cell) {
  background-color: #fbcaca !important;
}

// 列顺序拖动视觉反馈（与 PartsTable / ListShell 同款藏青/蓝/浅蓝系）。
:deep(.col-no-drag) {
  cursor: default !important;
}
:deep(.sortable-ghost) {
  opacity: 0.5;
  background: #eaf2fb !important;
}
:deep(.sortable-chosen) {
  background: #cce0f4 !important;
}
:deep(.sortable-drag) {
  background: #fff !important;
}
</style>
