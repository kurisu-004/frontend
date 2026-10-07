<!--
  OutsourceQuoteTable.vue — 报价一览 el-table 子组件

  2026-10-09：`:ctx` prop 模式（整包接收 useOutsourceQuoteTable 实例）改为直接消费
  `useOutsourceQuoteListStore()`（切片形态），与 OutsourceList / 外协对账页统一。本组件
  **0 业务状态**：数据 / 筛选 / 排序 / 列可见性全部来自 store。
  行点击 → emit('rowClick', row)；操作列按钮 → emit('action', { type, row })
  （避免子组件直接 import useOutsourceQuoteForm 的业务函数）。

  本轮列头改造：原先「状态」「客户」两列是手写 el-popover 的 literal
  <el-table-column>，本轮改共享 ColumnFilterPopover（列定义在
  `../outsourceQuoteColumnDefs.ts`，9 列全部走 defs ⇒ 都能被列顺序拖动）。
-->
<template>
  <div class="quote-table-wrap">
    <div class="table-toolbar">
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
      row-key="id"
      :empty-text="store.query.emptyText"
      stripe
      border
      size="small"
      :default-sort="store.query.defaultSort"
      :row-class-name="store.quoteRowClassName"
      @sort-change="store.query.onSortChange"
      @filter-change="store.query.onNativeFilterChange"
      @row-click="onRowClick"
    >
      <template #empty>
        <el-empty :description="store.query.emptyText" />
      </template>

      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="store.columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :sortable="d.sortable"
          :align="d.align"
          :filters="d.filters"
          :filter-multiple="d.filterMultiple"
          :filtered-value="d.filteredValue"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
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

      <!-- 操作列（始终可见；不进 defs） -->
      <el-table-column label="操作" :min-width="store.actionColumnWidth" fixed="right" align="center">
        <template #default="{ row }">
          <el-button
            v-if="canSubmit(row as OutsourceQuoteSchema)"
            size="small"
            @click.stop="$emit('action', { type: 'submit', row: row as OutsourceQuoteSchema })"
            >提交审核</el-button
          >
          <el-button
            v-if="canApprove(row as OutsourceQuoteSchema)"
            size="small"
            type="success"
            @click.stop="$emit('action', { type: 'approve', row: row as OutsourceQuoteSchema })"
            >通过</el-button
          >
          <el-button
            v-if="canReject(row as OutsourceQuoteSchema)"
            size="small"
            type="danger"
            @click.stop="$emit('action', { type: 'reject', row: row as OutsourceQuoteSchema })"
            >拒绝</el-button
          >
          <el-button
            v-if="canSoftDelete(row as OutsourceQuoteSchema)"
            size="small"
            type="danger"
            @click.stop="$emit('action', { type: 'delete', row: row as OutsourceQuoteSchema })"
            >删除</el-button
          >
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination">
      <el-pagination
        v-model:current-page="store.query.page"
        v-model:page-size="store.query.pageSize"
        :page-sizes="[20, 50, 100]"
        :total="store.query.total"
        layout="total, sizes, prev, pager, next, jumper"
        :pager-count="7"
        background
        size="small"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
// views/outsource/components/OutsourceQuoteTable.vue
import { ref } from 'vue';
import type { TableInstance } from 'element-plus';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import { resolveDraggable } from '@/composables/useColumnVisibility';
import { canApprove as canApproveQuote, canEdit, canReject as canRejectQuote, canSoftDelete as canSoftDeleteQuote } from '@/utils/outsourceQuotePermissions';
import { useOutsourceQuoteListStore } from '../composables/useOutsourceQuoteListStore';
import type { OutsourceQuoteSchema } from '../composables/outsourceListSchema';
import type { OutsourceQuoteStatus } from '@/types/outsource';
// 2026-10-09：列定义搬进 `outsourceQuoteColumnDefs.ts` 后，本组件模板里不再出现这 6 个
// 标签，而它们是用 h() 在 .ts 里直挂的（unplugin-vue-components 只处理模板标签 ⇒ 拿不到
// 样式注入）。显式补副作用 import，理由同 OutsourceList.vue 的同名注释。
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/link/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/tree-select/style/css';

const emit = defineEmits<{
  rowClick: [row: OutsourceQuoteSchema];
  action: [payload: { type: 'submit' | 'approve' | 'reject' | 'delete'; row: OutsourceQuoteSchema }];
}>();

// store 由父壳 `OutsourceQuoteList.vue` 首调（不变量 #1；`$dispose` 也在父壳）——
// 本组件只消费不实例化：Pinia 是单例，两处 setup 都调无害，但首调者决定
// `onBeforeUnmount` 绑在谁身上，规矩写在父壳才不歧义。
const store = useOutsourceQuoteListStore();

const drag = useColumnDrag(store.columnDefs, { listKey: 'outsource_quote_table' });
const tableRef = ref<TableInstance | null>(null);
drag.applyDrag(tableRef);

function onRowClick(row: unknown): void {
  emit('rowClick', row as OutsourceQuoteSchema);
}

/** 四个权限判定的薄封装（模板里 `row as X` 噪声大，收在函数里）。
 *
 *  `OutsourceQuoteSchema.status` 按 `z.string()` 收（DB 里存着 legacy 值，见
 *  `outsourceListSchema.ts` 的说明），而权限判定的入参声明成 `OutsourceQuoteStatus`
 *  —— 这里是**唯一**需要 cast 的地方：判定只认四个活跃值，其余一律落到各判定的
 *  false 分支（`=== 'DRAFT'` / `=== 'SUBMITTED'` 都不相等）。 */
const roleMap = store.roleMap;
function statusOf(row: OutsourceQuoteSchema): OutsourceQuoteStatus {
  return row.status as OutsourceQuoteStatus;
}
function canSubmit(row: OutsourceQuoteSchema): boolean {
  return canEdit({ status: statusOf(row) }, roleMap);
}
function canApprove(row: OutsourceQuoteSchema): boolean {
  return canApproveQuote({ status: statusOf(row) }, roleMap);
}
function canReject(row: OutsourceQuoteSchema): boolean {
  return canRejectQuote({ status: statusOf(row) }, roleMap);
}
function canSoftDelete(row: OutsourceQuoteSchema): boolean {
  return canSoftDeleteQuote({ status: statusOf(row) }, roleMap);
}
</script>

<style lang="scss" scoped>
.quote-table-wrap {
  background: #fff;
}
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.muted {
  color: var(--text-secondary);
}
// 原生 :filters 列的激活态视觉（蓝字加粗 + 计数），与零件一览同款。
.status-header {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.status-count {
  font-weight: 600;
}
:deep(.el-table__row.quote-row-clickable) {
  cursor: pointer;
}
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover) > td.el-table__cell {
  background-color: #fbcaca !important;
}
</style>