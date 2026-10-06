<!-- 单工序 tab body 组件（QueueBoard 的 el-tab-pane body）。
     tab 懒加载 + 数据层 TanStack Query 化：本组件是该 tab body 的**唯一** query
     持有者（`useQueueBoard(processId)`），激活时才发请求；30s staleTime 保证切回已
     激活过的 tab 不重拉。
     渲染：el-splitter 30/70 分栏（PoolDrawer + WorkerColumn）+ skeleton / empty 兜底。

     2026-10-08 重构（N+1 收口）：后端把工人列的持有批次与容量三字段内联进
     `QueueBoard.workers[]` 之后，本组件**不再为每个工人发请求**（此前是「1 个工序
     详情 + N 个单工人 state」）。工人数组直接映射 `board.workers[]` 透传给
     WorkerColumn，不再拼 `max_held: 0 / is_online: true` 这类占位值 —— 那些占位值
     与工人列自己那次请求的结果长期对不上，列头容量一度显示 0/0。 -->
<template>
  <div class="process-board-tab">
    <div v-if="board.isLoading.value" class="loading-state">
      <el-skeleton :rows="6" animated />
    </div>
    <div v-else-if="board.error.value" class="error-state">
      <el-empty description="加载失败" />
    </div>
    <el-splitter v-else-if="poolView" class="board-splitter">
      <el-splitter-panel size="30%" :min="240">
        <PoolDrawer :pool="poolView" />
      </el-splitter-panel>
      <el-splitter-panel size="70%" :min="400">
        <div class="columns-container">
          <WorkerColumn v-for="w in workersForTab" :key="w.worker_id" :worker="w" />
          <div v-if="workersForTab.length === 0" class="no-workers">该工序暂无可用工人</div>
        </div>
      </el-splitter-panel>
    </el-splitter>
    <div v-else class="empty-state">
      <el-empty description="暂无数据" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { poolItemToCard } from '../utils/queueItemToCard';
import type { ProcessPoolView } from '@/types/productionQueue';
import type { QueueWorkerSchema } from '../composables/productionQueueSchema';
import { useQueueBoard } from '../composables/useQueueBoard';
import PoolDrawer from './PoolDrawer.vue';
import WorkerColumn from './WorkerColumn.vue';

// 不接 shelfId prop —— 组件内部无引用，shelfId 由 QueueBoard provide 注入给内嵌的
// WorkerColumn / PoolDrawer 消费。本组件走 useQueueBoard 不依赖 shelfId（端点路径
// 参数只有 process_id）。
const props = defineProps<{
  processId: string;
}>();

// tab 懒加载数据源 —— 走 qk.productionQueueBoard(processId) 缓存键；
// 30s staleTime 去重窗口保证切回已激活过的 tab 不会重拉。
const board = useQueueBoard(() => props.processId);

/** 工人列数据：后端已内联持有批次与容量三字段，**直接透传**（WorkerColumn 零请求）。
 *  注意与旧的 `Worker` view-model 的差别：键名从 `id` 变成 `worker_id`（不再有
 *  中间层改写），`is_online` / `process_ids` 两个前端自造字段随之消失。 */
const workersForTab = computed<QueueWorkerSchema[]>(() => board.data.value?.workers ?? []);

/** 把 query data 适配成 PoolDrawer 接受的 ProcessPoolView。PoolDrawer 不变 ——
 *  props: pool: ProcessPoolView | null；batches 走 poolItemToCard 适配。 */
const poolView = computed<ProcessPoolView | null>(() => {
  const data = board.data.value;
  if (!data) return null;
  return {
    process_id: data.process.process_id,
    process_code: data.process.process_code,
    process_name: data.process.process_name,
    batches: data.items.map(poolItemToCard),
  };
});
</script>

<style scoped>
.process-board-tab {
  width: 100%;
  height: 100%;
}
.loading-state,
.error-state,
.empty-state {
  padding: 40px;
}
.board-splitter {
  /* 父级 .el-tab-pane 是块容器（EP 2.14.6 的 el-tabs.css 里没有 .el-tab-pane 规则），
     故下面这两行 flex/min-height 实际不生效；撑满高度的是 EP 自带的
     `.el-splitter { height: 100% }`。留着只是历史惯性，不要以为高度靠它们。 */
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  margin-top: 12px;
}
.columns-container {
  display: flex;
  gap: 16px;
  padding: 12px;
  height: 100%;
  overflow-x: auto;
  box-sizing: border-box;
}
.no-workers {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  padding: 40px;
}
</style>