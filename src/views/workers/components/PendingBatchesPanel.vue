<!-- 2026-09-29 卡片化：从 el-table 改为 flex-wrap 卡片网格（与其他 Tab 一致）；
     保留多选 + 拖拽 + 自动下发。字段补全：serial_no / L1客户 / note。
     卡片渲染委托给 PendingBatchCard.vue，本文件只持有工具条 / footer / 拖拽源记录。 -->
<template>
  <div class="pending-batches-panel">
    <div class="toolbar">
      <el-checkbox
        :model-value="isAllSelected"
        :indeterminate="isIndeterminate"
        @change="onToggleAll"
      >
        全选
      </el-checkbox>
      <span class="selected-hint">已选 {{ selectedIdsValue.size }} 件</span>
      <el-button
        type="primary"
        size="small"
        :loading="autoDispatchMutation.isPending.value"
        :disabled="selectedIdsValue.size === 0"
        @click="onAutoDispatch"
      >
        自动下发
      </el-button>
    </div>

    <div v-if="isLoading && batches.length === 0" class="loading-state">
      <el-skeleton :rows="5" animated />
    </div>

    <div v-else-if="batches.length === 0" class="empty-state">
      <el-empty description="暂无待下发批次" :image-size="60" />
    </div>

    <div v-else class="pending-cards">
      <PendingBatchCard
        v-for="b in batches"
        :key="b.batch_id"
        :batch="b"
        :selected="selectedIdsValue.has(b.batch_id)"
        @toggle-select="onCardToggleSelect"
        @dragstart="onCardDragStart"
      />
    </div>

    <div class="footer">
      <span class="total-hint">总计 {{ total }} 件待下发</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { recordBatchSource } from '@/utils/dndSourceTracker';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';
import PendingBatchCard from './PendingBatchCard.vue';

interface Props {
  batches: PendingBatchItemDto[];
  total: number;
  isLoading: boolean;
  /** Ref<Set<string>> —— 多选已选集合（响应式，父级 composable 持有）。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  setSelectedIds: (ids: string[]) => void;
  autoDispatchMutation: UsePendingDispatchReturn['autoDispatchMutation'];
  bulkDispatchMutation: UsePendingDispatchReturn['bulkDispatchMutation'];
}

const props = defineProps<Props>();
// 解构 props.selectedIds 时 .value 拿响应式 Set（与父级 composable.selectedIds 同源）
const selectedIdsValue = computed<Set<string>>(() => props.selectedIds.value);

const isAllSelected = computed(() => {
  if (props.batches.length === 0) return false;
  return props.batches.every((b) => selectedIdsValue.value.has(b.batch_id));
});
const isIndeterminate = computed(() => {
  if (props.batches.length === 0) return false;
  const selectedCount = props.batches.filter((b) => selectedIdsValue.value.has(b.batch_id)).length;
  return selectedCount > 0 && selectedCount < props.batches.length;
});

// el-checkbox @change 给的是 CheckboxValueType（boolean | string | number），本组件只
// 处理 boolean 分支（其它分支视作 false）。
function onToggleAll(checked: unknown) {
  const isChecked = checked === true || checked === 'true';
  if (isChecked) {
    props.setSelectedIds(props.batches.map((r) => r.batch_id));
  } else {
    props.setSelectedIds([]);
  }
}

function onCardToggleSelect(batchId: string) {
  const next = new Set(selectedIdsValue.value);
  if (next.has(batchId)) next.delete(batchId);
  else next.add(batchId);
  props.setSelectedIds(Array.from(next));
}

/** 2026-09-29 review 第 1 轮修复（C4 + M2）：行级拖拽源（HTML5 native drag）。
 *  - dataTransfer.setData('text/plain', batchId)：跨组件的标准传递通道；
 *  - recordBatchSource(batchId)：与 PendingPoolsPanel.consumeBatchSource 配对，
 *    让 dndSourceTracker 的 b: 前缀 API 有消费者（review M2）。 */
function onCardDragStart(e: DragEvent, batchId: string) {
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', batchId);
    e.dataTransfer.effectAllowed = 'move';
  }
  recordBatchSource(batchId);
}

function onAutoDispatch() {
  const ids = Array.from(selectedIdsValue.value);
  if (ids.length === 0) return;
  props.autoDispatchMutation.mutate({ batchIds: ids });
}
</script>

<style scoped>
.pending-batches-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  flex-shrink: 0;
}
.selected-hint {
  flex: 1;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.loading-state {
  flex: 1;
  padding: 24px;
}
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 2026-09-29 卡片化：flex-wrap 卡片网格，与 PoolDrawer.vue:125-130 视觉对齐。 */
.pending-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 60px;
  overflow-y: auto;
  max-height: calc(100% - 100px);
  padding: 4px 0;
  align-content: flex-start;
}
.pending-cards :deep(.pending-batch-card) {
  flex: 1 1 200px;
  max-width: 240px;
}
.footer {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
  text-align: right;
  flex-shrink: 0;
}
.total-hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.batch-no {
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 13px;
}
</style>