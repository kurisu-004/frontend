<!-- 2026-09-30 新增：单工序 tab body 组件（WorkerQueueBoard 的 el-tab-pane body）。
     tab 懒加载 + 数据层 TanStack Query 化：WorkerPoolTab 内部自管
     useWorkerPoolByProcessQuery，激活时才发请求；同 processId 与 PendingPoolCard
     共享 cache identity（hit 即不重拉）。
     渲染：el-splitter 30/70 分栏（PoolDrawer + WorkerColumn）+ skeleton / empty 兜底。 -->
<template>
  <div class="worker-pool-tab">
    <div v-if="query.isLoading.value" class="loading-state">
      <el-skeleton :rows="6" animated />
    </div>
    <div v-else-if="query.error.value" class="error-state">
      <el-empty description="加载失败" />
    </div>
    <el-splitter v-else-if="poolView" class="board-splitter">
      <el-splitter-panel size="30%" :min="240">
        <PoolDrawer :pool="poolView" />
      </el-splitter-panel>
      <el-splitter-panel size="70%" :min="400">
        <div class="columns-container">
          <WorkerColumn
            v-for="w in workersForTab"
            :key="w.id"
            :worker="w"
          />
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
import { computed, type MaybeRefOrGetter } from 'vue';
import { useWorkerPoolByProcessQuery } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { poolItemToCard } from '@/views/workers/composables/poolItemToCard';
import type { Worker, ProcessPoolView } from '@/types/workerPool';
import PoolDrawer from './PoolDrawer.vue';
import WorkerColumn from './WorkerColumn.vue';

const props = defineProps<{
  processId: string;
  shelfId: MaybeRefOrGetter<string | null>;
}>();

// 2026-09-30：tab 懒加载数据源 —— useWorkerPoolByProcessQuery 自管 query，
// 走 qk.workerPoolByProcess(processId) 缓存键。POSITIVE_INFINITY 缓存保证
// 切回已激活过的 tab 不会重拉；同 processId 的 PendingPoolCard 也走同一键，
// 共享 cache identity（hit 即不重拉）。
const query = useWorkerPoolByProcessQuery(() => props.processId);

/** 2026-09-30：聚合 workerId + processId + 工序 code/name → UI Worker 结构。
 *  pool 适配走 poolItemToCard（共享 useWorkerPoolCountsQuery 域内的 batch 适配）。
 *  注意：Worker.is_online / badge_code / max_held / current_held 等字段由
 *  WorkerColumn 内 useWorkerStateByWorkerQuery 拉取并就地合成 UI 显示；
 *  这里仅持 worker 维度骨架（id / name / work_type_code / process_ids）。 */
const workersForTab = computed<Worker[]>(() => {
  const list = query.data.value?.workers ?? [];
  return list.map((brief) => ({
    id: brief.worker_id,
    name: brief.name,
    badge_code: '',
    work_type_code: brief.work_type_code,
    max_held: 0,
    current_held: 0,
    capacity_remaining: 0,
    is_online: true,
    process_ids: [props.processId],
  }));
});

/** 2026-09-30：把 query data 适配成 PoolDrawer 接受的 ProcessPoolView（沿用既有 DTO）。
 *  PoolDrawer 不变 —— props: pool: ProcessPoolView | null。batches 走 poolItemToCard 适配。 */
const poolView = computed<ProcessPoolView | null>(() => {
  const data = query.data.value;
  if (!data) return null;
  return {
    process_id: data.process_id,
    process_code: data.process_code,
    process_name: data.process_name,
    batches: data.items.map(poolItemToCard),
  };
});
</script>

<style scoped>
.worker-pool-tab {
  width: 100%;
  height: 100%;
}
.loading-state,
.error-state,
.empty-state {
  padding: 40px;
}
.board-splitter {
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