<!-- 2026-08-26 重构：工人队列调度看板主页面。
     顶部 el-tabs 切换工序；el-splitter 左右分栏（左 PoolDrawer / 右 WorkerColumn[]）。
     工序能力过滤：workers.filter(w => w.process_ids.includes(activeTab))。
     DnD 守卫已删：shelfId = auth.activeShelfId() ?? ''，无条件 wire。
     moveBatchToWorker / moveBatchToPool / shelfId 通过 provide/inject 透传给子组件。 -->
<template>
  <div class="worker-queue-board">
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

    <template v-else>
      <el-tabs v-model="activeTab" class="pool-tabs">
        <el-tab-pane
          v-for="p in processPools"
          :key="p.process_id"
          :name="p.process_id"
          :label="`${p.process_code} ${p.process_name}`"
        />
      </el-tabs>

      <!-- 2026-08-27 修正：size 必须带 % 单位，纯数字会被当成像素（30px/70px）。
           min 保持裸数字，语义就是 240px / 400px。 -->
      <el-splitter class="board-splitter">
        <el-splitter-panel size="30%" :min="240">
          <PoolDrawer :pool="activePool" />
        </el-splitter-panel>
        <el-splitter-panel size="70%" :min="400">
          <div class="columns-container">
            <WorkerColumn
              v-for="w in filteredWorkers"
              :key="w.id"
              :worker="w"
              :batches="workerHeld[w.id] ?? []"
            />
            <div v-if="filteredWorkers.length === 0" class="no-workers">
              该工序暂无可用工人
            </div>
          </div>
        </el-splitter-panel>
      </el-splitter>
    </template>

    <div class="board-actions">
      <el-button @click="onRefresh" :loading="loading">刷新</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuthSession } from '@/composables/useAuthSession'
import { useWorkerQueue } from '@/composables/useWorkerQueue'
import WorkerColumn from './components/WorkerColumn.vue'
import PoolDrawer from './components/PoolDrawer.vue'

const auth = useAuthSession()
const queue = useWorkerQueue()
const { workers, processPools, workerHeld, loading, error, loadBoard, moveBatchToWorker, moveBatchToPool } = queue

const activeTab = ref<string>('')
const activePool = computed(() =>
  processPools.value.find((p) => p.process_id === activeTab.value) ?? null,
)
// 2026-08-26：按当前 tab 的 process_id 过滤可加工工人（Worker.process_ids）。
const filteredWorkers = computed(() =>
  workers.value.filter((w) => w.process_ids.includes(activeTab.value)),
)

// 2026-08-26：移除 shelf_id 守卫；空串 fallback 给真后端兜底（fixture 永远 200）。
const shelfId = computed(() => auth.activeShelfId() ?? '')

// 子组件需要的 3 个 provide 注入：active tab / move 回调 / 当前 shelfId。
// 注意 provide 非空断言 —— 同一页面里 WorkerColumn / PoolDrawer 必须 inject 同一组，
// 否则 DnD 不会生效。
provide<ComputedRef<string>>('activeProcessId', computed(() => activeTab.value))
provide<typeof moveBatchToWorker>('moveBatchToWorker', moveBatchToWorker)
provide<typeof moveBatchToPool>('moveBatchToPool', moveBatchToPool)
provide<ComputedRef<string>>('shelfId', shelfId)

onMounted(async () => {
  await loadBoard()
  if (processPools.value[0]) activeTab.value = processPools.value[0].process_id
})

async function onRefresh() {
  await loadBoard()
  // 首次或 refresh 时若 activeTab 还没设（如 processPools 刚加载完），默认选第一个。
  if (!activeTab.value && processPools.value[0]) {
    activeTab.value = processPools.value[0].process_id
  }
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
.error-alert { margin-bottom: 16px; }
.pool-tabs { margin-bottom: 12px; }
.board-splitter {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}
.columns-container {
  display: flex;
  gap: 16px;
  padding: 12px;
  height: 100%;
  overflow-x: auto;
  box-sizing: border-box;
}
.no-workers {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  padding: 40px;
}
.loading-state { padding: 40px; }
.board-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
</style>
