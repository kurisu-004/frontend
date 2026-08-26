<!-- 2026-08-26 新增：工人列（看板右栏的单个 worker 容器，vuedraggable target）。
     拖拽 wiring 由 Task 4 注入 activeProcessId；本步先占位 ref(null)。 -->
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
    <draggable
      :list="batches"
      :group="'work-orders'"
      item-key="batch_id"
      :animation="150"
      ghost-class="sortable-ghost"
      class="col-body"
      @change="onDragChange"
    >
      <template #item="{ element }">
        <WorkOrderCard :batch="element" />
      </template>
    </draggable>
    <el-empty
      v-if="batches.length === 0"
      description="暂无持有工单"
      :image-size="60"
    />
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import draggable from 'vuedraggable'
import type { Worker, WorkOrderCard as Card } from '@/types/workerPool'
import WorkOrderCard from './WorkOrderCard.vue'

const props = defineProps<{
  worker: Worker
  batches: Card[]
  /**
   * 拖入此工人列时触发。fromProcessId 由父级 provide/inject 注入的 activeProcessId 提供；
   * Task 4 注入真值，Task 2 暂未提供（WorkerQueueBoard 不传此 prop）。
   * 可选属性：vue-tsc 不会因为父级未传而报错；onDragChange 内部判空兜底。
   */
  onAddToWorker?: (batch: Card, fromProcessId: string | null) => Promise<void>
}>()

// Task 4 注入当前 tab 的 process_id；Task 2 暂未提供，注入回退到 ref(null)。
const activeProcessId = inject<Ref<string | null>>('activeProcessId', ref(null))

const capacityPercent = computed(() => {
  if (props.worker.max_held === 0) return 0
  return Math.round((props.worker.current_held / props.worker.max_held) * 100)
})

// 注：el-progress 的 status 只接受 '' | 'success' | 'warning' | 'exception'，
// 没有 'primary'。中段（>=70%）走空串，让 EP 走默认主色（蓝）—— 与 brief 中
// 'primary' 的视觉意图（与 success 绿 / warning 黄有别的第三色）一致。
const capacityStatus = computed<'success' | 'warning' | ''>(() => {
  if (props.worker.capacity_remaining === 0) return 'warning'
  if (capacityPercent.value >= 70) return ''
  return 'success'
})

interface DraggableChangeEvent {
  added?: { element: Card }
}

async function onDragChange(evt: DraggableChangeEvent) {
  if (!evt.added) return
  // Task 2 过渡：WorkerQueueBoard 暂未提供 onAddToWorker；Task 4 注入真 handler。
  if (!props.onAddToWorker) return
  await props.onAddToWorker(evt.added.element, activeProcessId.value)
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