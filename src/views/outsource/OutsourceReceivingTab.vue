<!--
  OutsourceReceivingTab.vue — 待接收 tab 页（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）

  本组件 = 业务逻辑持有者 + UI 渲染 + receive dialog 渲染。
  - 业务状态：useOutsourceReceivingList()（含 filter / receive dialog 状态）
  - 列可见性：useColumnVisibility
  - 父组件提供：customers（L1 全量）+ shelves + processes（接收 dialog 用）
  - 通过 defineExpose 把 refresh() 暴露给 shell 用于「发送成功后联动刷新」。
-->
<template>
  <div class="receiving-tab">
    <div class="filter-row">
      <el-input
        v-model="receivingFilter.keyword"
        placeholder="图号 / 名称 / 序列号"
        clearable
        style="width: 280px"
        @keyup.enter="onReceivingSearch"
      />
      <el-select
        v-model="receivingFilter.customer_id"
        clearable
        placeholder="客户（L1）"
        style="width: 220px"
      >
        <el-option
          v-for="c in customers.filter((x) => x.parent_id === null)"
          :key="c.id"
          :label="c.name"
          :value="c.id"
        />
      </el-select>
      <el-button type="primary" @click="onReceivingSearch">查询</el-button>
      <el-button @click="onReceivingReset">重置</el-button>
      <span v-if="receivingPagedRef?.total && receivingPagedRef.total > 0" class="total-hint">共 {{ receivingPagedRef.total }} 条</span>
    </div>
    <!-- 2026-08-25：ColumnVisibilityPopover 收纳位（ResponsiveList 拆掉后从子组件抽出提到顶层） -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>
    <!-- 2026-08-25 (T7)：待接收 tab：el-table + el-pagination 收口到 <PagedTable> -->
    <PagedTable ref="receivingPagedRef" :fetcher="receivingFetcher" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table
          ref="tableRef"
          :data="items"
          v-loading="loading"
          row-key="batch_id"
          :empty-text="receivingError ?? '暂无待接收的零件'"
          :row-class-name="receivingRowClassName"
          stripe
          border
          size="small"
        >
          <!--
            2026-08-27 T16：列顺序拖动接入。本组件挂在 <el-tab-pane> 内，EP 默认 lazy=false，
            双 tab 都在 DOM（隐藏用 display:none），el-table thead 一开始就有 → 走 HTMLElement 路径。
            fixed="right" 操作列保留为字面量 <el-table-column>。
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
          <el-table-column label="操作" min-width="100" fixed="right" align="center">
            <template #default="{ row }">
              <el-button
                size="small"
                type="primary"
                @click="openReceive(row as OutsourceInFlightItem)"
              >接收</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </PagedTable>

    <!-- 接收 dialog（受控组件，T9 风格：model-value + update:model-value） -->
    <OutsourceReceiveDialog
      :model-value="receiveDialogVisible"
      :target="receiveTarget"
      :branch="receiveBranch"
      :shelf="receiveShelf"
      :process="receiveProcess"
      :quantity="receiveQuantity"
      :submitting="receiveSubmitting"
      :branch-label="receiveBranchLabel"
      :production-shelves="filteredProductionShelves"
      :inspection-shelves="inspectionShelves"
      :filtered-inhouse-processes="filteredInhouseProcesses"
      @update:model-value="(v: boolean) => (receiveDialogVisible = v)"
      @update:branch="(v) => (receiveBranch = v)"
      @update:shelf="(v: string) => (receiveShelf = v)"
      @update:process="(v: string) => (receiveProcess = v)"
      @update:quantity="(v: number) => (receiveQuantity = v)"
      @closed="onReceiveDialogClosed"
      @confirm="onConfirmReceive"
    />
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, ref, toRef } from 'vue'
import { ElTag } from 'element-plus'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import type { Customer } from '@/api/customer'
import type { Shelf as ShelfItem } from '@/types/shelf'
import type { Process } from '@/types/process'
import type { OutsourceInFlightItem } from '@/types/outsource'
import OutsourceReceiveDialog from './components/OutsourceReceiveDialog.vue'
import { useOutsourceReceivingList } from './composables/useOutsourceReceivingList'

const props = defineProps<{
  customers: readonly Customer[]
  shelves: readonly ShelfItem[]
  processes: readonly Process[]
}>()

const {
  // state
  receivingError,
  receivingFilter,
  receivingPagedRef,
  receiveDialogVisible,
  receiveTarget,
  receiveSubmitting,
  receiveQuantity,
  receiveBranch,
  receiveShelf,
  receiveProcess,
  // 派生
  inspectionShelves,
  filteredProductionShelves,
  filteredInhouseProcesses,
  receiveBranchLabel,
  // 持久化
  restore,
  // handlers
  receivingFetcher,
  refreshReceiving,
  onReceivingSearch,
  onReceivingReset,
  receivingRowClassName,
  openReceive,
  onReceiveDialogClosed,
  onConfirmReceive,
} = useOutsourceReceivingList({
  shelves: toRef(props, 'shelves'),
  processes: toRef(props, 'processes'),
})

// ============ 列可见性 + 列顺序拖动 ============
// 2026-08-27 T16：补 prop / minWidth / align + ElTag / 文本列走 cellRender(PartListShell 同款)。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
const columnDefs: ColumnDef[] = [
  { key: 'serial_no', label: '序列号', prop: 'serial_no', minWidth: 100, align: 'center' },
  { key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 120, align: 'center' },
  { key: 'name', label: '名称', prop: 'name', minWidth: 180, showOverflowTooltip: true, align: 'center' },
  {
    key: 'batch_no', label: '批次号', minWidth: 80, align: 'center',
    cellRender: ({ row }) => h(ElTag, { type: 'info', size: 'small' },
      () => `批次 ${(row as OutsourceInFlightItem).batch_no}`),
  },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 80, align: 'right' },
  {
    key: 'outsource_company_name', label: '外协公司', minWidth: 160, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, (row as OutsourceInFlightItem).outsource_company_name || '—'),
  },
  {
    key: 'sent_at', label: '发送时间', minWidth: 160, align: 'center',
    cellRender: ({ row }) => {
      const r = row as OutsourceInFlightItem
      return h('span', null, r.sent_at ? new Date(r.sent_at!).toLocaleString() : '—')
    },
  },
  { key: 'customer_path', label: '客户', prop: 'customer_path', minWidth: 180, showOverflowTooltip: true, align: 'center' },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_send_receive_receiving' })
const drag = useColumnDrag(columnDefs, { listKey: 'outsource_send_receive_receiving' })
// 2026-08-28 改造：applyDrag 接受 el-table 实例 ref，内部归一化根 + MutationObserver 自愈
const tableRef = ref()

// 持久化恢复（与原 shell onMounted 等价）
// 2026-08-31 双实例修复：pageSize 不再持久化，每次进入视图从 defaultPageSize（20）起算。
// 取舍依据与 PartListShell 一致：Vue 3.5 component proxy 会自动 unwrap 暴露的 ref，
// `receivingPagedRef.value.pageSize.value = N` 实际写入 number.value 抛 TypeError。
onMounted(() => {
  // 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver 自愈
  drag.applyDrag(tableRef)

  const persisted = restore()
  if (persisted && persisted.receivingFilter) {
    Object.assign(receivingFilter, persisted.receivingFilter as Partial<typeof receivingFilter>)
  }
})

// expose 给 shell 用于初始化/联动刷新
defineExpose({ refresh: refreshReceiving })
</script>

<style lang="scss" scoped>
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
.total-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: auto;
}
// 2026-08-04：加急行整行红底（与 PartsList / 看板同款）
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>