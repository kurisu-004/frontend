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
        @reset-order="drag.reset"
      />
    </div>
    <!-- 2026-08-25 (T7)：可发送 tab：el-table + el-pagination 收口到 <PagedTable> -->
    <PagedTable ref="sendablePagedRef" :fetcher="sendableFetcher" :default-page-size="20">
      <template #default="{ items, loading }">
        <el-table
          ref="tableRef"
          :data="items"
          v-loading="loading"
          row-key="part_id"
          :empty-text="sendableError ?? '暂无符合条件的可发送零件'"
          :row-class-name="sendableRowClassName"
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
import { h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Promotion } from '@element-plus/icons-vue'
import { ElTag } from 'element-plus'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import PagedTable from '@/components/PagedTable.vue'
import { useBarcodeScanner } from '@/composables/useBarcodeScanner'
import {
  useColumnVisibility,
  resolveDraggable,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { useColumnDrag, columnIdentifier } from '@/composables/useColumnDrag'
import { findElTableThead } from '@/utils/elTable'
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

// ============ 列可见性 + 列顺序拖动 ============
// 2026-08-27 T16：补 prop / minWidth / align + ElTag / 多根 / 分支类型列走 cellRender(PartListShell 同款)。
// 「图号」列原本是 <span + el-tag> 双根 → 必须用 <div> 包一层再 h()（cellRender 只接受单 VNode）。
const columnDefs: ColumnDef[] = [
  { key: 'part_serial_no', label: '序列号', prop: 'part_serial_no', minWidth: 100, align: 'center' },
  {
    key: 'part_drawing_no', label: '图号', prop: 'part_drawing_no', minWidth: 120, align: 'center',
    cellRender: ({ row }) => {
      const r = row as SendableItem
      // 2026-07-29 PR-fix-0.2.0 批次化：行=批次，图号旁显示批次号提示
      return h('div', { style: 'display: inline-flex; align-items: center;' }, [
        h('span', null, () => r.part_drawing_no),
        r.batch_no
          ? h(ElTag, { size: 'small', type: 'info', effect: 'plain', style: 'margin-left: 4px' },
              () => `批次 ${r.batch_no}`)
          : null,
      ])
    },
  },
  { key: 'part_name', label: '名称', prop: 'part_name', minWidth: 180, showOverflowTooltip: true, align: 'center' },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 80, align: 'right' },
  { key: 'planned_delivery_date', label: '计划交期', prop: 'planned_delivery_date', minWidth: 120, align: 'center' },
  {
    key: 'shelf_code', label: '源货架', minWidth: 80, align: 'center',
    cellRender: ({ row }) => {
      const r = row as SendableItem
      return r.shelf_code
        ? h(ElTag, { type: 'info', size: 'small' }, () => r.shelf_code)
        : h('span', null, () => '—')
    },
  },
  {
    key: 'send_mode', label: '模式', minWidth: 90, align: 'center',
    cellRender: ({ row }) => h(ElTag,
      { type: (row as SendableItem).send_mode === 'DIRECT' ? 'success' : 'warning', size: 'small' },
      () => (row as SendableItem).send_mode === 'DIRECT' ? '免审批' : '已批报价'),
  },
  { key: 'customer_path', label: '客户', prop: 'customer_path', minWidth: 160, showOverflowTooltip: true, align: 'center' },
  {
    key: 'next_process_name', label: '下一道工序', minWidth: 140, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as SendableItem).next_process_name || '—'),
  },
  {
    key: 'outsource_company_name', label: '外协公司', minWidth: 160, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => {
      const r = row as SendableItem
      if (r.send_mode === 'DIRECT') {
        // 2026-08-27 T16：SendableItem 是 discriminated union，DirectOutsourceCandidateItem / ApprovedQuoteForSendItem
        // 之间无字段重叠 → 走 unknown 二次 cast 满足 TS2352。
        const direct = r as unknown as DirectOutsourceCandidateItem
        return h('span', null, () =>
          direct.company_options.map((c) => c.name).join(' / ') || '—')
      }
      const approved = r as unknown as ApprovedQuoteForSendItem
      return h('span', null, () => approved.outsource_company_name || '—')
    },
  },
  {
    key: 'price', label: '单价(元)', minWidth: 100, align: 'right',
    cellRender: ({ row }) => {
      const r = row as SendableItem
      if (r.send_mode === 'DIRECT') return h('span', null, () => '—')
      const approved = r as unknown as ApprovedQuoteForSendItem
      return h('span', null, () => String(approved.price))
    },
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_send_receive_sendable' })
const drag = useColumnDrag(columnDefs, { listKey: 'outsource_send_receive_sendable' })
// 2026-08-27 T16：列拖动 onMounted 挂 useDraggable 到 <thead>
const tableRef = ref()

// 持久化恢复 + pageSize 双向同步（与原 shell onMounted 等价）
onMounted(() => {
  // 2026-08-27 T16：列顺序拖动挂 useDraggable 到 <thead>（本 tab 内 el-table thead 始终存在 → HTMLElement 路径）
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)

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