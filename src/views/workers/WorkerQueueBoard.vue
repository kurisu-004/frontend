<!-- 2026-08-26 新增：工人队列调度看板主页面（管理员全局视图）。
     左：PoolDrawer（单 pool，Task 4 注入激活工序）；右：WorkerColumn[]。
     拖拽 wiring 由 Task 4 通过 provide/inject 接入 dndSourceTracker + activeProcessId。 -->
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
      <PoolDrawer :pool="activePool" />
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
import { computed, onMounted } from 'vue'
import { useWorkerQueue } from '@/composables/useWorkerQueue'
import WorkerColumn from './components/WorkerColumn.vue'
import PoolDrawer from './components/PoolDrawer.vue'

const queue = useWorkerQueue()
const { workers, processPools, workerHeld, loading, error, loadBoard } = queue

// Task 2 过渡占位：activePool 固定取第一个 pool。
// Task 4 会注入 tab 切换逻辑（按 process_ids / 工序 tab）。
const activePool = computed(() => processPools.value[0] ?? null)

onMounted(async () => {
  await loadBoard()
  // DnD 暂未启用，待 Task 4 完成（vuedraggable provide/inject wiring）。
})

async function onRefresh() {
  await loadBoard()
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