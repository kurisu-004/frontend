<!--
  OutsourceSendableTab.vue — 可发送 tab 页（2026-08-25 T12 从 OutsourceSendReceive.vue 抽出）

  本组件 = 业务逻辑持有者 + UI 渲染 + send dialog 渲染 + 全局扫码监听。
  - 业务状态：useOutsourceSendableList()（含 filter / 队列 / send dialog 状态）
  - 列可见性：useColumnVisibility
  - 父组件提供：customers（L1 全量）+ active（是否当前激活 tab，扫码仅在激活 tab 接收）
  - 通过 defineExpose 把 refresh() 暴露给 shell
-->
<template>
  <div class="sendable-tab">
    <!-- 扫码批量发送（PR-I 2026-07-20）：扫序列号自动入队，最后批量提交 -->
    <div class="scan-row">
      <el-input
        :model-value="scanInput"
        placeholder="扫码或输入序列号加入发送队列（Enter 入队）"
        clearable
        style="width: 360px"
        @update:model-value="(v: string) => (scanInput = v)"
        @keyup.enter="onScanInputEnter"
        @clear="onScanInputClear"
      >
        <template #prefix>
          <el-icon><Promotion /></el-icon>
        </template>
      </el-input>
      <el-button @click="onScanInputEnter">加入队列</el-button>
      <el-tag v-if="sendQueue.length > 0" type="success" effect="plain" size="small">
        队列 {{ sendQueue.length }} 件
      </el-tag>
      <el-button
        v-if="sendQueue.length > 0"
        link
        size="small"
        @click="clearSendQueue"
      >清空队列</el-button>
    </div>

    <!-- 扫码队列表格 -->
    <el-table
      v-if="sendQueue.length > 0"
      :data="sendQueue"
      stripe
      border
      size="small"
      class="queue-table"
      style="margin-bottom: 12px"
    >
      <el-table-column label="序列号" min-width="110" align="center">
        <template #default="{ row }">
          <span :class="{ muted: !row.part.serial_no }">{{ row.part.serial_no || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="part.drawing_no" label="图号" min-width="120" align="center"/>
      <el-table-column prop="part.name" label="名称" min-width="160" show-overflow-tooltip align="center"/>
      <el-table-column prop="outsource_company_name" label="外协公司" min-width="160" show-overflow-tooltip align="center"/>
      <el-table-column prop="process_name" label="外协工序" min-width="120" align="center"/>
      <el-table-column prop="quantity" label="数量" min-width="80" align="right" />
      <el-table-column prop="price" label="单价(元)" min-width="80" align="right" />
      <el-table-column label="状态" min-width="80" align="center">
        <template #default="{ row }">
          <el-tag v-if="row._failed" type="danger" size="small">失败</el-tag>
          <span v-else class="muted">待发</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="70" fixed="right" align="center">
        <template #default="{ $index }">
          <el-button
            link
            type="danger"
            size="small"
            @click="removeFromSendQueue($index)"
          >移除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="sendQueue.length > 0" class="batch-bar">
      <span class="batch-info">已入队 <strong>{{ sendQueue.length }}</strong> 件</span>
      <el-button
        type="primary"
        :loading="batchSending"
        @click="onConfirmBatchSend"
      >
        确认发送 {{ sendQueue.length }} 件
      </el-button>
    </div>

    <div class="filter-row">
      <el-input
        v-model="sendableFilter.keyword"
        placeholder="图号 / 名称 / 序列号"
        clearable
        style="width: 280px"
        @keyup.enter="onSendableSearch"
      />
      <el-select
        v-model="sendableFilter.customer_id"
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
      <el-button type="primary" @click="onSendableSearch">查询</el-button>
      <el-button @click="onSendableReset">重置</el-button>
      <span v-if="sendablePagedRef?.total?.value && sendablePagedRef.total.value > 0" class="total-hint">共 {{ sendablePagedRef.total.value }} 条</span>
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
    <!-- 2026-08-25 (T7)：可发送 tab：el-table + el-pagination 收口到 <PagedTable> -->
    <PagedTable ref="sendablePagedRef" :fetcher="sendableFetcher" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table
          :data="items"
          v-loading="loading"
          row-key="part_id"
          :empty-text="sendableError ?? '暂无符合条件的可发送零件'"
          :row-class-name="sendableRowClassName"
          stripe
          border
          size="small"
        >
          <el-table-column
            v-if="columnVisibility.isVisible('part_serial_no')"
            prop="part_serial_no" label="序列号" min-width="100" align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('part_drawing_no')"
            prop="part_drawing_no" label="图号" min-width="120" align="center"
          >
            <template #default="{ row }">
              <!-- 2026-07-29 PR-fix-0.2.0 批次化：行=批次，图号旁显示批次号提示 -->
              <span>{{ (row as SendableItem).part_drawing_no }}</span>
              <el-tag
                v-if="(row as SendableItem).batch_no"
                size="small"
                type="info"
                effect="plain"
                style="margin-left: 4px"
              >
                批次 {{ (row as SendableItem).batch_no }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('part_name')"
            prop="part_name" label="名称" min-width="180" show-overflow-tooltip align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('quantity')"
            prop="quantity" label="数量" min-width="80" align="right"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('planned_delivery_date')"
            prop="planned_delivery_date" label="计划交期" min-width="120" align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('shelf_code')"
            label="源货架" min-width="80" align="center"
          >
            <template #default="{ row }">
              <el-tag v-if="(row as SendableItem).shelf_code" type="info" size="small">
                {{ (row as SendableItem).shelf_code }}
              </el-tag>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('send_mode')"
            label="模式" min-width="90" align="center"
          >
            <template #default="{ row }">
              <el-tag v-if="(row as SendableItem).send_mode === 'DIRECT'" type="success" size="small">免审批</el-tag>
              <el-tag v-else type="warning" size="small">已批报价</el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('customer_path')"
            prop="customer_path" label="客户" min-width="160" show-overflow-tooltip align="center"
          />
          <el-table-column
            v-if="columnVisibility.isVisible('next_process_name')"
            label="下一道工序" min-width="140" show-overflow-tooltip align="center"
          >
            <template #default="{ row }">{{ (row as SendableItem).next_process_name || '—' }}</template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('outsource_company_name')"
            label="外协公司" min-width="160" show-overflow-tooltip align="center"
          >
            <template #default="{ row }">
              <template v-if="(row as SendableItem).send_mode === 'DIRECT'">
                {{ (row as DirectOutsourceCandidateItem).company_options.map((c) => c.name).join(' / ') || '—' }}
              </template>
              <template v-else>
                {{ (row as ApprovedQuoteForSendItem).outsource_company_name || '—' }}
              </template>
            </template>
          </el-table-column>
          <el-table-column
            v-if="columnVisibility.isVisible('price')"
            label="单价(元)" min-width="100" align="right"
          >
            <template #default="{ row }">
              <template v-if="(row as SendableItem).send_mode === 'DIRECT'">—</template>
              <template v-else>{{ (row as ApprovedQuoteForSendItem).price }}</template>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="100" fixed="right" align="center">
            <template #default="{ row }">
              <el-tooltip
                v-if="!canSend(row as SendableItem)"
                content="该零件当前状态 / 位置 / 工序不满足发送条件"
                placement="top"
              >
                <el-button size="small" disabled>发送</el-button>
              </el-tooltip>
              <el-button
                v-else
                size="small"
                type="primary"
                @click="openSend(row as SendableItem)"
              >发送</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </PagedTable>

    <!-- 发送 dialog（受控组件，T9 风格：model-value + update:model-value） -->
    <OutsourceSendDialog
      :model-value="sendDialogVisible"
      :target="sendTarget"
      :selected-company-id="sendSelectedCompanyId"
      :quantity="sendQuantity"
      :submitting="sendSubmitting"
      @update:model-value="(v: boolean) => (sendDialogVisible = v)"
      @update:selected-company-id="(v: string) => (sendSelectedCompanyId = v)"
      @update:quantity="(v: number) => (sendQuantity = v)"
      @confirm="onConfirmSend"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Promotion } from '@element-plus/icons-vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import PagedTable from '@/components/PagedTable.vue'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import { useColumnVisibility } from '@/composables/useColumnVisibility'
import type { Customer } from '@/api/customer'
import OutsourceSendDialog from './components/OutsourceSendDialog.vue'
import {
  useOutsourceSendableList,
  type SendableItem,
} from './composables/useOutsourceSendableList'
import type {
  ApprovedQuoteForSendItem,
} from '@/types/outsource'
import type { DirectOutsourceCandidateItem } from '@/types/directOutsource'

const props = defineProps<{
  customers: readonly Customer[]
  /** 是否当前激活 tab（用于全局扫码：仅激活 tab 接收扫码） */
  active: boolean
}>()

const emit = defineEmits<{
  (e: 'sent'): void
}>()

const {
  // state
  sendableError,
  sendableFilter,
  sendablePagedRef,
  sendablePageSize,
  sendQueue,
  batchSending,
  scanInput,
  sendDialogVisible,
  sendTarget,
  sendSelectedCompanyId,
  sendQuantity,
  sendSubmitting,
  // 持久化（shell 调 restore 后由本组件拿到的 snapshot 写回本地 state）
  restore,
  // handlers
  sendableFetcher,
  refreshSendable,
  onSendableSearch,
  onSendableReset,
  sendableRowClassName,
  canSend,
  openSend,
  onConfirmSend,
  handleScannedSerialForSend,
  onScanInputEnter,
  onScanInputClear,
  removeFromSendQueue,
  clearSendQueue,
  onConfirmBatchSend,
} = useOutsourceSendableList({
  onSent: () => emit('sent'),
})

// 列可见性
const columnDefs = [
  { key: 'part_serial_no', label: '序列号' },
  { key: 'part_drawing_no', label: '图号' },
  { key: 'part_name', label: '名称' },
  { key: 'quantity', label: '数量' },
  { key: 'planned_delivery_date', label: '计划交期' },
  { key: 'shelf_code', label: '源货架' },
  { key: 'send_mode', label: '模式' },
  { key: 'customer_path', label: '客户' },
  { key: 'next_process_name', label: '下一道工序' },
  { key: 'outsource_company_name', label: '外协公司' },
  { key: 'price', label: '单价' },
] as const
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_send_receive_sendable' })

// 持久化恢复 + pageSize 双向同步（与原 shell onMounted 等价）
onMounted(() => {
  const persisted = restore()
  if (persisted) {
    if (persisted.sendableFilter) Object.assign(sendableFilter, persisted.sendableFilter as Partial<typeof sendableFilter>)
    if (typeof persisted.sendablePageSize === 'number') {
      sendablePagedRef.value!.pageSize.value = persisted.sendablePageSize as number
    }
  }
  // 2026-08-25 T7：双向同步 PagedTable.pageSize → view 本地 pageSize（触发 persist 自动写盘）
  watch(
    () => sendablePagedRef.value?.pageSize?.value,
    (s) => { if (typeof s === 'number') sendablePageSize.value = s },
  )
})

// 全局扫码监听：仅当本 tab 是 active 时处理。
// T12 决策：扫码订阅放本组件内（tab 级别），避免与 composable 实例错位
// （shell 不能直接持有 useOutsourceSendableList，否则会跟 tab 内的实例 state 隔离）。
const { onScan: onGlobalScan } = useBarcodeScanner()
let unsubScan: (() => void) | null = null

onMounted(() => {
  unsubScan = onGlobalScan((code) => {
    if (props.active) {
      void handleScannedSerialForSend(code)
    }
  })
})

onBeforeUnmount(() => {
  if (unsubScan) {
    unsubScan()
    unsubScan = null
  }
})

// expose refresh 给 shell 用于初始化 / 联动刷新
defineExpose({
  refresh: refreshSendable,
})
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
// 2026-07-20：扫码批量发送 UI（PR-I）
.scan-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 14px;
  margin-bottom: 12px;
  background: #ecf5ff;
  border: 1px solid #d9ecff;
  border-radius: 6px;
}
.queue-table {
  margin-bottom: 12px;
}
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 12px;
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
  border-radius: 6px;
}
.batch-bar .batch-info {
  color: #303133;
  font-size: 13px;
}
.batch-bar .batch-info strong {
  color: #67c23a;
  font-weight: 600;
  margin: 0 2px;
}
.muted {
  color: var(--text-secondary);
}
// 2026-08-04：加急行整行红底（与 PartsList / 看板同款；1c 前端会复用此块不重复加）
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>