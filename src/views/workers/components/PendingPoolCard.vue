<!-- 2026-09-30 新增：自产工序 pool 卡（PendingPoolsPanel 的 v-for 项）。
     每张卡自管 useWorkerPoolByProcessQuery(processId)，与同 processId 的 WorkerPoolTab
     共享 cache identity（数据零冗余）。
     渲染：标题 (code + name + badge 候选 batch 数) + 单击下发 / 拖拽交互（从原
     PendingPoolsPanel 拆出）。
     选中下发：selectedIds 非空时调 bulkDispatchMutation.mutate({ batchIds, targetProcessId })。
     拖拽：dataTransfer.getData('text/plain') 拿 batch_id → 同样调 bulkDispatchMutation。 -->
<template>
  <div
    :class="['pool-card', { 'is-dropping': isDropping }]"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
    @click="onClick"
  >
    <div class="section-header">
      <span class="process-code">{{ props.process.code }}</span>
      <span class="process-name">{{ props.process.name }}</span>
      <el-tag size="small" type="info">{{ badgeCount }}</el-tag>
    </div>
    <div class="section-body">点击下发或拖入批次到此工序</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkerPoolByProcessQuery } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { consumeBatchSource } from '@/utils/dndSourceTracker';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';

interface Props {
  /** 单工序的轻量元数据（来自 useProcessesQuery.items.filter(INHOUSE)）。 */
  process: { id: string; code: string; name: string };
  /** 多选已选集合（响应式 Ref，父级 composable 持有）。 */
  selectedIds: Ref<Set<string>>;
  /** 批量下发 mutation（来自 usePendingDispatch.bulkDispatchMutation）。 */
  bulkDispatchMutation: UsePendingDispatchReturn['bulkDispatchMutation'];
}

const props = defineProps<Props>();

// 2026-09-30：每张卡自管 query，与同 processId 的 WorkerPoolTab 共享 cache identity。
// 共享基础数据层约定 #5：POSITIVE_INFINITY 缓存 + 写操作 invalidate。
const query = useWorkerPoolByProcessQuery(() => props.process.id);

// 2026-09-30：badge 显示「候选 batch 总数」（沿用 PoolDrawer 视觉），加载中显示「…」。
const badgeCount = computed<string>(() => {
  if (query.isLoading.value) return '…';
  return String(query.data.value?.items.length ?? 0);
});

// 2026-09-30：拖拽 hover 视觉态（从原 PendingPoolsPanel 迁入）。
const isDropping = ref(false);

function onDragOver() {
  isDropping.value = true;
}
function onDragLeave() {
  isDropping.value = false;
}

/** 2026-09-30：单击工序卡 → 对已选 batchIds 触发批量下发到该工序。
 *  沿 PendingPoolsPanel.onClickPool：selectedIds 空 → ElMessage.warning 兜底；
 *  非空 → bulkDispatchMutation.mutate({ batchIds, targetProcessId: process.id })。 */
function onClick() {
  const ids = Array.from(props.selectedIds.value);
  if (ids.length === 0) {
    ElMessage.warning('请先选择待下发批次');
    return;
  }
  props.bulkDispatchMutation.mutate({
    batchIds: ids,
    targetProcessId: props.process.id,
  });
}

/** 2026-09-30：拖拽 batch → pool（HTML5 native drag-drop，从原 PendingPoolsPanel 迁入）。
 *  - dataTransfer.getData('text/plain') 拿 batch_id（HTML5 native drag 标准传递）；
 *  - consumeBatchSource 同步清理 dndSourceTracker（PendingBatchesPanel dragstart 已
 *    通过 recordBatchSource 写入），让 recordBatchSource / consumeBatchSource 这对
 *    API 有消费者（review M2）；
 *  - 单 batch 调 bulkDispatchMutation（mutate 不批量 concat，与 click path 复用同一
 *    mutation，沿用 onSuccess 里 chainRequired 兜底 + invalidateAll + refreshBoard）。 */
function onDrop(e: DragEvent) {
  isDropping.value = false;
  const dt = e.dataTransfer;
  const fromTransfer = dt?.getData('text/plain') ?? null;
  const batchId = fromTransfer || null;
  if (!batchId) return;
  consumeBatchSource(batchId);
  props.bulkDispatchMutation.mutate({
    batchIds: [batchId],
    targetProcessId: props.process.id,
  });
}
</script>

<style scoped>
.pool-card {
  cursor: pointer;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  transition:
    border-color 0.2s,
    background 0.2s;
}
.pool-card:hover {
  border-color: var(--el-color-primary-light-5);
}
.pool-card.is-dropping {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
.process-code {
  font-weight: 600;
  font-family: var(--el-font-family-monospace, monospace);
}
.process-name {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  flex: 1;
}
.section-body {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  padding: 0 8px;
}
</style>