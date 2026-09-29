<!-- 2026-09-29 重构：生产队列页（待下发 Tab + Tab 行上移 + 仅自产 + 数量徽标）。
     主结构：
       - 顶部 el-tabs（行上移：margin 0；底边线视觉承接，去掉 EP 默认下划线）
       - 内容区按 activeTab 切换：
           - __pending__：el-splitter 40/60 分栏（PendingBatchesPanel / PendingPoolsPanel）
           - 其它 process_id：原 PoolDrawer / WorkerColumn 双栏布局
       - 行内每张 tab 走 #label 插槽，标题 = `工序名(N)`（仅自产 process 自产；loadBoard
         内已 inhouse 过滤）

  2026-09-29 改造前历史：
  - 2026-08-26：阶段一，全部走 fixture；DnD 守卫已删。
  - 2026-09-14：useWorkerQueue 切真 v2。
  - 2026-09-26：消费侧禁止解构 auth store（沿 CLAUDE.md）。

  2026-09-29：提供 selectedIds / mutations 给 PendingBatchesPanel / PendingPoolsPanel 用。
  复用现有 provide 注入（activeProcessId / moveBatchToWorker / moveBatchToPool /
  shelfId），新增 selectedIds / setSelectedIds / dispatchMutation /
  bulkDispatchMutation / autoDispatchMutation 五项。 -->
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
        <el-tab-pane name="__pending__">
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code">待下发</span>
              <span class="tab-label__count">({{ pendingDispatch.batches.value.length }})</span>
            </span>
          </template>
          <!-- 待下发 Tab：左栏 el-table 多选 + 右栏自产工序 pool 卡（单击调
               bulkDispatchMutation；拖拽目标视觉态）。 -->
          <el-splitter class="board-splitter">
            <el-splitter-panel size="40%" :min="320">
              <PendingBatchesPanel
                :batches="pendingDispatch.batches.value"
                :total="pendingDispatch.total.value"
                :is-loading="pendingDispatch.isLoading.value"
                :selected-ids="pendingDispatch.selectedIds"
                :set-selected-ids="pendingDispatch.setSelectedIds"
                :auto-dispatch-mutation="pendingDispatch.autoDispatchMutation"
                :bulk-dispatch-mutation="pendingDispatch.bulkDispatchMutation"
              />
            </el-splitter-panel>
            <el-splitter-panel size="60%" :min="320">
              <PendingPoolsPanel
                :pools="processPools"
                :selected-ids="pendingDispatch.selectedIds"
                :selected-count="pendingDispatch.selectedCount.value"
                :shelf-id="shelfId"
                :bulk-dispatch-mutation="pendingDispatch.bulkDispatchMutation"
              />
            </el-splitter-panel>
          </el-splitter>
        </el-tab-pane>

        <el-tab-pane
          v-for="p in processPools"
          :key="p.process_id"
          :name="p.process_id"
        >
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code">{{ p.process_code }}</span>
              <span class="tab-label__count">({{ p.batches.length }})</span>
            </span>
          </template>
          <!-- 自产工序 Tab：原 PoolDrawer / WorkerColumn 双栏。 -->
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
                <div v-if="filteredWorkers.length === 0" class="no-workers">该工序暂无可用工人</div>
              </div>
            </el-splitter-panel>
          </el-splitter>
        </el-tab-pane>
      </el-tabs>

      <div class="board-actions">
        <el-button :loading="loading" @click="onRefresh">刷新</el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { useWorkerQueue } from '@/views/workers/composables/useWorkerQueue';
import { usePendingDispatch } from '@/views/workers/composables/usePendingDispatch';
import WorkerColumn from './components/WorkerColumn.vue';
import PoolDrawer from './components/PoolDrawer.vue';
import PendingBatchesPanel from './components/PendingBatchesPanel.vue';
import PendingPoolsPanel from './components/PendingPoolsPanel.vue';

const auth = useAuthStore();
const queue = useWorkerQueue();
const route = useRoute();
const router = useRouter();
// 2026-09-29 review 第 1 轮修复（C2）：caller 注入 refreshBoard，dispatch / bulk / auto
// 三类 mutation onSuccess 都会调一次 —— processPools 是模块级 ref，invalidate 失效链
// 触达不到，必须显式重新 loadBoard 同步看板计数。
const refreshBoard = async (): Promise<void> => {
  await queue.loadBoard(shelfId.value || null);
};
const pendingDispatch = usePendingDispatch({ refreshBoard });
const {
  workers,
  processPools,
  workerHeld,
  loading,
  error,
  loadBoard,
  moveBatchToWorker,
  moveBatchToPool,
} = queue;

// 2026-09-29 review 第 1 轮修复（M1）：activeTab 默认 = __pending__（首屏即待下发 tab，
// 符合任务规约「待下发 Tab 在最前」）；URL ?tab=XXX 可覆盖（深链到具体工序），
// 覆盖优先级 > 默认。worker-queue-board 路由未注册？—— 沿 dashboard 同形态，
// 是 WorkerQueuePage 父路由的 query 参数。
const TAB_QUERY_KEY = 'tab';
const PENDING_TAB = '__pending__';
function readInitialTab(): string {
  const q = route.query[TAB_QUERY_KEY];
  if (typeof q === 'string' && q.length > 0) return q;
  return PENDING_TAB;
}
const activeTab = ref<string>(readInitialTab());
// activeTab 变更 → 同步写到 URL（replace 不污染 history）。
watch(activeTab, (next) => {
  void router.replace({ query: { ...route.query, [TAB_QUERY_KEY]: next } });
});
const activePool = computed(
  () => processPools.value.find((p) => p.process_id === activeTab.value) ?? null,
);
const filteredWorkers = computed(() =>
  workers.value.filter((w) => w.process_ids.includes(activeTab.value)),
);

const shelfId = computed(() => auth.activeShelfId ?? '');
// 2026-09-29 review 第 1 轮修复（C4）：shelfId 暴露给 PendingPoolsPanel 单击 / drop 走
// bulkDispatchMutation.mutate 用 —— 与 auth.activeShelfId 同源，单一依赖源。
provide<ComputedRef<string>>(
  'activeProcessId',
  computed(() => activeTab.value),
);
provide<typeof moveBatchToWorker>('moveBatchToWorker', moveBatchToWorker);
provide<typeof moveBatchToPool>('moveBatchToPool', moveBatchToPool);
provide<ComputedRef<string>>('shelfId', shelfId);

onMounted(async () => {
  await loadBoard(shelfId.value || null);
  // 注：activeTab 默认 __pending__ 不动；loadBoard 后若 URL ?tab 命中具体 process_id
  // 但该 process 不在 processPools（外协 / 已删除）→ fallback 到第一个自产 process，
  // 避免 activePool = null 时左栏空、右栏「该工序暂无可用工人」。
  if (
    activeTab.value !== PENDING_TAB &&
    !processPools.value.some((p) => p.process_id === activeTab.value) &&
    processPools.value[0]
  ) {
    activeTab.value = processPools.value[0].process_id;
  }
});

async function onRefresh() {
  await loadBoard(shelfId.value || null);
  ElMessage.success('已刷新');
}
</script>

<style scoped>
.worker-queue-board {
  padding: 0 16px 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.error-alert {
  margin-bottom: 16px;
}
/* 2026-09-29：Tab 行上移（margin 0）+ 去掉 EP 默认下划线，让 tab 行视觉承接顶部边线 */
.pool-tabs {
  margin: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.pool-tabs :deep(.el-tabs__nav-wrap)::after {
  background: transparent;
}
/* 2026-09-29：EP 内部结构升级时的兜底，避免 nav-wrap::after 失效时丢失分割线 */
.pool-tabs :deep(.el-tabs__header) {
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.board-splitter {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  margin-top: 12px;
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
.loading-state {
  padding: 40px;
}
.board-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
.tab-label {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.tab-label__code {
  font-weight: 600;
}
.tab-label__count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
</style>