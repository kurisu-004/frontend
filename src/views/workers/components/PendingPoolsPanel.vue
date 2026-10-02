<!-- 2026-09-30 重构：每张自产工序卡抽到 PendingPoolCard.vue。本组件只负责
     「v-for 渲染 + 空态兜底」，drop / click 交互都下沉到 PendingPoolCard。
     保留 selectedIds / dispatchMutation 接线。

     2026-09-30 懒加载：processes 元素新增 `count` 字段（由 WorkerQueueBoard 从
     useWorkerPoolCountsQuery 透传），PendingPoolCard 据此渲染徽标而**不再自行请求**
     per-process 详情 —— 消除了「进页面即打 N 个 GET /prod/pool/{pid}」的 N+1。
     同期删冗余的 shelfId prop（下发货架由后端按 target_process_id 在
     t_shelf_process 解析，前端不传）。

     2026-10-02：processes 元素新增 `color`（工序色，透传给卡片的左边框）；布局由
     单列改 flex-wrap 网格，与左栏待下发池同款；删死 prop selectedCount（模板从未消费）。
     2026-10-02 增 `hoveredProcessId`：拖拽悬停高亮态的透传口，逐卡折算成
     PendingPoolCard 的 dropping。 -->
<template>
  <div class="pending-pools-panel">
    <div v-if="processes.length === 0" class="empty">暂无可下发工序</div>
    <PendingPoolCard
      v-for="p in processes"
      :key="p.id"
      :process="p"
      :count="p.count"
      :selected-ids="selectedIds"
      :dispatch-mutation="dispatchMutation"
      :dropping="p.id === hoveredProcessId"
    />
  </div>
</template>

<script setup lang="ts">
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';
import PendingPoolCard from './PendingPoolCard.vue';

defineProps<{
  /** 自产工序元数据列表（来自 useProcessesQuery.items.filter(INHOUSE)），
   *  每项带 `count`（来自 useWorkerPoolCountsQuery 的 counts[].count，
   *  加载中为占位 '…'）与 `color`（工序色，用于卡片左边框）。 */
  processes: Array<{
    id: string;
    code: string;
    name: string;
    color: string | null | undefined;
    count: number | string;
  }>;
  /** 多选已选集合（响应式 Ref，父级 composable 持有），透传给 PendingPoolCard。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  /** 下发 mutation 透传给 PendingPoolCard。 */
  dispatchMutation: UsePendingDispatchReturn['dispatchMutation'];
  /** 2026-10-02：当前被拖拽悬停的工序 id（父级 WorkerQueueBoard 持有，源面板
   *  PendingBatchesPanel 的 onMove 上报）。命中该 id 的工序卡渲染 .is-dropping 高亮，
   *  null = 无悬停目标、全部不亮。 */
  hoveredProcessId?: string | null;
}>();
</script>

<style scoped>
/* 2026-10-02：单列改 flex-wrap 网格，与左栏待下发池同款（200px 卡片 + 8px gap）。 */
.pending-pools-panel {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow-y: auto;
}
.pending-pools-panel :deep(.pool-card) {
  flex: 0 0 200px;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
