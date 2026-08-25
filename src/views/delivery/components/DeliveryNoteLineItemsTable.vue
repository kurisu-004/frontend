<!--
  DeliveryNoteLineItemsTable.vue

  送货单详情「零件列表」卡（DeliveryNoteDetail 第 2 张卡）：
  - 顶部 actions：列显隐 popover + 添加零件 + 移除选中
  - 主区域：el-table（tree-props + selection + sort-change + 加急红底）

  业务状态（note / treeLineItems / columnVisibility / selectedItemIds）由父组件通过 prop 注入。
  本组件只负责 UI 编排 + 选择事件转发。

  2026-08-25 frontend-overall-refactor：从 DeliveryNoteDetail.vue 抽出。
-->
<template>
  <el-card v-if="note" shadow="never" class="line-items-card">
    <template #header>
      <div class="card-header">
        <span>零件列表 ({{ note.line_items.length }})</span>
        <div class="actions">
          <!-- 2026-08-02：列显隐控制 -->
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap"
            @update:model-value="(v: Record<string, boolean>) => columnVisibility.update(v)"
            @reset="columnVisibility.showAll"
          />
          <el-button
            v-if="canAdd"
            type="primary"
            size="small"
            @click="emit('add')"
          >
            添加零件
          </el-button>
          <el-button
            v-if="canEdit && selectedItemIds.length"
            type="danger"
            size="small"
            @click="emit('remove-selected')"
          >
            移除选中 ({{ selectedItemIds.length }})
          </el-button>
        </div>
      </div>
    </template>
    <!-- 2026-08-22 a11y：selection 列所在 table 加 aria-label -->
    <el-table
      :data="treeLineItems"
      row-key="id"
      aria-label="送货单明细列表"
      :row-class-name="deliveryLineRowClassName"
      :tree-props="{ children: 'children', hasChildren: 'has_children' }"
      stripe
      border
      height="500"
      highlight-current-row
      @selection-change="onSelectionChange"
      @sort-change="onSortChange"
    >
      <!-- selection / index 始终可见，不放 defs -->
      <el-table-column
        v-if="canEdit"
        type="selection"
        width="50"
        :selectable="(row: AssemblyTreeRow) => !row.is_asm_row"
      />
      <el-table-column type="index" label="#" width="50" />
      <!-- 2026-08-02：每列加 v-if；订单号搬到图号/名称之间 -->
      <el-table-column
        v-if="columnVisibility.isVisible('batch_label')"
        prop="batch_label" label="批次" min-width="100" sortable align="center">
        <template #default="{ row }">
          <template v-if="row.is_asm_row">—</template>
          <template v-else>{{ row.batch_label || '—' }}</template>
        </template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('serial_no')"
        prop="serial_no" label="序列号" min-width="120" sortable align="center">
        <template #default="{ row }">
          <span :class="{ muted: !row.serial_no }">{{ row.serial_no || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('drawing_no')"
        prop="drawing_no" label="图号" min-width="140" sortable align="center"/>
      <el-table-column
        v-if="columnVisibility.isVisible('order_no')"
        prop="order_no" label="订单号" min-width="120" show-overflow-tooltip sortable align="center">
        <template #default="{ row }">{{ row.order_no || '—' }}</template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('name')"
        label="名称" min-width="200" sortable align="center">
        <template #default="{ row }">
          <template v-if="row.is_asm_row">
            <el-tag type="warning" size="small" class="asm-tag">装配件</el-tag>
            <router-link
              :to="`/assemblies/${row.assembly_id}`"
              class="assembly-link"
            >
              {{ row.name }}
            </router-link>
          </template>
          <template v-else>{{ row.name }}</template>
        </template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('customer')"
        prop="customer_name"
        label="客户（二级）" min-width="160" show-overflow-tooltip sortable align="center">
        <template #default="{ row }">
          <span>{{ row.customer_path ?? row.customer_name ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('applicant_name')"
        prop="applicant_name" label="申请人" min-width="100" sortable align="center">
        <template #default="{ row }">{{ row.applicant_name || '—' }}</template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('quantity')"
        label="数量" min-width="80" sortable align="center">
        <template #default="{ row }">
          <template v-if="row.is_asm_row">
            <strong>1</strong> <span class="muted">套</span>
          </template>
          <template v-else>{{ row.quantity }}</template>
        </template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('request_date')"
        label="请购日期" min-width="120" align="center">
        <template #default="{ row }">{{ row.request_date || '—' }}</template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('planned_delivery_date')"
        prop="planned_delivery_date"
        label="计划交期" min-width="120" sortable align="center">
        <template #default="{ row }">{{ row.planned_delivery_date || '—' }}</template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('system_delivery_date')"
        prop="system_delivery_date"
        label="系统交期" min-width="120" sortable align="center">
        <template #default="{ row }">{{ row.system_delivery_date || '—' }}</template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('note')"
        label="备注" min-width="120" show-overflow-tooltip align="center">
        <template #default="{ row }">{{ row.note || '—' }}</template>
      </el-table-column>
      <el-table-column
        v-if="columnVisibility.isVisible('status')"
        label="状态" min-width="120" align="center">
        <template #default="{ row }">
          <template v-if="row.is_asm_row">—</template>
          <el-tag
            v-else
            :type="partStatusTagType(row.status)"
            effect="plain"
            size="small"
          >
            {{ partStatusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import type { ColumnDef } from '@/composables/useColumnVisibility'
import type { DeliveryNoteDetailOut } from '@/types/deliveryNote'
import type { AssemblyTreeRow } from '../composables/useDeliveryNoteDetail'

interface Props {
  note: DeliveryNoteDetailOut | null
  /** 权限 flag */
  canAdd: boolean
  canEdit: boolean
  /** 树形化后的行（composable 提供） */
  treeLineItems: AssemblyTreeRow[]
  /** 列显隐状态（composable 提供） */
  columnDefs: readonly ColumnDef[]
  columnVisibility: {
    isVisible: (key: string) => boolean
    update: (next: Record<string, boolean>) => void
    showAll: () => void
    currentMap: Record<string, boolean>
  }
  /** 选中行（受控） */
  selectedItemIds: string[]
  /** 标签 / 行样式 helpers（composable 提供） */
  partStatusLabel: (s: string) => string
  partStatusTagType: (s: string) =>
    'primary' | 'success' | 'warning' | 'info' | 'danger'
  deliveryLineRowClassName: (ctx: { row: AssemblyTreeRow }) => string
}

defineProps<Props>()

const emit = defineEmits<{
  /** 点「添加零件」 */
  (e: 'add'): void
  /** 点「移除选中」 */
  (e: 'remove-selected'): void
  /** 选中行变化（受控） */
  (e: 'update:selectedItemIds', ids: string[]): void
  /** 排序变化 */
  (e: 'sort-change', sort: {
    prop: string | null
    order: 'ascending' | 'descending' | null
  }): void
}>()

function onSelectionChange(rows: AssemblyTreeRow[]): void {
  emit('update:selectedItemIds', rows.map((r) => r.id))
}

function onSortChange(sort: {
  prop: string | null
  order: 'ascending' | 'descending' | null
}): void {
  emit('sort-change', sort)
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
.asm-tag { margin-right: 6px; }
.assembly-link {
  color: var(--primary-color);
  text-decoration: none;
}
.assembly-link:hover { text-decoration: underline; }
.muted { color: var(--text-secondary); }

:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>
