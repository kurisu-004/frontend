<!-- 2026-08-26 重构：工序 pool 容器（vuedraggable target）。
     接收父级 provide 注入：moveBatchToPool / shelfId / activeProcessId。
     @start 把 from dataset 写到 dndSourceTracker（worker 源）；@change.added 时调 moveBatchToPool。 -->
<template>
  <div class="pool-drawer">
    <div v-if="pool" class="pool-section">
      <div class="section-header">
        <span class="process-code">{{ pool.process_code }}</span>
        <span class="process-name">{{ pool.process_name }}</span>
        <el-tag size="small" type="info">{{ pool.batches.length }}</el-tag>
      </div>
      <div
        ref="containerRef"
        class="section-body pool-cards"
        :data-process-id="pool.process_id"
      >
        <div v-for="batch in pool.batches" :key="batch.batch_id" class="pool-cards-item">
          <WorkOrderCard :batch="batch" />
        </div>
      </div>
    </div>
    <div v-else class="pool-empty">无工序数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { useDraggable } from 'vue-draggable-plus'
import type { ProcessPoolView } from '@/types/workerPool'
import { consumeWorkerSource, recordWorkerSource } from '../composables/dndSourceTracker'
import WorkOrderCard from './WorkOrderCard.vue'

const props = defineProps<{
  pool: ProcessPoolView | null
}>()

// 2026-08-27 迁移：见 WorkerColumn.vue 同段注释。pool 是 readonly prop，
// pool.batches 用 computed 拆出独立 ref 让 useDraggable 直接 bind。
const containerRef = ref<HTMLElement | null>(null)
const poolBatchesRef = computed(() => props.pool?.batches ?? [])
const { start } = useDraggable(containerRef, poolBatchesRef, {
  group: 'work-orders',
  animation: 150,
  ghostClass: 'sortable-ghost',
})

// 2026-08-26：page provide 必注入；非空断言。
const moveBatchToPool = inject<(batch_id: string, from_worker_id: string, shelf_id: string, next_process_id: string) => Promise<boolean>>('moveBatchToPool')!
const shelfId = inject<ComputedRef<string>>('shelfId')!
const activeProcessId = inject<ComputedRef<string>>('activeProcessId')!

interface DraggableStartEvent {
  item: HTMLElement
  from: HTMLElement
}

function onDragStart(evt: DraggableStartEvent) {
  // 2026-08-26：记录源 worker ID（拖出 WorkerColumn 的 worker.id）。
  const batchId = evt.item.dataset.batchId
  const fromWorkerId = evt.from.dataset.workerId
  if (batchId && fromWorkerId) recordWorkerSource(batchId, fromWorkerId)
}

/** 2026-08-27 迁移：vue-draggable-plus @add 事件 payload = Sortable.js 原生。 */
async function onDragAdd(evt: DraggableStartEvent) {
  if (!props.pool) return
  if (!evt.item) return
  const batchId = evt.item.dataset.batchId
  if (!batchId) return
  const fromWorkerId = consumeWorkerSource(batchId)
  if (!fromWorkerId) return
  // 撤回目标 = 当前 tab 的 process_id（即此 pool）。
  await moveBatchToPool(batchId, fromWorkerId, shelfId.value, activeProcessId.value)
}
</script>

<style scoped>
.pool-drawer {
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow-y: auto;
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
/* 2026-08-26：多列卡片布局用 flex + wrap。 */
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
