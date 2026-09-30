<!-- 2026-09-30：自产工序 pool 卡（PendingPoolsPanel 的 v-for 项）——「待下发」Tab
     右栏的**下发目标**卡片（单击下发 / 拖放批次到此工序）。
     渲染：标题 (code + name + badge 候选 batch 数) + 交互区。

     2026-09-30 懒加载关键改动：**本卡片不再自管 useWorkerPoolByProcessQuery**。
     改前：卡片为了渲染右上角 badge（`items.length`）而发 `GET /prod/pool/{pid}`，
     而本卡片位于**默认首屏激活的「待下发」tab** 内、且 `v-for` 全部 INHOUSE 工序
     ⇒ 进页面即打出 N 个 per-process 详情请求（N+1），与「切到 tab 才懒加载」的
     设计意图完全相反。
     改后：badge 直接取 `useWorkerPoolCountsQuery` 的聚合计数（单请求，本页已 eager
     拉取用于 tab 标题徽标），本组件**零网络请求**。per-process 详情只有
     `WorkerPoolTab`（el-tab-pane `:lazy="true"`）会拉。
     ⇒ 进入页面的请求数恒为 3：`GET /prod/processes` + `GET /prod/pool/counts` +
     `GET /prod/batches/pending`。

     拖拽：dataTransfer.getData('text/plain') 拿 batch_id → 同样调 dispatchMutation。 -->
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
      <el-tag size="small" type="info">{{ props.count }}</el-tag>
    </div>
    <div class="section-body">点击下发或拖入批次到此工序</div>
  </div>
</template>

<script setup lang="ts">
import { ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { consumeBatchSource } from '@/utils/dndSourceTracker';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';

interface Props {
  /** 单工序的轻量元数据（来自 useProcessesQuery.items.filter(INHOUSE)）。 */
  process: { id: string; code: string; name: string };
  /** 该工序候选批次徽标 —— 由父级 WorkerQueueBoard 从 useWorkerPoolCountsQuery 的
   *  `counts[].count` 透传（`number` 或加载中占位 `'…'`）。本卡片不自行请求。 */
  count: number | string;
  /** 多选已选集合（响应式 Ref，父级 composable 持有）。 */
  selectedIds: Ref<Set<string>>;
  /** 下发 mutation（来自 usePendingDispatch.dispatchMutation）。 */
  dispatchMutation: UsePendingDispatchReturn['dispatchMutation'];
}

const props = defineProps<Props>();

// 2026-09-30：拖拽 hover 视觉态（从原 PendingPoolsPanel 迁入）。
const isDropping = ref(false);

function onDragOver() {
  isDropping.value = true;
}

function onDragLeave() {
  isDropping.value = false;
}

/** 单击工序卡 → 对已选 batchIds 下发到该工序。
 *  selectedIds 空 → ElMessage.warning 兜底；非空 → dispatchMutation.mutate。
 *  单件下发 = `batchIds.length === 1`（后端 dispatch 已是 bulk-only 形态）。 */
function onClick() {
  const ids = Array.from(props.selectedIds.value);
  if (ids.length === 0) {
    ElMessage.warning('请先选择待下发批次');
    return;
  }
  props.dispatchMutation.mutate({
    batchIds: ids,
    targetProcessId: props.process.id,
  });
}

/** 2026-09-30：拖拽 batch → pool（HTML5 native drag-drop）。
 *  - dataTransfer.getData('text/plain') 拿 batch_id（HTML5 native drag 标准传递）；
 *  - consumeBatchSource 同步清理 dndSourceTracker（PendingBatchesPanel dragstart 已
 *    通过 recordBatchSource 写入），让 recordBatchSource / consumeBatchSource 这对
 *    API 有消费者；
 *  - 单 batch 调 dispatchMutation（与 click path 复用同一 mutation，沿用 onSuccess
 *    的 invalidateAll 失效链 + 成功 toast）。 */
function onDrop(e: DragEvent) {
  isDropping.value = false;
  const dt = e.dataTransfer;
  const fromTransfer = dt?.getData('text/plain') ?? null;
  const batchId = fromTransfer || null;
  if (!batchId) return;
  consumeBatchSource(batchId);
  props.dispatchMutation.mutate({
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
