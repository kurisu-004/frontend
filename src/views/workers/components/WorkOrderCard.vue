<!-- 2026-08-26 新增：工人队列看板工单卡片。
     Task 2：移除 data-* 属性（来源信息改由父级 vuedraggable @change 提供）。
     Task 3 会做视觉重写。 -->
<template>
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
      <div class="row">
        <span class="label">图号</span>
        <span class="value">{{ batch.drawing_no }}</span>
      </div>
      <div class="row">
        <span class="label">名称</span>
        <span class="value">{{ batch.part_name }}</span>
      </div>
      <div class="row">
        <span class="label">数量</span>
        <span class="value">{{ batch.quantity }}</span>
      </div>
      <div v-if="batch.serial_no" class="row">
        <span class="label">序列号</span>
        <span class="value">{{ batch.serial_no }}</span>
      </div>
      <div v-if="batch.planned_delivery_date" class="row">
        <span class="label">交期</span>
        <span class="value">{{ batch.planned_delivery_date }}</span>
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import type { WorkOrderCard as Card } from '@/types/workerPool'

defineProps<{
  batch: Card
}>()
</script>

<style scoped>
.work-order-card {
  margin-bottom: 8px;
  cursor: grab;
  border-left: 3px solid transparent;
}
.work-order-card:active {
  cursor: grabbing;
}
.work-order-card.is-urgent {
  border-left-color: #e6a23c;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}
.batch-no {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 13px;
}
.card-body .row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  line-height: 1.8;
}
.card-body .label {
  color: var(--el-text-color-secondary);
}
</style>