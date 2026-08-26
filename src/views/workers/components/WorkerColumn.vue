<!-- 2026-08-26 新增：工人列（看板右栏的单个 worker 容器，Sortable target）。 -->
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
    <div class="col-body" :data-worker-id="worker.id">
      <WorkOrderCard
        v-for="b in batches"
        :key="b.batch_id"
        :batch="b"
        :source-worker-id="worker.id"
      />
      <el-empty
        v-if="batches.length === 0"
        description="暂无持有工单"
        :image-size="60"
      />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Worker, WorkOrderCard as Card } from '@/types/workerPool'
import WorkOrderCard from './WorkOrderCard.vue'

const props = defineProps<{
  worker: Worker
  batches: Card[]
}>()

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
