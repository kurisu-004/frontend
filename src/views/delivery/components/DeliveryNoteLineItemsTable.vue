<!--
  DeliveryNoteLineItemsTable.vue

  送货单详情「零件列表」卡（DeliveryNoteDetail 第 2 张卡）：
  - 顶部 actions：列显隐 popover + 添加零件 + 移除选中
  - 主区域：el-table（tree-props + selection + sort-change + 加急红底）

  业务状态（note / treeLineItems / columnVisibility / selectedItemIds）由父组件通过 prop 注入。
  本组件只负责 UI 编排 + 选择事件转发。

  2026-08-25 frontend-overall-refactor：从 DeliveryNoteDetail.vue 抽出。
  2026-08-27 T17：接入列顺序拖动（HTMLElement 路径 — el-card v-if="note" 始终为 truthy 后 el-table 一直在 DOM）。
-->
<template>
  <el-card v-if="note" shadow="never" class="line-items-card">
    <template #header>
      <div class="card-header">
        <span>零件列表 ({{ note.line_items.length }})</span>
        <div class="actions">
          <!-- 2026-08-02：列显隐控制；2026-08-27 T17 增 @reset-order -->
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap"
            @update:model-value="(v: Record<string, boolean>) => columnVisibility.update(v)"
            @reset="columnVisibility.showAll"
            @reset-order="drag.reset"
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
      ref="tableRef"
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
      <!--
        2026-08-27 T17：列顺序拖动接入。父 useDeliveryNoteDetail 注入的 columnDefs 仅含
        key + label（无 prop / minWidth 等元数据），本组件本地构建一份 draggableColumnDefs
        补齐 prop / minWidth / sortable / showOverflowTooltip / align 给 <el-table-column>
        渲染；visibility 与 drag 共用 listKey `delivery_note_detail_line_items`。
        装配件/零件两套渲染靠 cellRender + is_asm_row 分支。
      -->
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
import { h, onMounted, ref } from 'vue'
import { ElTag } from 'element-plus'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import {
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { findElTableThead } from '@/utils/elTable'
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

const props = defineProps<Props>()

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

// 2026-08-27 T17：列顺序拖动接入。
// 本地构建 draggableColumnDefs 给 v-for 模板用：补齐 prop / minWidth / sortable /
// showOverflowTooltip / align。key 集合与父 useDeliveryNoteDetail 注入的 columnDefs 一致，
// 所以 visibility popover 与 drag 顺序存储互不打架。
// 装配件行（is_asm_row=true）与零件行（false）渲染分支用 cellRender 处理。
function renderBatchLabel({ row }: { row: unknown }): ReturnType<typeof h> {
  const r = row as AssemblyTreeRow
  return r.is_asm_row
    ? h('span', null, () => '—')
    : h('span', null, () => r.batch_label || '—')
}
function renderName({ row }: { row: unknown }): ReturnType<typeof h> {
  const r = row as AssemblyTreeRow
  if (r.is_asm_row) {
    return h('div', null, () => [
      h(ElTag, { type: 'warning', size: 'small', class: 'asm-tag' }, () => '装配件'),
      h('router-link',
        { to: `/assemblies/${r.assembly_id}`, class: 'assembly-link' },
        () => r.name),
    ])
  }
  return h('span', null, () => r.name)
}
function renderQuantity({ row }: { row: unknown }): ReturnType<typeof h> {
  const r = row as AssemblyTreeRow
  if (r.is_asm_row) {
    return h('div', null, () => [
      h('strong', null, () => '1'),
      h('span', { class: 'muted' }, () => '套'),
    ])
  }
  return h('span', null, () => r.quantity)
}
function renderStatus({ row }: { row: unknown }): ReturnType<typeof h> {
  const r = row as AssemblyTreeRow
  if (r.is_asm_row) return h('span', null, () => '—')
  return h(ElTag,
    { type: props.partStatusTagType(r.status), effect: 'plain', size: 'small' },
    () => props.partStatusLabel(r.status))
}

const draggableColumnDefs: ColumnDef[] = [
  { key: 'batch_label', label: '批次', minWidth: 100, sortable: true, align: 'center',
    cellRender: renderBatchLabel },
  { key: 'serial_no', label: '序列号', prop: 'serial_no', minWidth: 120, sortable: true, align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyTreeRow
      return h('span', { class: { muted: !r.serial_no } }, () => r.serial_no || '—')
    } },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 140, sortable: true, align: 'center' },
  { key: 'order_no', label: '订单号', prop: 'order_no', minWidth: 120, showOverflowTooltip: true, sortable: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as AssemblyTreeRow).order_no || '—') },
  { key: 'name', label: '名称', minWidth: 200, sortable: true, align: 'center',
    cellRender: renderName },
  { key: 'customer', label: '客户（二级）', prop: 'customer_name', minWidth: 160, showOverflowTooltip: true, sortable: true, align: 'center',
    cellRender: ({ row }) => {
      const r = row as AssemblyTreeRow
      return h('span', null, () => r.customer_path ?? r.customer_name ?? '—')
    } },
  { key: 'applicant_name', label: '申请人', prop: 'applicant_name', minWidth: 100, sortable: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as AssemblyTreeRow).applicant_name || '—') },
  { key: 'quantity', label: '数量', minWidth: 80, sortable: true, align: 'center',
    cellRender: renderQuantity },
  { key: 'request_date', label: '请购日期', minWidth: 120, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as AssemblyTreeRow).request_date || '—') },
  { key: 'planned_delivery_date', label: '计划交期', prop: 'planned_delivery_date', minWidth: 120, sortable: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as AssemblyTreeRow).planned_delivery_date || '—') },
  { key: 'system_delivery_date', label: '系统交期', prop: 'system_delivery_date', minWidth: 120, sortable: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as AssemblyTreeRow).system_delivery_date || '—') },
  { key: 'note', label: '备注', minWidth: 120, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as AssemblyTreeRow).note || '—') },
  { key: 'status', label: '状态', minWidth: 120, align: 'center',
    cellRender: renderStatus },
]
const drag = useColumnDrag(draggableColumnDefs, { listKey: 'delivery_note_detail_line_items' })

const tableRef = ref()
// 2026-08-27 T17：列拖动 onMounted 挂 useDraggable 到 <thead>。el-card v-if="note" 在
// note 加载完后一直为 true，el-table 持续在 DOM → HTMLElement 路径。
onMounted(() => {
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)
})

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
