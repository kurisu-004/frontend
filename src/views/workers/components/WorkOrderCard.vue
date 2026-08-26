<!-- 2026-08-26 新增：工人队列看板工单卡片。
     Task 2：移除 data-* 属性（来源信息改由父级 vuedraggable @change 提供）。
     Task 3：紧凑化卡片，详情走 el-tooltip 浮层（header 仅 batch_no + 加急 tag，body 仅一行 part_name · qty · due）。 -->
<template>
  <el-tooltip placement="top" :show-after="200" :disabled="!hasDetails">
    <template #content>
      <div class="card-tooltip">
        <div><span class="tt-label">图号</span><span>{{ batch.drawing_no }}</span></div>
        <div v-if="batch.serial_no"><span class="tt-label">序列号</span><span>{{ batch.serial_no }}</span></div>
        <div v-if="batch.customer"><span class="tt-label">客户</span><span>{{ batch.customer }}</span></div>
        <div v-if="batch.applicant"><span class="tt-label">申请人</span><span>{{ batch.applicant }}</span></div>
        <div v-if="batch.location"><span class="tt-label">所在位置</span><span>{{ batch.location }}</span></div>
      </div>
    </template>
    <el-card
      class="work-order-card"
      :class="{ 'is-urgent': batch.is_urgent }"
      shadow="hover"
    >
      <template #header>
        <div class="card-header">
          <span class="batch-no">{{ batch.batch_no }}</span>
          <el-tag v-if="batch.is_urgent" type="warning" size="small" effect="dark">加急</el-tag>
        </div>
      </template>
      <div class="card-body">
        <div class="name-row">{{ batch.part_name }}</div>
        <div class="meta-row">
          <span class="qty">×{{ batch.quantity }}</span>
          <span class="dot">·</span>
          <span class="due">{{ dueDate }}</span>
        </div>
      </div>
    </el-card>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WorkOrderCard as Card } from '@/types/workerPool'

const props = defineProps<{ batch: Card }>()

const dueDate = computed(() =>
  props.batch.planned_delivery_date ?? props.batch.system_delivery_date ?? '',
)

const hasDetails = computed(
  () =>
    !!props.batch.customer ||
    !!props.batch.applicant ||
    !!props.batch.location ||
    !!props.batch.serial_no,
)
</script>

<style scoped>
.work-order-card {
  cursor: grab;
  border-left: 3px solid transparent;
}
.work-order-card:active { cursor: grabbing; }
.work-order-card.is-urgent { border-left-color: #e6a23c; }
.card-header {
  display: flex; justify-content: space-between; align-items: center;
  font-weight: 600;
}
.batch-no {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 13px;
}
.card-body { font-size: 13px; line-height: 1.5; }
.name-row { font-weight: 500; }
.meta-row {
  display: flex; gap: 4px; align-items: baseline;
  color: var(--el-text-color-secondary);
}
.qty { font-weight: 600; color: var(--el-color-primary); }
.dot { color: var(--el-text-color-placeholder); }
.due { font-variant-numeric: tabular-nums; }
.card-tooltip .tt-label {
  display: inline-block; min-width: 4em; color: rgba(255,255,255,0.65);
}
.card-tooltip > div { display: flex; gap: 8px; line-height: 1.6; }
</style>