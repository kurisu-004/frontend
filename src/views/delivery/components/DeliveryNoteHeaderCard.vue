<!--
  DeliveryNoteHeaderCard.vue

  送货单详情头部区域（DeliveryNoteDetail 第 1 块）：
  - el-page-header：返回列表 + 单号 + 状态 tag
  - el-descriptions 信息卡：客户 / 零件数 / 送货日期 / 时间 / 司机 / 备注

  业务数据（note）由父组件通过 prop 注入；本组件只负责 UI 编排 + 日期 picker 受控转发。

  2026-08-25 frontend-overall-refactor：从 DeliveryNoteDetail.vue 抽出。
-->
<template>
  <el-page-header @back="emit('back')" class="page-header">
    <template #content>
      <span class="page-title">
        {{ note.delivery_note_no }}
        <el-tag
          :type="statusTag || 'info'"
          size="small"
          effect="plain"
        >
          {{ statusLabel }}
        </el-tag>
      </span>
    </template>
  </el-page-header>

  <el-card shadow="never" class="info-card">
    <el-descriptions :column="3" border>
      <el-descriptions-item label="单号">{{ note.delivery_note_no }}</el-descriptions-item>
      <el-descriptions-item label="客户">
        {{ note.customer_path ?? note.customer_name ?? '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="零件数">{{ note.part_count }}</el-descriptions-item>
      <el-descriptions-item label="送货日期">
        <el-date-picker
          :model-value="editDeliveryDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="未设置"
          :disabled="!canEditDate"
          style="width: 160px"
          @update:model-value="(v: string) => emit('update:editDeliveryDate', v ?? '')"
          @change="(v: string | null) => emit('delivery-date-change', v)"
        />
      </el-descriptions-item>
      <el-descriptions-item label="提交时间">
        {{ note.submitted_at ? new Date(note.submitted_at).toLocaleString() : '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="领取时间">
        {{ note.picked_up_at ? new Date(note.picked_up_at).toLocaleString() : '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="司机">
        {{ note.driver_worker_name ?? '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="备注" :span="3">
        {{ note.note || '—' }}
      </el-descriptions-item>
    </el-descriptions>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DeliveryNoteDetailOut, DeliveryNoteStatus } from '@/types/deliveryNote'
import {
  DELIVERY_NOTE_STATUS_LABEL,
  DELIVERY_NOTE_STATUS_TAG,
} from '@/types/deliveryNote'

interface Props {
  note: DeliveryNoteDetailOut
  /** 送货日期 picker v-model（受控；composable 持有 source of truth） */
  editDeliveryDate: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'back'): void
  /** 日期 picker 输入更新（composable 写入 editDeliveryDate） */
  (e: 'update:editDeliveryDate', v: string): void
  /** 日期 picker 提交（composable 调 API） */
  (e: 'delivery-date-change', v: string | null): void
}>()

/** DRAFT / SUBMITTED 状态可编辑送货日期；其它状态 disabled */
const canEditDate = computed(() =>
  props.note.status === 'DRAFT' || props.note.status === 'SUBMITTED',
)

const statusLabel = computed(() =>
  DELIVERY_NOTE_STATUS_LABEL[props.note.status as DeliveryNoteStatus] ?? props.note.status,
)
const statusTag = computed(() =>
  DELIVERY_NOTE_STATUS_TAG[props.note.status as DeliveryNoteStatus] ?? 'info',
)
</script>

<style lang="scss" scoped>
.page-header { margin-bottom: 16px; }
.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  font-weight: 600;
}
.info-card { margin-bottom: 16px; }
</style>
