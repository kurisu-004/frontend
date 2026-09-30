<!-- 2026-09-30 重构：每张自产工序卡抽到 PendingPoolCard.vue。本组件只负责
     「v-for 渲染 + 空态兜底」，drop / click 交互都下沉到 PendingPoolCard。
     保留 selectedIds / selectedCount / dispatchMutation 接线。

     2026-09-30 懒加载：processes 元素新增 `count` 字段（由 WorkerQueueBoard 从
     useWorkerPoolCountsQuery 透传），PendingPoolCard 据此渲染徽标而**不再自行请求**
     per-process 详情 —— 消除了「进页面即打 N 个 GET /prod/pool/{pid}」的 N+1。
     同期删冗余的 shelfId prop（下发货架由后端按 target_process_id 在
     t_shelf_process 解析，前端不传）。 -->
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
    />
  </div>
</template>

<script setup lang="ts">
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';
import PendingPoolCard from './PendingPoolCard.vue';

defineProps<{
  /** 自产工序元数据列表（来自 useProcessesQuery.items.filter(INHOUSE)），
   *  每项带 `count`（来自 useWorkerPoolCountsQuery 的 counts[].count，
   *  加载中为占位 '…'）。 */
  processes: Array<{ id: string; code: string; name: string; count: number | string }>;
  /** 多选已选集合（响应式 Ref，父级 composable 持有），透传给 PendingPoolCard。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  selectedCount: number;
  /** 下发 mutation 透传给 PendingPoolCard。 */
  dispatchMutation: UsePendingDispatchReturn['dispatchMutation'];
}>();
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
</style>
