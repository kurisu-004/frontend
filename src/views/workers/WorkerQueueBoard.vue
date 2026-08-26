<!-- 2026-08-26 新增：工人队列调度看板主页面（管理员全局视图）。
     左：PoolDrawer（按工序分组）；右：WorkerColumn[]。
     拖拽 wiring 在 Task 6 注入。 -->
<template>
  <div class="worker-queue-board">
    <div class="board-header">
      <h2 class="title">工人队列调度</h2>
      <div class="actions">
        <el-button @click="onRefresh" :loading="loading">刷新</el-button>
      </div>
    </div>

    <el-alert
      v-if="error"
      type="error"
      :title="error"
      :closable="false"
      show-icon
      class="error-alert"
    />

    <div v-if="loading && workers.length === 0" class="loading-state">
      <el-skeleton :rows="5" animated />
    </div>

    <div v-else class="board-content">
      <PoolDrawer :pools="processPools" />
      <div class="columns-container">
        <WorkerColumn
          v-for="w in workers"
          :key="w.id"
          :worker="w"
          :batches="workerHeld[w.id] ?? []"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useWorkerQueue } from '@/composables/useWorkerQueue'
import WorkerColumn from './components/WorkerColumn.vue'
import PoolDrawer from './components/PoolDrawer.vue'

const queue = useWorkerQueue()
const { workers, processPools, workerHeld, loading, error, loadBoard } = queue

onMounted(async () => {
  await loadBoard()
})

async function onRefresh() {
  await loadBoard()
  ElMessage.success('已刷新')
}
</script>

<style scoped>
.worker-queue-board {
  padding: 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.board-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.title { margin: 0; font-size: 20px; }
.error-alert { margin-bottom: 16px; }
.board-content {
  display: flex;
  gap: 16px;
  flex: 1;
  overflow: hidden;
}
.columns-container {
  display: flex;
  gap: 16px;
  flex: 1;
  overflow-x: auto;
}
.loading-state { padding: 40px; }
</style>