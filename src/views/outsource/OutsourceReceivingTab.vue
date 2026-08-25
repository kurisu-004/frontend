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
      <span v-if="receivingPagedRef?.total?.value && receivingPagedRef.total.value > 0" class="total-hint">共 {{ receivingPagedRef.total.value }} 条</span>
    </div>
    <!-- 2026-08-25：ColumnVisibilityPopover 收纳位（ResponsiveList 拆掉后从子组件抽出提到顶层） -->
    <div class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
      />
    </div>
    <!-- 2026-08-25 (T7)：待接收 tab：el-table + el-pagination 收口到 <PagedTable> -->
    <PagedTable ref="receivingPagedRef" :fetcher="receivingFetcher" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table
          :data="items"
          v-loading="loading"
          row-key="batch_id"
          :empty-text="receivingError ?? '暂无待接收的零件'"
          :row-class-name="receivingRowClassName"
          stripe
          border
          size="small"
        >
          <el-table-column
            v-if="columnVisibility.isVisible('serial_no')"
            prop="serial_no" label="序列号" min-width="100" align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('drawing_no')"
            prop="drawing_no" label="图号" min-width="120" align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('name')"
            prop="name" label="名称" min-width="180" show-overflow-tooltip align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('batch_no')"
            label="批次号" min-width="80" align="center"
          >
            <template #default="{ row }">
              <el-tag type="info" size="small">批次 {{ (row as OutsourceInFlightItem).batch_no }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('quantity')"
            prop="quantity" label="数量" min-width="80" align="right"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('outsource_company_name')"
            label="外协公司" min-width="160" show-overflow-tooltip align="center"
          >
            <template #default="{ row }">
              {{ (row as OutsourceInFlightItem).outsource_company_name || '—' }}
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('sent_at')"
            label="发送时间" min-width="160" align="center"
          >
            <template #default="{ row }">
              {{ (row as OutsourceInFlightItem).sent_at ? new Date((row as OutsourceInFlightItem).sent_at!).toLocaleString() : '—' }}
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('customer_path')"
            prop="customer_path" label="客户" min-width="180" show-overflow-tooltip align="center"
          />
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
      :auto-pass="autoPass"
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
import { onMounted, ref, toRef, watch } from 'vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import PagedTable from '@/components/PagedTable.vue'
import { useColumnVisibility } from '@/composables/useColumnVisibility'
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
  receivingPageSize,
  receiveDialogVisible,
  receiveTarget,
  receiveSubmitting,
  receiveQuantity,
  receiveBranch,
  receiveShelf,
  receiveProcess,
  autoPass,
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

// 列可见性
const columnDefs = [
  { key: 'serial_no', label: '序列号' },
  { key: 'drawing_no', label: '图号' },
  { key: 'name', label: '名称' },
  { key: 'batch_no', label: '批次号' },
  { key: 'quantity', label: '数量' },
  { key: 'outsource_company_name', label: '外协公司' },
  { key: 'sent_at', label: '发送时间' },
  { key: 'customer_path', label: '客户' },
] as const
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_send_receive_receiving' })

// 持久化恢复 + pageSize 双向同步（与原 shell onMounted 等价）
onMounted(() => {
  const persisted = restore()
  if (persisted) {
    if (persisted.receivingFilter) Object.assign(receivingFilter, persisted.receivingFilter as Partial<typeof receivingFilter>)
    if (typeof persisted.receivingPageSize === 'number') {
      receivingPagedRef.value!.pageSize.value = persisted.receivingPageSize as number
    }
  }
  // 2026-08-25 T7：双向同步 PagedTable.pageSize → view 本地 pageSize
  watch(
    () => receivingPagedRef.value?.pageSize?.value,
    (s) => { if (typeof s === 'number') receivingPageSize.value = s },
  )
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