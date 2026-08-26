<!-- 2026-08-26 新增：工序 pool 容器（看板左栏，按工序分组，Sortable target）。 -->
<template>
  <div class="pool-drawer">
    <div v-for="pool in pools" :key="pool.process_id" class="pool-section">
      <div class="section-header">
        <span class="process-code">{{ pool.process_code }}</span>
        <span class="process-name">{{ pool.process_name }}</span>
        <el-tag size="small" type="info">{{ pool.batches.length }}</el-tag>
      </div>
      <div class="section-body" :data-process-id="pool.process_id">
        <WorkOrderCard
          v-for="b in pool.batches"
          :key="b.batch_id"
          :batch="b"
          :source-process-id="pool.process_id"
        />
        <el-empty
          v-if="pool.batches.length === 0"
          description="该工序无待分配"
          :image-size="50"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ProcessPoolView } from '@/types/workerPool'
import WorkOrderCard from './WorkOrderCard.vue'

defineProps<{
  pools: ProcessPoolView[]
}>()
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
.section-body {
  min-height: 60px;
}
</style>
