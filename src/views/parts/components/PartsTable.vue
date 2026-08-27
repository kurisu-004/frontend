<!--
  PartsTable.vue

  2026-08-22 从 PartsList.vue 抽出：纯 el-table 桌面表格组件。

  设计要点：
  - 用纯 el-table 替代 ResponsiveList 桌面分支（手机适配已移除）。
  - 列定义 / 行内编辑 / 批量选中 / 表头 popover 全部从 ctx.* 解构到顶层局部变量
    再进模板（Vue 模板只对 setup 顶层 ref 自动解包）。
  - 父组件通过 ref="partsTableRef" 拿到 `tableRef`（el-table 实例），可调
    clearSelection / toggleRowSelection / sort。
-->
<template>
  <div ref="wrapEl" class="parts-table-wrap" :key="tableKey">
    <div class="parts-table-toolbar">
      <el-button link @click="resetAllFilters">重置筛选</el-button>
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <el-table
      ref="tableRef"
      :data="items"
      :row-key="rowKey"
      :default-sort="defaultSort"
      :row-class-name="rowClassName"
      :row-style="{ cursor: batchMode ? 'pointer' : 'default' }"
      :show-summary="canEdit"
      :summary-method="totalPriceSummary"
      lazy
      :load="loadChildren"
      :tree-props="{ hasChildren: 'has_children', children: 'children' }"
      max-height="calc(100vh - 280px)"
      highlight-current-row
      aria-label="零件列表"
      stripe
      border
      size="small"
      style="width: 100%"
      @sort-change="onSortChange"
      @selection-change="onSelectionChange"
      @row-click="onBatchRowClick"
      @row-dblclick="onRowDblClick"
      @filter-change="onNativeFilterChange"
    >
      <template #empty>
        <el-empty :description="emptyText" />
      </template>

      <!-- 1. selection（批量模式） -->
      <el-table-column
        v-if="batchMode"
        type="selection"
        width="55"
        :reserve-selection="true"
        :selectable="isBatchSelectable"
      />

      <!--
        2..19. 18 列数据列（2026-08-27 Task 6 接入）
        drag.orderedDefs 提供持久化顺序；columnDefs.cellRender / headerRender 工厂
        在 PartsList.vue 里持有 filter ref / editingId / editBuffer 等响应式闭包。
        #header 插槽两套：
          - 有 headerRender 的列（ColumnFilterPopover 9 列 + status / next_process 自定义 badge）：
            走 d.headerRender(scope)；拖动手柄放在 popover 内部 / 自定义 span 内。
          - 无 headerRender 的可拖列（非 type / 非 fixed）：渲染 label + ColumnDragHandle。
        sortablejs 通过 .col-no-drag filter 跳过 type=selection/index/expand 与 fixed 列。
      -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
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
          :label-class-name="
            resolveDraggable(d) ? d.labelClassName : `col-no-drag ${d.labelClassName ?? ''}`.trim()
          "
          :column-key="d.columnKey ?? d.key"
        >
          <!-- 自定义表头（ColumnFilterPopover / 选中计数 badge） -->
          <template v-if="d.headerRender" #header="scope">
            <component :is="d.headerRender(scope)" />
          </template>
          <!-- 可拖列的默认 label + 拖动手柄（无 headerRender 时走这里） -->
          <template v-else-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
          <!-- 自定义单元格（editing 切换 / 状态 tag / 链接 / 装配件 tag 等） -->
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
        </el-table-column>
      </template>

      <!-- 20. 操作 -->
      <el-table-column label="操作" min-width="160" fixed="right" align="center">
        <template #default="{ row }">
          <template v-if="editingId === row.id">
            <el-button
              link
              type="primary"
              size="small"
              :loading="savingEdit"
              @click="saveEdit(row as PartListItem)"
            >保存</el-button>
            <el-button link size="small" @click="cancelEdit">取消</el-button>
          </template>
          <template v-else>
            <el-button link type="primary" size="small" @click="onDetail(row as PartListItem)">详情</el-button>
            <el-button v-if="canEdit" link type="warning" size="small" @click="startEdit(row as PartListItem)">编辑</el-button>
            <el-button
              v-if="canEdit && row.status === 'PENDING' && row.row_type !== 'ASSEMBLY'"
              link
              type="success"
              size="small"
              @click="onDispatch(row as PartListItem)"
            >下发</el-button>
            <el-button
              v-if="canRecallToPending(row as PartListItem)"
              link
              type="danger"
              size="small"
              @click="onRecallToPending(row as PartListItem)"
            >召回(待生产)</el-button>
            <el-button
              v-if="canRecallToProgramming(row as PartListItem)"
              link
              type="warning"
              size="small"
              @click="onRecallToProgramming(row as PartListItem)"
            >召回(待编程)</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
// views/parts/components/PartsTable.vue
//
// 2026-08-22 从 PartsList.vue 抽出：纯 el-table 桌面表格。
// 列定义 / 行内编辑 / 批量选中 / 表头 popover 全通过 props.ctx.* 解构到顶层局部
// 变量后进模板（Vue 模板只对顶层 ref 自动解包；嵌套 ref 不会自动解包）。

import { onMounted, ref } from 'vue'
import type { TableInstance } from 'element-plus'
import { useRouter } from 'vue-router'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import {
  useColumnDrag,
  columnIdentifier,
} from '@/composables/useColumnDrag'
import { resolveDraggable } from '@/composables/useColumnVisibility'
import { findElTableThead } from '@/utils/elTable'
import type { PartListItem } from '@/types/parts'
import { getAssembly } from '@/api/assembly'
import type { PartsListCtx } from '../composables/partsListCtx'

const props = defineProps<{ ctx: PartsListCtx }>()

// ============ 解构 ctx 到顶层局部变量（模板自动解包）============
const {
  query,
  filters,
  edit,
  batch,
  dispatch,
  canEdit,
  columnVisibility,
  columnDefs,
} = props.ctx

const {
  items,
  tableKey,
  defaultSort,
  emptyText,
  onSortChange,
} = query

const {
  serialNoFilter,
  drawingNoFilter,
  nameFilter,
  orderNoFilter,
  requestDateFilter,
  plannedDateFilter,
  systemDateFilter,
  customerFilter,
  customerTree,
  locationFilter,
  locationTree,
  statusNativeOptions,
  statusFilteredValue,
  statusSelectedCount,
  nextProcessOptions,
  nextProcessFilteredValue,
  nextProcessSelectedCount,
  onNativeFilterChange,
  serialNoFlash,
} = filters

const {
  editingId,
  savingEdit,
  editBuffer,
  startEdit,
  saveEdit,
  cancelEdit,
  onRowDblClick,
  displayTotalPrice,
  totalPriceSummary,
  applicantSuggest,
  applicantLoading,
} = edit

const {
  batchMode,
  isBatchSelectable,
  onSelectionChange,
  onBatchRowClick,
} = batch

const {
  onDispatch,
  canRecallToPending,
  canRecallToProgramming,
  onRecallToPending,
  onRecallToProgramming,
} = dispatch

const router = useRouter()

// ============ 列顺序拖动（2026-08-27 Task 6 接入）============
// 与 PartsList 的 useColumnVisibility 共享同一 columnDefs 数组：
// 各自 read 同一 localStorage key（myerp.list.<userId>.parts_list_columnOrder），
// orderedKeys 在 sortablejs onEnd 时落盘，二者内存里的 orderedKeys 通过持久化层一致。
// listKey 取 PartsList useColumnVisibility 已用的 'parts_list_columns' 同根命名空间，
// 但 columnOrder 与 _columns 持久化分 key，互不污染。
const drag = useColumnDrag(columnDefs, { listKey: 'parts_list' })

// ============ 表格 ref（暴露给父组件）============
const tableRef = ref<TableInstance | null>(null)
defineExpose({ tableRef })

// 2026-08-23：工具栏「重置筛选」按钮 —— 一键清空所有列筛选（文本/日期/status/客户/位置/holder）。
// 把 el-table.clearFilter 注入 query composable，让 query.resetAllFilters 能不持有
// tableRef 的情况下清掉原生筛选列（status / next_process）的内部勾选态。
// EP clearFilter 会 emit filter-change，onNativeFilterChange 顺手把 search.* 同步清空。
//
// 2026-08-27 Task 6：列顺序拖动挂 useDraggable 到 <thead>。PartsTable 非 dialog 非 v-if，
// tableRef.$el 在 onMounted 时已就绪 → 走 HTMLElement 路径（更直接，省一个 Ref 闭包）。
// onMounted(() => { ... }) 同一钩子内：先注册 clearNativeFilters，再 applyDrag。
onMounted(() => {
  query.registerClearNativeFilters(() => {
    tableRef.value?.clearFilter(['status', 'next_process'])
  })
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (root) {
    const thead = findElTableThead(root)
    if (thead) drag.applyDrag(thead)
  }
})

// 工具栏按钮的简短转发，模板里直接 @click="resetAllFilters"
const resetAllFilters = (): void => {
  query.resetAllFilters()
}

// ============ 本地辅助函数 ============
// 2026-07-30：树表 row-key（避免顶层与子件 id 冲突）
function rowKey(row: PartListItem): string {
  if (row.row_type === 'ASSEMBLY') return `ASM_${row.id}`
  if ((row as { __is_child?: boolean }).__is_child) return `CHILD_${row.id}`
  return `PART_${row.id}`
}

// 2026-07-30：懒加载装配件子件
// 2026-08-05 C2：优先消费 row.matched_children（位置类筛选激活时后端已带出
// 命中子件全集），避免每次展开都触发 /assemblies/{id} 详情查询。
async function loadChildren(
  row: PartListItem,
  _treeNode: unknown,
  resolve: (children: PartListItem[]) => void,
): Promise<void> {
  if (row.row_type !== 'ASSEMBLY') {
    resolve([])
    return
  }
  if (row.matched_children) {
    resolve(
      row.matched_children.map((c) => ({
        ...c,
        __is_child: true,
        row_type: 'PART' as const,
        has_children: false,
      })),
    )
    return
  }
  try {
    const detail = await getAssembly(row.id)
    const children = (detail.children ?? []).map((child) => ({
      ...child,
      __is_child: true,
      row_type: 'PART' as const,
      has_children: false,
    })) as PartListItem[]
    resolve(children)
  } catch {
    resolve([])
  }
}

function rowClassName({ row }: { row: PartListItem }): string {
  if (row.is_urgent) return 'row-urgent'
  // PR-G 2026-07-22：已开具送货单（且尚未归档）的零件行用浅蓝染色；
  // DELIVERED / COMPLETED / CANCELLED 后 delivery_note_id 被 service 置 NULL，颜色自然消失。
  if (
    row.delivery_note_id
    && row.status !== 'DELIVERED'
    && row.status !== 'COMPLETED'
  ) {
    return 'row-on-delivery-note'
  }
  return ''
}

function onDetail(row: PartListItem): void {
  void router.push(
    row.row_type === 'ASSEMBLY' ? `/assemblies/${row.id}` : `/parts/${row.id}`,
  )
}
</script>

<style lang="scss" scoped>
// 2026-08-22：从 ResponsiveList.vue 的 .rl-table-wrap 搬来；类名改为 parts-table-wrap。
.parts-table-wrap {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 4px;
  overflow-x: auto;
}

// 2026-08-22：从 ResponsiveList.vue 的 .rl-toolbar 搬来。
.parts-table-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 8px;
  min-height: 32px;
}

.muted {
  color: var(--text-secondary);
}

.name-link {
  color: var(--primary-color);
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
}

// 2026-08-20：列头 popover 内的单行排版（input + 仅空白 checkbox）。
// 与外层 .filter-row（顶部三组分类）同名冲突，故单独命名。
.filter-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

// 2026-08-22：状态 / 下一道工序列的原生 :filters 激活态视觉（蓝字加粗 + 计数）。
.status-header {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.status-count {
  font-weight: 600;
}

// 2026-08-04：扫码命中序列号时输入框 0.6s 脉冲动画
@keyframes scanFlash {
  0%   { box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.5); }
  100% { box-shadow: 0 0 0 6px rgba(64, 158, 255, 0);   }
}
.scan-flash { animation: scanFlash 0.6s ease-out; }

// 加急行：dashboard 同款红底 #fde2e2（与默认 .el-table 浅灰底可叠加）
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}

// PR-G 2026-07-22：已开过送货单（且尚未 PICKED_UP）的零件行用浅蓝 #e6f4ff 提示
:deep(.el-table__row.row-on-delivery-note) > td.el-table__cell {
  background-color: #e6f4ff !important;
}
:deep(.el-table__row.row-on-delivery-note:hover > td.el-table__cell) {
  background-color: #d0e8ff !important;
}

// 2026-08-22：复制自 ResponsiveList.vue 的 current-row 覆盖（这些全局 current-row
// 覆盖写在 ResponsiveList 的 :deep 里，仅作用于 ResponsiveList 渲染的 el-table）。
// 这里把同款覆盖复制到 PartsTable，让本组件 el-table 也享受加急/已开单行选中色加深。
:deep(.el-table__row.row-urgent.current-row > td.el-table__cell) {
  background-color: #fbcaca !important;
}
:deep(.el-table__row.row-on-delivery-note.current-row > td.el-table__cell) {
  background-color: #b3d0ee !important;
}

// 2026-08-27 Task 6：列顺序拖动视觉反馈（与 PartListShell 同款藏青/蓝/浅蓝系）。
// sortablejs ghost/chosen/drag 三态分别对应：被拖列（半透明）/ 落点（蓝填充）/ 抓取副本（白）。
:deep(.col-no-drag) { cursor: default !important; }
:deep(.sortable-ghost) { opacity: 0.5; background: #eaf2fb !important; }
:deep(.sortable-chosen) { background: #cce0f4 !important; }
:deep(.sortable-drag) { background: #fff !important; }
</style>
