<!-- 2026-09-30 重构：tab body 懒加载 + 数据层 TanStack Query 化（CLAUDE.md 2026-09-30 硬约束）。
     主结构：
       - 顶部 el-tabs（行上移，底边线视觉承接）
       - 内容区按 activeTab 切换：
           - __pending__：el-splitter 40/60 分栏（PendingBatchesPanel / PendingPoolsPanel）
           - 其它 process_id：WorkerPoolTab（自管 useWorkerPoolByProcessQuery）
       - 行内每张 tab 走 #label 插槽，标题 = `工序名(N)`（N 来自 useWorkerPoolCountsQuery
         的 counts[process_id].count；首屏即用，不依赖 tab 是否激活）
       - 每个 tab pane 加 :lazy="true"，body 替换为 <WorkerPoolTab :process-id="p.id" :shelf-id="shelfId" />

  2026-09-30 改造前历史（沿 2026-09-29 review 第 1 轮修复）：
  - 2026-08-26：阶段一，全部走 fixture；DnD 守卫已删。
  - 2026-09-14：useWorkerQueue 切真 v2。
  - 2026-09-26：消费侧禁止解构 auth store（沿 CLAUDE.md）。
  - 2026-09-29：提供 selectedIds / mutations 给 PendingBatchesPanel / PendingPoolsPanel 用。
    复用现有 provide 注入（activeProcessId / moveBatchToWorker / moveBatchToPool /
    shelfId），新增 selectedIds / setSelectedIds / dispatchMutation /
    bulkDispatchMutation / autoDispatchMutation 五项。

  2026-09-30 改造要点：
  - 顶部导入 useProcessesQuery / useWorkerPoolCountsQuery / WorkerPoolTab；
  - 移除 import { listProcesses }（processes 改走共享 useProcessesQuery）；
  - 移除 processPools 数据源（tab body 自管 query，counts 走共享 query）；
  - inhouseProcs = computed(() => procsQuery.data.value?.items.filter(p => p.category === 'INHOUSE') ?? [])；
  - tab badge：poolCount(pid) = countsQuery.data.value?.counts.find(c => c.process_id === pid)?.count ?? '…'；
  - 每个 el-tab-pane v-for="p in inhouseProcs" 加 :lazy="true"；
  - PendingPoolsPanel props 改为 :processes="inhouseProcs.map(...)"；
  - 删除 loadBoard 在 OnMounted 的调用（首屏为 processes + counts 由 TanStack 自动 fetch）；
  - loading = procsQuery.isLoading || countsQuery.isLoading（仅控制初始 skeleton）；
  - 保留 ?tab= 深链 + URL sync + fallback（fallback 检测 inhouseProcs 而非 processPools）；
  - WorkerColumn 已重构为自管 useWorkerStateByWorkerQuery，调用点 :batches="workerHeld[w.id] ?? []" 删除。 -->
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

    <div v-if="loading" class="loading-state">
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
          <!-- 待下发 Tab：左栏 el-table 多选 + 右栏自产工序卡（PendingPoolCard 自管
               useWorkerPoolByProcessQuery）。 -->
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
                :processes="inhouseProcessesForPanel"
                :selected-ids="pendingDispatch.selectedIds"
                :selected-count="pendingDispatch.selectedCount.value"
                :shelf-id="shelfId"
                :bulk-dispatch-mutation="pendingDispatch.bulkDispatchMutation"
              />
            </el-splitter-panel>
          </el-splitter>
        </el-tab-pane>

        <el-tab-pane
          v-for="p in inhouseProcs"
          :key="p.id"
          :name="p.id"
          :lazy="true"
        >
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code">{{ p.code }}</span>
              <span class="tab-label__count">({{ poolCount(p.id) }})</span>
            </span>
          </template>
          <!-- 自产工序 Tab：WorkerPoolTab 自管 useWorkerPoolByProcessQuery，
               :lazy="true" 保证切到该 tab 才发请求。shelfId 由本组件 provide 注入
               给内嵌 WorkerColumn / PoolDrawer 消费，WorkerPoolTab 自身不需要
               （2026-09-30 review 第 1 轮修复 m4 删除 shelfId prop）。 -->
          <WorkerPoolTab :process-id="p.id" />
        </el-tab-pane>
      </el-tabs>

      <div class="board-actions">
        <el-button :loading="loading" @click="onRefresh">刷新</el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import { useAuthStore } from '@/stores/auth';
import { useWorkerQueue } from '@/views/workers/composables/useWorkerQueue';
import { usePendingDispatch } from '@/views/workers/composables/usePendingDispatch';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import {
  invalidateWorkerPoolByProcessAll,
} from '@/composables/queries/useWorkerPoolByProcessQuery';
import {
  invalidateWorkerPoolCountsQuery,
} from '@/composables/queries/useWorkerPoolCountsQuery';
import WorkerPoolTab from './components/WorkerPoolTab.vue';
import PendingBatchesPanel from './components/PendingBatchesPanel.vue';
import PendingPoolsPanel from './components/PendingPoolsPanel.vue';

const auth = useAuthStore();
const queue = useWorkerQueue();
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

// 2026-09-30：processes 改走共享 useProcessesQuery（POSITIVE_INFINITY 缓存，与仓内 12 个 caller
// 共享缓存身份），不再调 listProcesses + module-level ref。
const procsQuery = useProcessesQuery();
const inhouseProcs = computed(() =>
  procsQuery.data.value?.items.filter((p) => p.category === 'INHOUSE') ?? [],
);
// 2026-09-30：PendingPoolsPanel props 由 processPools 改为 processes（轻量元数据），
// WorkerPoolTab + PendingPoolCard 自管 useWorkerPoolByProcessQuery 拉完整数据。
const inhouseProcessesForPanel = computed(() =>
  inhouseProcs.value.map((p) => ({ id: p.id, code: p.code, name: p.name })),
);

// 2026-09-30：tab 标题 (N) 徽标数据源 —— 全工序 batch 计数共享 query（eager 拉取，
// POSITIVE_INFINITY 缓存）。无 processes 时显示「…」。
const countsQuery = useWorkerPoolCountsQuery(() => ({ shelf_id: shelfId.value || undefined }));
function poolCount(pid: string): number | string {
  if (countsQuery.isLoading.value) return '…';
  const entry = countsQuery.data.value?.counts.find((c) => c.process_id === pid);
  return entry?.count ?? 0;
}

// 2026-09-29 review 第 1 轮修复（C2）：caller 注入 refreshBoard，dispatch / bulk / auto
// 三类 mutation onSuccess 都会调一次 —— processPools 已下线（commit 3 起），但 useWorkerQueue
// 内 workerHeld 模块级 ref 仍由 loadBoard 驱动，故 refreshBoard 继续指向 loadBoard。
const refreshBoard = async (): Promise<void> => {
  await queue.loadBoard(shelfId.value || null);
};
const pendingDispatch = usePendingDispatch({ refreshBoard });
const {
  loading: queueLoading,
  error,
  moveBatchToWorker,
  moveBatchToPool,
} = queue;

// 2026-09-30：loading 由 procsQuery.isLoading || countsQuery.isLoading 控制初始 skeleton，
// 不阻塞 tab 切换；queueLoading 仅在 onRefresh 拉 workerHeld 时显示。
const loading = computed(() => procsQuery.isLoading.value || countsQuery.isLoading.value || queueLoading.value);

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

const shelfId = computed(() => auth.activeShelfId ?? '');
// 2026-09-29 review 第 1 轮修复（C4）：shelfId 暴露给 PendingPoolsPanel 单击 / drop 走
// bulkDispatchMutation.mutate 用 —— 与 auth.activeShelfId 同源，单一依赖源。
// 2026-09-30：PendingPoolCard 自管 useWorkerPoolByProcessQuery 不需要 shelfId，
// 但 PendingPoolsPanel 仍保留 shelfId prop 以保 caller 兼容；shelfId 同时通过
// provide 注入给 WorkerColumn（自管 useWorkerStateByWorkerQuery）。
provide<ComputedRef<string>>(
  'activeProcessId',
  computed(() => activeTab.value),
);
provide<typeof moveBatchToWorker>('moveBatchToWorker', moveBatchToWorker);
provide<typeof moveBatchToPool>('moveBatchToPool', moveBatchToPool);
provide<ComputedRef<string>>('shelfId', shelfId);

// 2026-09-30：删除 onMounted 的 loadBoard —— 首屏 processes + counts 由 TanStack 自动 fetch；
// workerHeld 走 WorkerColumn 内 useWorkerStateByWorkerQuery 自管。
// 但 fallback 仍依赖 inhouseProcs 解析（从 procsQuery.data.value 派生）；用 watch 在
// procsQuery.data 解析后跑一次 fallback 检测。
watch(
  () => procsQuery.data.value,
  () => {
    if (
      activeTab.value !== PENDING_TAB &&
      !inhouseProcs.value.some((p) => p.id === activeTab.value) &&
      inhouseProcs.value[0]
    ) {
      activeTab.value = inhouseProcs.value[0].id;
    }
  },
  { immediate: true },
);

async function onRefresh() {
  // 2026-09-30：刷新 — 失效所有 worker-pool 域缓存（counts / by-process / state）
  // + workerHeld 模块级 ref（loadBoard）。下一帧 tab / WorkerColumn 重新拉数据。
  await invalidateWorkerPoolCountsQuery(qc);
  await invalidateWorkerPoolByProcessAll(qc);
  await queue.loadBoard(shelfId.value || null);
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
