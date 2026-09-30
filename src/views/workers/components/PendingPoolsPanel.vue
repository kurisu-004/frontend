<!-- 2026-09-30 重构：每张自产工序卡抽到 PendingPoolCard.vue 自管 useWorkerPoolByProcessQuery。
     props 从 `pools: ProcessPoolView[]` 改为 `processes: { id, code, name }[]`。
     本组件只负责「v-for 渲染 + 空态兜底」，drop / click 交互都下沉到 PendingPoolCard。
     保留 selectedIds / selectedCount / bulkDispatchMutation 接线（provide 由父级
     WorkerQueueBoard 注入 selectedIds 与 mutation）。 -->
<template>
  <div class="pending-pools-panel">
    <div v-if="processes.length === 0" class="empty">暂无可下发工序</div>
    <PendingPoolCard
      v-for="p in processes"
      :key="p.id"
      :process="p"
      :selected-ids="selectedIds"
      :bulk-dispatch-mutation="bulkDispatchMutation"
    />
  </div>
</template>

<script setup lang="ts">
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';
import PendingPoolCard from './PendingPoolCard.vue';

defineProps<{
  /** 2026-09-30 改：自产工序元数据列表（来自 useProcessesQuery.items.filter(INHOUSE)）。
   *  PendingPoolCard.vue 内部自管 useWorkerPoolByProcessQuery(processId)，与同 processId
   *  的 WorkerPoolTab 共享 cache identity。 */
  processes: Array<{ id: string; code: string; name: string }>;
  /** 2026-09-30：多选已选集合（响应式 Ref，父级 composable 持有），透传给 PendingPoolCard。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  selectedCount: number;
  /** 2026-09-30 改：bulkDispatchMutation 透传给 PendingPoolCard（取代原 onDrop click 在此组件）。 */
  bulkDispatchMutation: UsePendingDispatchReturn['bulkDispatchMutation'];
  /** 2026-09-30 review 第 1 轮修复（C4）：shelfId prop 保留（WorkerQueueBoard 仍在
   *  :shelf-id="shelfId" 接线，本 plan 不动 WorkerQueueBoard）—— 但 2026-09-29 修复后
   *  不再用于 mutate：后端通过 `target_process_id` + `t_shelf_process` 自动解析货架。
   *  暂未删除以保 caller 兼容；后续 commit 可选清理。 */
  shelfId: string;
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
