<!--
  ScanBatchPickerDialog.vue

  2026-08-31 新增：扫码 v2 by-serial 命中多批次时的选择弹窗（路线 B 配套组件）。
  顶层 part 含 is_urgent / system_delivery_date（所有 batch 共享同一交期），
  行加急红底 + 首列 chip 来自 part.is_urgent，不读 batch 上的 is_urgent。
  用法：
    props:  modelValue: boolean
            code: string
            part: PartScanInfoOut
            batches: PartBatchScanOut[]
    emits:  update:modelValue(v)
            pick({ batch, part })
-->

<template>
  <el-dialog
    :model-value="modelValue"
    title="选择批次"
    width="880px"
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      :title="`扫描 ${code} 共 ${batches.length} 个批次；点击要操作的行`"
    />

    <el-table
      v-if="part"
      :data="batches"
      row-key="id"
      border
      :max-height="420"
      :row-class-name="urgentRowClass"
      class="scan-batch-table"
      @row-click="onRowClick"
    >
      <el-table-column label="批次" min-width="120" align="center">
        <template #default="{ $index }">
          <el-tag
            v-if="props.part!.is_urgent"
            type="danger"
            size="small"
            effect="dark"
            class="urgent-chip"
          >加急</el-tag>
          <span class="batch-no">{{ $index + 1 }}</span>
        </template>
      </el-table-column>

      <el-table-column label="数量" prop="quantity" width="80" align="center" />

      <el-table-column label="状态" width="110" align="center">
        <template #default="{ row }">
          <el-tag
            v-if="row && row.status"
            :type="ORDER_STATUS_TAG_TYPE[row.status as OrderStatus]"
            size="small"
          >
            {{ ORDER_STATUS_LABEL[row.status as OrderStatus] }}
          </el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>

      <el-table-column label="所在位置 / 持有人" min-width="180" align="center" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ muted: !row?.holder_name }">{{ row?.holder_name ?? '—' }}</span>
        </template>
      </el-table-column>

      <el-table-column label="系统交期" min-width="120" align="center">
        <template #default>
          <span :class="{ muted: !props.part!.system_delivery_date }">
            {{ props.part!.system_delivery_date ?? '—' }}
          </span>
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type OrderStatus,
  type PartBatchScanOut,
  type PartScanInfoOut,
} from '@/types/parts'

const props = defineProps<{
  modelValue: boolean
  /** 扫描的序列号，仅用于标题展示 */
  code: string
  /** v2 响应顶层 part（含 is_urgent / system_delivery_date）。可空：父级在拉取批次期间 part 尚未就绪；模板用 v-if 守卫。2026-08-31 改可空以消除父级 template type assertion。 */
  part?: PartScanInfoOut | null
  /** v2 batches 数组 */
  batches: PartBatchScanOut[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'pick', payload: { batch: PartBatchScanOut; part: PartScanInfoOut }): void
}>()

/** 加急行 className：part.is_urgent 为真时打 batch-row-urgent 红底（沿用 InspectionPending 既有 row-urgent 视觉 #fde2e2）。part 未就绪时不加类。 */
function urgentRowClass({ row }: { row: PartBatchScanOut; rowIndex: number }): string {
  return props.part?.is_urgent ? 'batch-row-urgent' : ''
}

function onRowClick(row: PartBatchScanOut): void {
  // props.part 在 v-if="part" 守卫下访问时一定非空；用非空断言收口。
  emit('pick', { batch: row, part: props.part! })
  emit('update:modelValue', false)
}

function onCancel(): void {
  emit('update:modelValue', false)
}
</script>

<style scoped>
/* 加急行整行红底（与 InspectionPending / OutsourceReceivingTab 等组件 row-urgent 同色 #fde2e2）：
   用 :deep() 穿透 el-table 生成的 tr/td，避免 scoped 属性哈希不到内部单元格。 */
:deep(.el-table__row.batch-row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.batch-row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}

.muted {
  color: var(--el-text-color-secondary);
}

.urgent-chip {
  margin-right: 6px;
  vertical-align: middle;
}

.batch-no {
  font-weight: 600;
}

.scan-batch-table {
  margin-top: 12px;
}
</style>