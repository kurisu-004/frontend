<!-- 2026-08-26 新增：工序 pool 容器（看板左栏，单 pool 视图，vuedraggable target）。
     Tab 切换由父级提供 pool；本组件只渲染当前激活工序。 -->
<template>
  <div class="pool-drawer">
    <div v-if="pool" class="pool-section">
      <div class="section-header">
        <span class="process-code">{{ pool.process_code }}</span>
        <span class="process-name">{{ pool.process_name }}</span>
        <el-tag size="small" type="info">{{ pool.batches.length }}</el-tag>
      </div>
      <draggable
        :list="pool.batches"
        :group="'work-orders'"
        item-key="batch_id"
        :animation="150"
        ghost-class="sortable-ghost"
        class="section-body pool-cards"
        @change="onDragChange"
      >
        <template #item="{ element }">
          <WorkOrderCard :batch="element" />
        </template>
      </draggable>
    </div>
    <div v-else class="pool-empty">无工序数据</div>
  </div>
</template>

<script setup lang="ts">
import draggable from 'vuedraggable'
import type { ProcessPoolView, WorkOrderCard as Card } from '@/types/workerPool'
import WorkOrderCard from './WorkOrderCard.vue'

const props = defineProps<{
  pool: ProcessPoolView | null
  /**
   * 从某 worker 列拖回此 pool 时触发。fromWorkerId 由父级 provide/inject 注入
   * （Task 4 引入 dndSourceTracker），本步仅占位：
   * WorkerColumn 调用 onAddToWorker（pool → worker），PoolDrawer 调用 onAddToPool
   * （worker → pool），二者方向相反、来源信息不同。
   * 可选属性：Task 4 注入真 handler；Task 2 WorkerQueueBoard 不传。
   */
  onAddToPool?: (batch: Card, fromWorkerId: string | null) => Promise<void>
}>()

interface DraggableChangeEvent {
  added?: { element: Card }
}

async function onDragChange(evt: DraggableChangeEvent) {
  if (!evt.added) return
  // Task 2 过渡：WorkerQueueBoard 暂未提供 onAddToPool；Task 4 注入真 handler。
  if (!props.onAddToPool) return
  // Task 4 在 page provide dndSourceTracker.fromWorkerId；
  // 当前 Task 2 无追踪源，传 null。
  await props.onAddToPool(evt.added.element, null)
}
</script>

<style scoped>
.pool-drawer {
  width: 320px;
  flex-shrink: 0;
  border-right: 1px solid var(--el-border-color);
  padding-right: 16px;
  overflow-y: auto;
  max-height: 80vh;
}
.pool-section {
  margin-bottom: 24px;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
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
/* 2026-08-26：多列卡片布局用 flex + wrap；具体卡片宽度由 Task 5 视觉重写时
   细化为 flex: 0 0 calc(50% - 4px) 或固定 220px。 */
.pool-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 60px;
}
.pool-empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>