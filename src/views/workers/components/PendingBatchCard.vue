<!-- 2026-09-29 新增：生产队列「待下发」Tab 卡片组件（字段补全：serial_no / L1客户 / note）。
     与 WorkOrderCard 视觉对齐但独立 —— PendingBatchItemDto 含 parent_customer_name / note，
     WorkOrderCard view-model 含 location，DTO 不同。PendingBatchCard 走 HTML5 native drag
     + checkbox 多选，WorkOrderCard 走 vue-draggable-plus，互不互通。 -->
<template>
  <el-tooltip placement="top" :show-after="200" :disabled="!hasDetails">
    <template #content>
      <div class="card-tooltip">
        <div v-if="batch.drawing_no">
          <span class="tt-label">图号</span><span>{{ batch.drawing_no }}</span>
        </div>
        <div v-if="batch.serial_no">
          <span class="tt-label">序列号</span><span>{{ batch.serial_no }}</span>
        </div>
        <div v-if="batch.customer_name">
          <span class="tt-label">客户(L2)</span><span>{{ batch.customer_name }}</span>
        </div>
        <div v-if="batch.parent_customer_name">
          <span class="tt-label">客户(L1)</span><span>{{ batch.parent_customer_name }}</span>
        </div>
        <div v-if="batch.applicant_name">
          <span class="tt-label">申请人</span><span>{{ batch.applicant_name }}</span>
        </div>
        <div v-if="batch.note">
          <span class="tt-label">备注</span><span>{{ batch.note }}</span>
        </div>
        <div>
          <span class="tt-label">交期</span><span>{{ dueDate || '—' }}</span>
        </div>
      </div>
    </template>
    <el-card
      draggable="true"
      :class="['pending-batch-card', { 'is-selected': selected, 'is-urgent': batch.is_urgent }]"
      :data-batch-id="batch.batch_id"
      shadow="hover"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
    >
      <template #header>
        <div class="card-header">
          <el-checkbox
            size="small"
            :model-value="selected"
            @change="onToggleSelect"
            @click.stop
          />
          <span class="batch-no">B{{ batch.batch_no }}</span>
          <el-tag
            v-if="batch.is_urgent"
            type="warning"
            size="small"
            effect="dark"
            class="urgent-tag"
          >加急</el-tag>
        </div>
      </template>
      <div class="card-body">
        <div class="name-row">
          <span v-if="batch.drawing_no" class="drawing-no">{{ batch.drawing_no }}</span>
          <span v-if="batch.drawing_no && batch.name" class="dot">·</span>
          <span v-if="batch.name" class="part-name">{{ batch.name }}</span>
        </div>
        <div class="meta-row">
          <el-tag
            v-if="batch.serial_no"
            size="small"
            type="info"
            effect="plain"
            class="serial-tag"
          >{{ batch.serial_no }}</el-tag>
          <span class="qty">×{{ batch.quantity }}</span>
          <span class="dot">·</span>
          <span class="due">{{ dueDate || '—' }}</span>
        </div>
        <div class="customer-row">
            <template v-if="batch.parent_customer_name || batch.customer_name">
              <span v-if="batch.parent_customer_name">{{ batch.parent_customer_name }}</span>
              <span v-if="batch.parent_customer_name && batch.customer_name" class="sep"> / </span>
              <span v-if="batch.customer_name">{{ batch.customer_name }}</span>
            </template>
            <span v-else>—</span>
        </div>
        <div v-if="batch.applicant_name" class="applicant-row">{{ batch.applicant_name }}</div>
        <el-text v-if="batch.note" size="small" type="info" line-clamp="2" class="note-row">
          {{ batch.note }}
        </el-text>
      </div>
    </el-card>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';

const props = defineProps<{
  batch: PendingBatchItemDto;
  selected: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleSelect', batchId: string): void;
  (e: 'dragstart', evt: DragEvent, batchId: string): void;
  (e: 'dragend', evt: DragEvent): void;
}>();

const dueDate = computed<string>(
  () => props.batch.planned_delivery_date ?? props.batch.system_delivery_date ?? '',
);

const hasDetails = computed<boolean>(
  () =>
    !!props.batch.drawing_no ||
    !!props.batch.serial_no ||
    !!props.batch.customer_name ||
    !!props.batch.parent_customer_name ||
    !!props.batch.applicant_name ||
    !!props.batch.note,
);

function onToggleSelect(): void {
  emit('toggleSelect', props.batch.batch_id);
}

function onDragStart(e: DragEvent): void {
  emit('dragstart', e, props.batch.batch_id);
}

// 2026-09-29 review 第 1 轮修复（M-1）：dragend 兜底移除 .is-dragging 半透明态，
// 避免下次拖拽或释放后残留；e.currentTarget 即 el-card 根 DOM 节点。
function onDragEnd(e: DragEvent): void {
  if (e.currentTarget instanceof HTMLElement) {
    e.currentTarget.classList.remove('is-dragging');
  }
  emit('dragend', e);
}
</script>

<style scoped>
.pending-batch-card {
  cursor: grab;
  border-left: 3px solid transparent;
  transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
}
.pending-batch-card:active {
  cursor: grabbing;
}
/* 2026-09-29 review 第 1 轮修复（M-1）：拖拽中半透明反馈。 */
.pending-batch-card.is-dragging {
  opacity: 0.4;
  cursor: grabbing;
}
.pending-batch-card.is-urgent {
  border-left-color: #e6a23c;
}
.pending-batch-card.is-selected {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  box-shadow: 0 0 0 1px var(--el-color-primary);
}
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.batch-no {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 13px;
  flex: 1;
}
.urgent-tag {
  margin-left: auto;
}
.card-body {
  font-size: 13px;
  line-height: 1.5;
}
.name-row {
  font-weight: 500;
  display: flex;
  gap: 4px;
  align-items: baseline;
}
.drawing-no {
  color: var(--el-text-color-primary);
}
.part-name {
  color: var(--el-text-color-secondary);
}
.meta-row {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.serial-tag {
  font-family: var(--el-font-family-monospace, monospace);
}
.qty {
  font-weight: 600;
  color: var(--el-color-primary);
}
.dot {
  color: var(--el-text-color-placeholder);
}
.due {
  font-variant-numeric: tabular-nums;
}
.customer-row {
  margin-top: 4px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sep {
  color: var(--el-text-color-placeholder);
}
.applicant-row {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.note-row {
  display: block;
  margin-top: 4px;
  line-height: 1.4;
}
.card-tooltip .tt-label {
  display: inline-block;
  min-width: 5em;
  color: rgba(255, 255, 255, 0.65);
}
.card-tooltip > div {
  display: flex;
  gap: 8px;
  line-height: 1.6;
}
</style>
