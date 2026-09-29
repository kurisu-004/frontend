<!-- 2026-09-29 新增：生产队列「待下发」Tab 右栏 —— 自产工序 pool 简化卡。
     每张卡是 drop target（接收 PendingBatchesPanel 拖入）；单击调
     bulkDispatchMutation（仅对选中 batchIds 有效；为空则弹 toast 兜底）。
     视觉沿用 PoolDrawer.vue:7-11 的 section-header 样式（process_code /
     process_name / N tag）。

     2026-09-29：右栏暂只展示自产工序卡（INHOUSE category），与 WorkerQueueBoard 顶
     tabs 仅展示自产工序对齐（任务规约 #2）。PnP 关系由 useWorkerQueue.loadBoard
     过滤后的 processPools 派生，本组件直接接 props。 -->
<template>
  <div class="pending-pools-panel">
    <div v-if="pools.length === 0" class="empty">暂无可下发工序</div>
    <div
      v-for="p in pools"
      :key="p.process_id"
      :class="['pool-card', { 'is-dropping': isDropping === p.process_id }]"
      @dragover.prevent="onDragOver(p.process_id)"
      @dragleave="onDragLeave(p.process_id)"
      @drop.prevent="onDrop(p)"
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
import type { ProcessPoolView } from '@/types/workerPool';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';

interface Props {
  pools: ProcessPoolView[];
  /** Set<string> —— 多选已选集合（响应式 snapshot，父级 composable 持有）。 */
  selectedIds: Set<string>;
  selectedCount: number;
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

/** 单击工序卡 → 对已选 batchIds 触发批量下发（pool 的 next_process_id 需 service 端
 *  按 process_chain_id 推导，本组件暂不维护 shelfId / nextProcessId 选择 UI——
 * 任务规约 #4 简化为「单击调 bulkDispatchMutation；shelves / processes 二选一由
 * 后续 PR 提供 dialog」）。当前若 nextProcessId 未知则 toast 兜底。 */
function onClickPool(p: ProcessPoolView) {
  if (props.selectedIds.size === 0) {
    ElMessage.warning('请先选择待下发批次');
    return;
  }
  // 2026-09-29 简化版：因当前 ui 暂不提供 shelves / nextProcess 选 UI，本 click 路径
  // 暂不直接调 bulkDispatchMutation；改抛 toast 提示用户用「自动下发」按钮（沿
  // autoDispatch 行为）。后续 PR 加 shelves dialog 再走 bulkDispatchMutation.mutate。
  ElMessage.info(
    `「${p.process_code}」批量下发 UI 待 PR 完善；当前请用「自动下发」按钮（按工艺链自动分发）`,
  );
  // 保留 drop 路径以支持原生 HTML5 拖拽。
  void p;
}

/** 拖拽 batch → pool（仅占位 UI；当前无 dragSource 注入 → 暂未串通）。
 * 完整流程需在 PendingBatchesPanel 侧把 batchId 写入 dndSourceTracker（与
 * PoolDrawer 同形态），并由本组件 consume 后调 bulkDispatchMutation。本期
 * 不实现拖拽交付；保留 @drop 接口位置（防止 EP warning） + 视觉态。 */
function onDrop(p: ProcessPoolView) {
  isDropping.value = null;
  ElMessage.info(`拖拽下发「${p.process_code}」待 PR 完善`);
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