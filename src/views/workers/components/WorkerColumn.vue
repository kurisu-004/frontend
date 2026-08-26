<!-- 2026-08-26 重构：工人列（vuedraggable target）。
     接收父级 provide 注入：moveBatchToWorker / shelfId。
     @start 把 from dataset 写到 dndSourceTracker；@change.added 时读 + delete，调 moveBatchToWorker。 -->
<template>
  <el-card class="worker-column" shadow="never">
    <template #header>
      <div class="col-header">
        <div class="worker-info">
          <el-avatar :size="32" class="avatar">{{ worker.name.charAt(0) }}</el-avatar>
          <div>
            <div class="name">{{ worker.name }}</div>
            <div class="badge">{{ worker.badge_code }} · {{ worker.work_type_code }}</div>
          </div>
        </div>
        <el-tag v-if="!worker.is_online" type="info" size="small">离线</el-tag>
      </div>
      <el-progress
        :percentage="capacityPercent"
        :format="() => `${worker.current_held}/${worker.max_held}`"
        :status="capacityStatus"
      />
    </template>
    <div
      ref="containerRef"
      class="col-body"
      :data-worker-id="worker.id"
    >
      <div v-for="batch in batches" :key="batch.batch_id" class="col-body-item">
        <WorkOrderCard :batch="batch" />
      </div>
    </div>
    <el-empty
      v-if="batches.length === 0"
      description="暂无持有工单"
      :image-size="60"
    />
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref, toRef } from 'vue'
import type { ComputedRef } from 'vue'
import { useDraggable } from 'vue-draggable-plus'
import type { Worker, WorkOrderCard as Card } from '@/types/workerPool'
import { consumeProcessSource, recordSource } from '../composables/dndSourceTracker'
import WorkOrderCard from './WorkOrderCard.vue'

const props = defineProps<{
  worker: Worker
  batches: Card[]
}>()

// 2026-08-27 迁移：vue-draggable-plus 组件仅支持 v-model，batches 是 readonly
// defineProps 不能 v-model。改用 useDraggable composable 接收 toRef(props, 'batches')，
// 让 Sortable.js 直接原地变更（与旧 vuedraggable :list 行为一致）。
const containerRef = ref<HTMLElement | null>(null)
const batchesRef = toRef(props, 'batches')
const { start } = useDraggable(containerRef, batchesRef, {
  group: 'work-orders',
  animation: 150,
  ghostClass: 'sortable-ghost',
})

// 2026-08-26：page provide 必注入；非空断言（无注入则 dev 立即报错，prod 抛运行时错误）。
const moveBatchToWorker = inject<(batch_id: string, to_worker_id: string, shelf_id: string, process_id: string) => Promise<boolean>>('moveBatchToWorker')!
const shelfId = inject<ComputedRef<string>>('shelfId')!

const capacityPercent = computed(() => {
  if (props.worker.max_held === 0) return 0
  return Math.round((props.worker.current_held / props.worker.max_held) * 100)
})

// 注：el-progress 的 status 只接受 '' | 'success' | 'warning' | 'exception'，
// 没有 'primary'。中段（>=70%）走空串，让 EP 走默认主色（蓝）。
const capacityStatus = computed<'success' | 'warning' | ''>(() => {
  if (props.worker.capacity_remaining === 0) return 'warning'
  if (capacityPercent.value >= 70) return ''
  return 'success'
})

interface DraggableStartEvent {
  item: HTMLElement
  from: HTMLElement
}

function onDragStart(evt: DraggableStartEvent) {
  // 2026-08-26：记录源工序 ID（拖出 PoolDrawer 的 process_id）。
  // dataset 里的 kebab-case 自动转 camelCase：data-process-id → processId。
  const batchId = evt.item.dataset.batchId
  const fromProcessId = evt.from.dataset.processId
  if (batchId && fromProcessId) recordSource(batchId, fromProcessId)
}

/** 2026-08-27 迁移：vue-draggable-plus @add 事件 payload = Sortable.js 原生，
 *  item 为被拖入的 HTMLElement；通过 WorkOrderCard 上的 :data-batch-id 反查 batch_id。 */
async function onDragAdd(evt: DraggableStartEvent) {
  if (!evt.item) return
  const batchId = evt.item.dataset.batchId
  if (!batchId) return
  const fromProcessId = consumeProcessSource(batchId)
  if (!fromProcessId) return
  await moveBatchToWorker(batchId, props.worker.id, shelfId.value, fromProcessId)
}
</script>

<style scoped>
.worker-column {
  width: 280px;
  flex-shrink: 0;
}
.col-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}
.worker-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.avatar {
  background-color: var(--el-color-primary);
  color: white;
}
.name { font-weight: 600; font-size: 14px; }
.badge { font-size: 12px; color: var(--el-text-color-secondary); }
.col-body {
  min-height: 100px;
  max-height: 70vh;
  overflow-y: auto;
}
</style>
