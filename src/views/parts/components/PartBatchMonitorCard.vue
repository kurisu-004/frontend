<!--
  PartBatchMonitorCard.vue

  批次监控卡（PartDetail 第 9 张卡）：
  - 批次列表（el-table + 拆分 / 取消列）
  - 拆分对话框（partId + batch + quantity → emit split）
  - 取消按钮（emit cancel-batch；父组件弹 confirm 后再调 usePartDetail.onCancelBatch）
  - 拆分 / 取消 dialog 状态由本组件局部维护

  2026-08-25 frontend-overall-refactor：从 PartDetail.vue 抽出。
-->
<template>
  <el-card shadow="never" class="batch-card" v-loading="batchesLoading">
    <template #header>
      <div class="card-header">
        <span class="card-title">批次监控</span>
        <span class="event-count">
          共 {{ batches.length }} 批 / {{ batchTotalQty }} 件
        </span>
      </div>
    </template>
    <el-table
      v-if="batches.length > 0"
      :data="batches"
      size="small"
      border
      stripe
    >
      <el-table-column label="批次" min-width="110" align="center">
        <template #default="{ row }">
          <span class="batch-label">{{ (row as PartBatch).batch_label }}</span>
        </template>
      </el-table-column>
      <el-table-column label="数量" width="80" align="right">
        <template #default="{ row }">{{ (row as PartBatch).quantity }}</template>
      </el-table-column>
      <el-table-column label="状态" min-width="110" align="center">
        <template #default="{ row }">
          <el-tag
            :type="statusTagType((row as PartBatch).status as OrderStatus)"
            size="small"
            effect="plain"
          >
            {{ statusLabelOf((row as PartBatch).status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        label="所在位置"
        min-width="130"
        align="center"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          {{ (row as PartBatch).current_holder_display || '—' }}
        </template>
      </el-table-column>
      <el-table-column
        label="下一工序"
        min-width="100"
        align="center"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          {{ (row as PartBatch).next_process_name || '—' }}
        </template>
      </el-table-column>
      <el-table-column
        label="送货单"
        min-width="150"
        align="center"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          {{ (row as PartBatch).delivery_note_no || '—' }}
        </template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="150" align="center">
        <template #default="{ row }">
          <span class="muted">{{ formatDateTime((row as PartBatch).created_at) }}</span>
        </template>
      </el-table-column>
      <el-table-column
        v-if="canManageBatches"
        label="操作"
        width="130"
        align="center"
        fixed="right"
      >
        <template #default="{ row }">
          <el-button
            v-if="!isTerminalBatch(row as PartBatch) && (row as PartBatch).quantity > 1"
            link
            type="primary"
            size="small"
            @click="openSplitDialog(row as PartBatch)"
          >拆分</el-button>
          <el-button
            v-if="!isTerminalBatch(row as PartBatch)"
            link
            type="danger"
            size="small"
            @click="$emit('cancel-batch', row as PartBatch)"
          >取消</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="暂无批次" />

    <!-- 拆分批次对话框 -->
    <el-dialog
      v-model="splitDialogVisible"
      title="拆分批次"
      :width="splitDlg.width"
      :fullscreen="splitDlg.fullscreen"
      @closed="onSplitDialogClosed"
    >
      <div v-if="splitSource" class="split-dialog-body">
        <p>
          源批次 <b>{{ splitSource.batch_label }}</b>
          （当前 {{ splitSource.quantity }} 件，
          {{ statusLabelOf(splitSource.status) }}）
        </p>
        <el-form label-width="90px">
          <el-form-item label="拆出数量" required>
            <el-input-number
              v-model="splitQuantity"
              :min="1"
              :max="splitSource.quantity - 1"
              :precision="0"
              style="width: 160px"
            />
          </el-form-item>
        </el-form>
        <p class="muted">
          拆出后：源批次剩 {{ splitSource.quantity - (splitQuantity ?? 0) }} 件，
          新批次 {{ splitQuantity ?? 0 }} 件（继承当前状态/位置）。
        </p>
      </div>
      <template #footer>
        <el-button @click="splitDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="splitSubmitting"
          :disabled="!splitQuantity || !splitSource || splitQuantity >= splitSource.quantity"
          @click="onSplitConfirm"
        >确认拆分</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { type PartBatch } from '@/api/parts'
import { formatDateTime } from '@/utils/date'
import { useDialogSize } from '@/composables/useDialogSize'
import type { OrderStatus } from '@/types/parts'

const props = defineProps<{
  partId: string
  batches: PartBatch[]
  batchesLoading: boolean
  canManageBatches: boolean
  statusTagType: (s: OrderStatus) => 'primary' | 'success' | 'warning' | 'info' | 'danger'
  statusLabelOf: (s: string | null | undefined) => string
}>()

const emit = defineEmits<{
  (e: 'fetch'): void
  (e: 'split', batch: PartBatch, quantity: number): void
  (e: 'cancel-batch', batch: PartBatch): void
}>()

const batchTotalQty = computed(() =>
  props.batches.reduce((acc, b) => acc + b.quantity, 0),
)

function isTerminalBatch(b: PartBatch): boolean {
  return b.status === 'COMPLETED' || b.status === 'CANCELLED'
}

// ============ 拆分对话框（局部 UI 状态）============
const splitDlg = useDialogSize({ desktopWidth: 420 })
const splitDialogVisible = ref(false)
const splitSource = ref<PartBatch | null>(null)
const splitQuantity = ref<number | undefined>(undefined)
const splitSubmitting = ref(false)

function openSplitDialog(b: PartBatch): void {
  splitSource.value = b
  splitQuantity.value = undefined
  splitDialogVisible.value = true
}

function onSplitDialogClosed(): void {
  splitSource.value = null
  splitQuantity.value = undefined
}

async function onSplitConfirm(): Promise<void> {
  if (!splitSource.value || !splitQuantity.value) return
  splitSubmitting.value = true
  try {
    emit('split', splitSource.value, splitQuantity.value)
    splitDialogVisible.value = false
  } finally {
    splitSubmitting.value = false
  }
}
</script>

<style lang="scss" scoped>
.batch-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.event-count {
  color: var(--text-secondary);
  font-size: 13px;
}
.batch-label {
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
  font-weight: 600;
}
.muted {
  color: var(--text-secondary);
}
.split-dialog-body p {
  margin: 6px 0;
  line-height: 1.6;
}
</style>
