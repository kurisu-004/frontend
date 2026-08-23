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
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
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

      <!-- 2. 序列号 -->
      <el-table-column
        v-if="columnVisibility.isVisible('serial_no')"
        prop="serial_no"
        label="序列号"
        min-width="110"
        fixed="left"
        sortable="custom"
        show-overflow-tooltip
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="序列号"
            :active="serialNoFilter.active.value"
            v-model:visible="serialNoFilter.visible.value"
            @show="serialNoFilter.sync"
            @confirm="serialNoFilter.confirm"
            @reset="serialNoFilter.reset"
          >
            <el-input
              v-model="serialNoFilter.draft.value"
              placeholder="序列号（ILIKE 子串）"
              clearable
              size="small"
              :class="{ 'scan-flash': serialNoFlash }"
              @keyup.enter="serialNoFilter.confirm"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <span :class="{ muted: !row.serial_no }">{{ row.serial_no || '—' }}</span>
        </template>
      </el-table-column>

      <!-- 3. 订单号 -->
      <el-table-column
        v-if="columnVisibility.isVisible('order_no')"
        prop="order_no"
        label="订单号"
        min-width="130"
        sortable="custom"
        show-overflow-tooltip
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="订单号"
            :active="orderNoFilter.active.value"
            :width="280"
            hint="订单号子串搜索；勾选「仅空白」覆盖输入"
            v-model:visible="orderNoFilter.visible.value"
            @show="orderNoFilter.sync"
            @confirm="orderNoFilter.confirm"
            @reset="orderNoFilter.reset"
          >
            <div class="filter-input-row">
              <el-input
                v-model="orderNoFilter.draft.value"
                placeholder="订单号（ILIKE 子串）"
                clearable
                size="small"
                @keyup.enter="orderNoFilter.confirm"
              >
                <template #prefix><el-icon><Search /></el-icon></template>
              </el-input>
              <el-checkbox
                :model-value="orderNoFilter.isNullDraft.value === true"
                @update:model-value="v => (orderNoFilter.isNullDraft.value = v ? true : undefined)"
              >仅空白</el-checkbox>
            </div>
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <el-input
            v-if="editingId === row.id"
            v-model="editBuffer.order_no"
            size="small"
          />
          <span v-else>{{ row.order_no || '—' }}</span>
        </template>
      </el-table-column>

      <!-- 4. 图号 -->
      <el-table-column
        v-if="columnVisibility.isVisible('drawing_no')"
        prop="drawing_no"
        label="图号"
        min-width="130"
        fixed="left"
        sortable="custom"
        show-overflow-tooltip
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="图号"
            :active="drawingNoFilter.active.value"
            v-model:visible="drawingNoFilter.visible.value"
            @show="drawingNoFilter.sync"
            @confirm="drawingNoFilter.confirm"
            @reset="drawingNoFilter.reset"
          >
            <el-input
              v-model="drawingNoFilter.draft.value"
              placeholder="图号（ILIKE 子串）"
              clearable
              size="small"
              @keyup.enter="drawingNoFilter.confirm"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <el-input
            v-if="editingId === row.id"
            v-model="editBuffer.drawing_no"
            size="small"
          />
          <span v-else>{{ row.drawing_no }}</span>
        </template>
      </el-table-column>

      <!-- 5. 名称 -->
      <el-table-column
        v-if="columnVisibility.isVisible('name')"
        prop="name"
        label="名称"
        min-width="200"
        sortable="custom"
        show-overflow-tooltip
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="名称"
            :active="nameFilter.active.value"
            v-model:visible="nameFilter.visible.value"
            @show="nameFilter.sync"
            @confirm="nameFilter.confirm"
            @reset="nameFilter.reset"
          >
            <el-input
              v-model="nameFilter.draft.value"
              placeholder="名称（ILIKE 子串）"
              clearable
              size="small"
              @keyup.enter="nameFilter.confirm"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <el-input
            v-if="editingId === row.id"
            v-model="editBuffer.name"
            size="small"
          />
          <template v-else>
            <el-tag
              v-if="row.row_type === 'ASSEMBLY'"
              type="warning"
              size="small"
              effect="plain"
              style="margin-right: 4px;"
            >装配件</el-tag>
            <router-link
              :to="row.row_type === 'ASSEMBLY' ? `/assemblies/${row.id}` : `/parts/${row.id}`"
              class="name-link"
            >{{ row.name }}</router-link>
          </template>
        </template>
      </el-table-column>

      <!-- 6. 客户 -->
      <el-table-column
        v-if="columnVisibility.isVisible('customer')"
        label="客户"
        min-width="180"
        show-overflow-tooltip
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="客户"
            :active="customerFilter.active.value"
            :width="280"
            hint="选一级客户自动级联其下二级客户"
            v-model:visible="customerFilter.visible.value"
            @show="customerFilter.sync"
            @confirm="customerFilter.confirm"
            @reset="customerFilter.reset"
          >
            <el-tree-select
              v-model="customerFilter.draft.value"
              :data="customerTree"
              node-key="id"
              :props="{ label: 'name', children: 'children' }"
              check-strictly
              clearable
              filterable
              placeholder="选择客户"
              :teleported="false"
              style="width: 100%"
              @clear="customerFilter.draft.value = null"
            />
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <span v-if="row.customer_path">{{ row.customer_path }}</span>
          <span v-else-if="row.customer_name" class="muted">{{ row.customer_name }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>

      <!-- 7. 申请人 -->
      <el-table-column
        v-if="columnVisibility.isVisible('applicant')"
        label="申请人"
        min-width="160"
        show-overflow-tooltip
        align="center"
      >
        <template #default="{ row }">
          <el-autocomplete
            v-if="editingId === row.id"
            v-model="editBuffer.applicant_name"
            value-key="name"
            :fetch-suggestions="applicantSuggest"
            :trigger-on-focus="true"
            :debounce="0"
            :loading="applicantLoading"
            placeholder="选择或输入申请人姓名"
            clearable
            size="small"
            style="width: 100%"
          />
          <span v-else>{{ row.applicant_name || '—' }}</span>
        </template>
      </el-table-column>

      <!-- 8. 状态（原生 :filters） -->
      <el-table-column
        v-if="columnVisibility.isVisible('status')"
        label="状态"
        min-width="140"
        align="center"
        column-key="status"
        :filters="statusNativeOptions"
        :filtered-value="statusFilteredValue"
      >
        <template #header>
          <span class="status-header">
            状态
            <span v-if="statusSelectedCount > 0" class="status-count">({{ statusSelectedCount }})</span>
          </span>
        </template>
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" effect="plain" size="small">
            {{ statusLabel(row.status) }}
          </el-tag>
          <el-tag
            v-if="row.has_been_repaired"
            type="warning"
            size="small"
            effect="dark"
            style="margin-left: 4px"
          >返修</el-tag>
        </template>
      </el-table-column>

      <!-- 9. 数量 -->
      <el-table-column
        v-if="columnVisibility.isVisible('quantity')"
        prop="quantity"
        label="数量"
        min-width="110"
        sortable="custom"
        align="right"
      >
        <template #default="{ row }">
          <el-input-number
            v-if="editingId === row.id"
            v-model="editBuffer.quantity"
            :min="1"
            :precision="0"
            :controls="false"
            size="small"
            style="width: 90px"
          />
          <span v-else>{{ row.quantity }}</span>
        </template>
      </el-table-column>

      <!-- 10. 单价 -->
      <el-table-column
        v-if="canEdit && columnVisibility.isVisible('unit_price')"
        prop="unit_price"
        label="单价"
        min-width="120"
        sortable="custom"
        align="right"
      >
        <template #default="{ row }">
          <el-input-number
            v-if="editingId === row.id"
            v-model="editBuffer.unit_price"
            :min="0"
            :precision="2"
            :step="0.01"
            :controls="false"
            size="small"
            style="width: 100px"
          />
          <span v-else>{{ row.unit_price }}</span>
        </template>
      </el-table-column>

      <!-- 11. 总价 -->
      <el-table-column
        v-if="canEdit && columnVisibility.isVisible('total_price')"
        prop="total_price"
        label="总价"
        min-width="120"
        sortable="custom"
        align="right"
      >
        <template #default="{ row }">
          <span>{{ displayTotalPrice(row as PartListItem) }}</span>
        </template>
      </el-table-column>

      <!-- 12. 请购日期 -->
      <el-table-column
        v-if="columnVisibility.isVisible('request_date')"
        prop="request_date"
        label="请购日期"
        min-width="150"
        sortable="custom"
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="请购日期"
            :active="requestDateFilter.active.value"
            :width="280"
            v-model:visible="requestDateFilter.visible.value"
            @confirm="requestDateFilter.confirm"
            @reset="requestDateFilter.reset"
          >
            <el-date-picker
              v-model="requestDateFilter.range.value"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="~"
              start-placeholder="起点"
              end-placeholder="终点"
              unlink-panels
              clearable
              size="small"
              :teleported="false"
              style="width: 100%"
            />
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <el-date-picker
            v-if="editingId === row.id"
            v-model="editBuffer.request_date"
            type="date"
            value-format="YYYY-MM-DD"
            size="small"
            style="width: 138px"
            :clearable="false"
          />
          <span v-else>{{ row.request_date }}</span>
        </template>
      </el-table-column>

      <!-- 13. 计划交期 -->
      <el-table-column
        v-if="columnVisibility.isVisible('planned_delivery_date')"
        prop="planned_delivery_date"
        label="计划交期"
        min-width="150"
        sortable="custom"
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="计划交期"
            :active="plannedDateFilter.active.value"
            :width="280"
            v-model:visible="plannedDateFilter.visible.value"
            @confirm="plannedDateFilter.confirm"
            @reset="plannedDateFilter.reset"
          >
            <el-date-picker
              v-model="plannedDateFilter.range.value"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="~"
              start-placeholder="起点"
              end-placeholder="终点"
              unlink-panels
              clearable
              size="small"
              :teleported="false"
              style="width: 100%"
            />
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <el-date-picker
            v-if="editingId === row.id"
            v-model="editBuffer.planned_delivery_date"
            type="date"
            value-format="YYYY-MM-DD"
            size="small"
            style="width: 138px"
            :clearable="false"
          />
          <span v-else>{{ row.planned_delivery_date }}</span>
        </template>
      </el-table-column>

      <!-- 14. 系统交期 -->
      <el-table-column
        v-if="columnVisibility.isVisible('system_delivery_date')"
        prop="system_delivery_date"
        label="系统交期"
        min-width="150"
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="系统交期"
            :active="systemDateFilter.active.value"
            :width="300"
            hint="区间 + 「仅空白」checkbox；勾选后区间失效"
            v-model:visible="systemDateFilter.visible.value"
            @show="systemDateFilter.sync"
            @confirm="systemDateFilter.confirm"
            @reset="systemDateFilter.reset"
          >
            <div class="filter-input-row">
              <el-date-picker
                v-model="systemDateFilter.range.value"
                type="daterange"
                value-format="YYYY-MM-DD"
                range-separator="~"
                start-placeholder="起点"
                end-placeholder="终点"
                unlink-panels
                clearable
                size="small"
                :teleported="false"
                style="flex: 1"
              />
              <el-checkbox
                :model-value="systemDateFilter.isNullDraft.value === true"
                @update:model-value="v => (systemDateFilter.isNullDraft.value = v ? true : undefined)"
              >仅空白</el-checkbox>
            </div>
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <el-date-picker
            v-if="editingId === row.id"
            v-model="editBuffer.system_delivery_date"
            type="date"
            value-format="YYYY-MM-DD"
            size="small"
            style="width: 138px"
            clearable
          />
          <span v-else>{{ row.system_delivery_date || '—' }}</span>
        </template>
      </el-table-column>

      <!-- 15. 已送数量 -->
      <el-table-column
        v-if="columnVisibility.isVisible('delivered_quantity')"
        prop="delivered_quantity"
        label="已送数量"
        min-width="100"
        align="right"
      >
        <template #default="{ row }">
          <span v-if="row.row_type === 'ASSEMBLY'" class="muted">—</span>
          <span v-else>{{ row.delivered_quantity ?? 0 }}</span>
        </template>
      </el-table-column>

      <!-- 16. 加急 -->
      <el-table-column
        v-if="columnVisibility.isVisible('is_urgent')"
        label="加急"
        min-width="80"
        align="center"
      >
        <template #default="{ row }">
          <el-switch
            v-if="editingId === row.id"
            v-model="editBuffer.is_urgent"
            size="small"
          />
          <el-tag v-else-if="row.is_urgent" type="danger" effect="plain" size="small">加急</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>

      <!-- 17. 下一道工序（原生 :filters） -->
      <el-table-column
        v-if="columnVisibility.isVisible('next_process')"
        label="下一道工序"
        min-width="130"
        align="center"
        column-key="next_process"
        :filters="nextProcessOptions"
        :filtered-value="nextProcessFilteredValue"
      >
        <template #header>
          <span class="status-header">
            下一道工序
            <span v-if="nextProcessSelectedCount > 0" class="status-count">({{ nextProcessSelectedCount }})</span>
          </span>
        </template>
        <template #default="{ row }">
          <span v-if="row.row_type === 'ASSEMBLY'" class="muted">—</span>
          <span v-else-if="row.next_process_name">{{ row.next_process_name }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>

      <!-- 18. 所在位置 -->
      <el-table-column
        v-if="columnVisibility.isVisible('location')"
        label="所在位置"
        min-width="150"
        show-overflow-tooltip
        align="center"
      >
        <template #header>
          <ColumnFilterPopover
            label="所在位置"
            :active="locationFilter.active.value"
            :width="260"
            hint="选大类命中该类全部；选叶子精确到货架/工人/外协公司"
            v-model:visible="locationFilter.visible.value"
            @show="locationFilter.onShow"
            @confirm="locationFilter.confirm"
            @reset="locationFilter.reset"
          >
            <el-tree-select
              v-model="locationFilter.draft.value"
              :data="locationTree"
              node-key="id"
              :props="{ label: 'name', children: 'children' }"
              multiple
              show-checkbox
              check-strictly
              check-on-click-node
              clearable
              filterable
              :teleported="false"
              placeholder="选择位置"
              style="width: 100%"
              @clear="locationFilter.draft.value = []"
            />
          </ColumnFilterPopover>
        </template>
        <template #default="{ row }">
          <span v-if="row.location === 'PRODUCTION_SHELF' && row.shelf_code">货架 {{ row.shelf_code }}</span>
          <span v-else-if="row.location === 'INSPECTION_SHELF' && row.shelf_code">品检 {{ row.shelf_code }}</span>
          <span v-else-if="row.location === 'WORKER' && row.worker_name">{{ row.worker_name }}</span>
          <span v-else-if="row.location === 'OUTSOURCE_COMPANY' && row.outsource_company_name">外协 {{ row.outsource_company_name }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>

      <!-- 19. 备注 -->
      <el-table-column
        v-if="columnVisibility.isVisible('note')"
        label="备注"
        min-width="160"
        show-overflow-tooltip
        align="center"
      >
        <template #default="{ row }">
          <el-input
            v-if="editingId === row.id"
            v-model="editBuffer.note"
            size="small"
          />
          <span v-else>{{ row.note || '—' }}</span>
        </template>
      </el-table-column>

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

import { ref } from 'vue'
import type { TableInstance } from 'element-plus'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import ColumnFilterPopover from '@/components/ColumnFilterPopover.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type OrderStatus,
  type PartListItem,
} from '@/types/parts'
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

// ============ 表格 ref（暴露给父组件）============
const tableRef = ref<TableInstance | null>(null)
defineExpose({ tableRef })

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

function statusLabel(s: OrderStatus): string {
  return ORDER_STATUS_LABEL[s] ?? s
}
function statusTagType(
  s: OrderStatus,
): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
  return ORDER_STATUS_TAG_TYPE[s] ?? 'info'
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
</style>
