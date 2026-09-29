<!-- 2026-09-29 新增：生产队列「待下发」Tab 左栏 —— 待下发批次表格 + 多选。
     接收父级 WorkerQueueBoard.vue 显式 props 传 selectedIds / setSelectedIds /
     dispatchMutation / autoDispatchMutation；顶部「全选 / 已选 N 件 / 自动下发」；
     底部「总计 N 件待下发」。表格列与 el-table 行为对齐 PartPickerDialog.vue
     （行级多选 + selection-change）。 -->
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

    <el-table
      v-else
      ref="tableRef"
      :data="batches"
      row-key="batch_id"
      height="100%"
      stripe
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="44" />
      <el-table-column label="拖" width="40" align="center">
        <template #default="{ row }">
          <div
            class="drag-handle"
            draggable="true"
            :title="`拖动到右侧工序卡 → batch ${row.batch_id}`"
            @dragstart="onRowDragStart($event, row.batch_id)"
          >
            <el-icon><Rank /></el-icon>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="batch_no" label="批次号" width="100">
        <template #default="{ row }">
          <span class="batch-no">B{{ row.batch_no }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="drawing_no" label="图号" width="120" show-overflow-tooltip />
      <el-table-column prop="name" label="零件名" min-width="140" show-overflow-tooltip />
      <el-table-column prop="quantity" label="数量" width="80" align="right">
        <template #default="{ row }"> ×{{ row.quantity }} </template>
      </el-table-column>
      <el-table-column label="计划交期" width="120">
        <template #default="{ row }">
          {{ row.planned_delivery_date ?? row.system_delivery_date ?? '—' }}
        </template>
      </el-table-column>
      <el-table-column prop="customer_name" label="客户" width="120" show-overflow-tooltip />
      <el-table-column prop="applicant_name" label="申请人" width="100" show-overflow-tooltip />
      <el-table-column label="加急" width="70" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.is_urgent" type="warning" size="small">加急</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <div class="footer">
      <span class="total-hint">总计 {{ total }} 件待下发</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Rank } from '@element-plus/icons-vue';
import { recordBatchSource } from '@/utils/dndSourceTracker';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';

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

const tableRef = ref<{ toggleRowSelection: (row: PendingBatchItemDto, selected: boolean) => void } | null>(
  null,
);

function onSelectionChange(rowsSel: PendingBatchItemDto[]) {
  // 2026-09-29：@selection-change 只反映当前可见行；保留之前被筛外勾上的批次
  // （与 PartPickerDialog.vue:259 行为同源）。
  const visibleIds = new Set(rowsSel.map((r) => r.batch_id));
  const hiddenPrev = props.batches.filter((r) => !visibleIds.has(r.batch_id));
  const merged = [...hiddenPrev, ...rowsSel];
  props.setSelectedIds(merged.map((r) => r.batch_id));
}

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
  const tbl = tableRef.value;
  if (!tbl) return;
  props.batches.forEach((row) => {
    tbl.toggleRowSelection(row, isChecked);
  });
  if (isChecked) {
    props.setSelectedIds(props.batches.map((r) => r.batch_id));
  } else {
    props.setSelectedIds([]);
  }
}

function onAutoDispatch() {
  const ids = Array.from(selectedIdsValue.value);
  if (ids.length === 0) return;
  props.autoDispatchMutation.mutate({ batchIds: ids });
}

/** 2026-09-29 review 第 1 轮修复（C4 + M2）：行级拖拽源（HTML5 native drag）。
 *  - dataTransfer.setData('text/plain', batchId)：跨组件的标准传递通道；
 *  - recordBatchSource(batchId)：与 PendingPoolsPanel.consumeBatchSource 配对，
 *    让 dndSourceTracker 的 b: 前缀 API 有消费者（review M2）。 */
function onRowDragStart(e: DragEvent, batchId: string) {
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', batchId);
    e.dataTransfer.effectAllowed = 'move';
  }
  recordBatchSource(batchId);
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
/* 2026-09-29 review 第 1 轮修复（C4）：拖拽 handle 列视觉态 —— 鼠标 hover/active
   给出 grab/grabbing 反馈，让用户知道这格可拖。 */
.drag-handle {
  cursor: grab;
  color: var(--el-text-color-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
}
.drag-handle:hover {
  color: var(--el-color-primary);
}
.drag-handle:active {
  cursor: grabbing;
}
</style>