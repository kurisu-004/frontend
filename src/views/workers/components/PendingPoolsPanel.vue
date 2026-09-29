<!-- 2026-09-29 新增：生产队列「待下发」Tab 右栏 —— 自产工序 pool 简化卡。
     每张卡是 drop target（接收 PendingBatchesPanel 拖入）；单击调
     bulkDispatchMutation（仅对选中 batchIds 有效；为空则弹 toast 兜底）。
     视觉沿用 PoolDrawer.vue:7-11 的 section-header 样式（process_code /
     process_name / N tag）。

     2026-09-29：右栏暂只展示自产工序卡（INHOUSE category），与 WorkerQueueBoard 顶
     tabs 仅展示自产工序对齐（任务规约 #2）。PnP 关系由 useWorkerQueue.loadBoard
     过滤后的 processPools 派生，本组件直接接 props。

     2026-09-29 修复 dispatch 契约漂移：手动 dispatch 传 `targetProcessId: p.process_id`
     （来自当前 pool card 的 process_id），不受工艺链约束。后端通过 `target_process_id`
     + `t_shelf_process` 自动解析货架，不再走旧的 auto-dispatch fallback。onDrop /
     onClickPool 共用同一入参形态（`{ batchIds, targetProcessId }`）。 -->
<template>
  <div class="pending-pools-panel">
    <div v-if="pools.length === 0" class="empty">暂无可下发工序</div>
    <div
      v-for="p in pools"
      :key="p.process_id"
      :class="['pool-card', { 'is-dropping': isDropping === p.process_id }]"
      @dragover.prevent="onDragOver(p.process_id)"
      @dragleave="onDragLeave(p.process_id)"
      @drop.prevent="onDrop(p, $event)"
      @click="onClickPool(p)"
    >
      <div class="section-header">
        <span class="process-code">{{ p.process_code }}</span>
        <span class="process-name">{{ p.process_name }}</span>
        <el-tag size="small" type="info">{{ selectedCount }}</el-tag>
      </div>
      <div class="section-body">点击下发或拖入批次到此工序</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { consumeBatchSource } from '@/utils/dndSourceTracker';
import type { ProcessPoolView } from '@/types/workerPool';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';

interface Props {
  pools: ProcessPoolView[];
  /** Ref<Set<string>> —— 多选已选集合（响应式，父级 composable 持有）。
   *  2026-09-29 review 第 1 轮修复（m3）：与 PendingBatchesPanel 的 selectedIds
   *  prop 形态对齐（都用 Ref，不解包），保证消费侧 .value 写法统一。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  selectedCount: number;
  /** shelfId prop 保留（WorkerQueueBoard 仍在 `:shelf-id="shelfId"` 接线，本 plan
   *  不动 WorkerQueueBoard）—— 但 2026-09-29 修复后不再用于 mutate：后端通过
   *  `target_process_id` + `t_shelf_process` 自动解析货架。 */
  shelfId: string;
  bulkDispatchMutation: UsePendingDispatchReturn['bulkDispatchMutation'];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  /** 池接收到拖拽后清掉 selectedIds（沿 mutation onSuccess 行为一致） */
  cleared: [];
}>();

// 2026-09-29：拖拽 hover 视觉态（区分当前 drop target）
const isDropping = ref<string | null>(null);

function onDragOver(processId: string) {
  isDropping.value = processId;
}
function onDragLeave(processId: string) {
  if (isDropping.value === processId) isDropping.value = null;
}

/** 单击工序卡 → 对已选 batchIds 触发批量下发到该工序。
 *  2026-09-29 修复 dispatch 契约漂移：传 `targetProcessId: p.process_id`
 *  （来自 pool card 的 process_id），不再传 shelfId（后端自动解析货架）。
 *  这里把 `_p` 改为 `p`（去掉下划线前缀）—— 现在确实使用 `p.process_id`，无需
 *  `void p;` 之类 silent-unused 兜底。 */
function onClickPool(p: ProcessPoolView) {
  const ids = Array.from(props.selectedIds.value);
  if (ids.length === 0) {
    ElMessage.warning('请先选择待下发批次');
    return;
  }
  props.bulkDispatchMutation.mutate({
    batchIds: ids,
    targetProcessId: p.process_id,
  });
}

/** 拖拽 batch → pool（HTML5 native drag-drop）。
 *  2026-09-29 修复 dispatch 契约漂移：
 *  - 传 `targetProcessId: p.process_id`（pool card 自带 process_id），不发 shelfId；
 *  - dataTransfer.getData('text/plain') 拿 batch_id（HTML5 native drag 标准传递）；
 *  - consumeBatchSource 同步清理 dndSourceTracker（PendingBatchesPanel dragstart 已
 *    通过 recordBatchSource 写入），让 recordBatchSource / consumeBatchSource 这对
 *    API 有消费者（review M2）；
 *  - 单 batch 调 bulkDispatchMutation（mutate 不批量 concat，与 click path 复用同一
 *    mutation，沿用 onSuccess 里 chainRequired 兜底 + invalidateAll + refreshBoard）。
 *
 *  注：本组件不校验 drop 来源池（不区分是从「待下发」Tab 拖来的，还是从其它工序
 *  Tab 拖来的）—— recordBatchSource 用 'b:' 前缀隔离，consumeBatchSource 读不到
 *  就视为非待下发源，silently return。 */
function onDrop(p: ProcessPoolView, e: DragEvent) {
  isDropping.value = null;
  const dt = e.dataTransfer;
  const fromTransfer = dt?.getData('text/plain') ?? null;
  const batchId = fromTransfer || null;
  if (!batchId) return;
  // 与 recordBatchSource 配对清理（即便下面 mutate 失败，源条目也不应在下次拖拽残留）
  consumeBatchSource(batchId);
  // 2026-09-29 review 第 1 轮修复：drop 后清掉 selectedIds（与 mutation onSuccess
  // 行为一致）—— 用户已通过拖拽显式表达 dispatch 意图，清掉避免重复触发。
  props.bulkDispatchMutation.mutate({
    batchIds: [batchId],
    targetProcessId: p.process_id,
  });
  emit('cleared');
}
</script>

<style scoped>
.pending-pools-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow-y: auto;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
/* 沿 PoolDrawer.vue:106-114 section-header 样式 */
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