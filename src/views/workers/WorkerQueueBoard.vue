<!-- 生产队列看板（路由 /workers/queue，menuCode worker_queue）。
     自 2026-09-30 起的结构：
       - 顶部 el-tabs（行上移，底边线视觉承接）
       - 首个固定 tab「待下发」(name = __pending__)：el-splitter 40/60 分栏
         （左 PendingBatchesPanel 待下发批次列表 / 右 PendingPoolsPanel 自产工序卡）
       - 后续每张 INHOUSE 工序一个 tab，body = <WorkerPoolTab :process-id="p.id" />，
         全部带 :lazy="true" ⇒ 切到该 tab 才 mount 才发 `GET /prod/pool/{pid}`
     tab 标题 `(N)` 徽标数据源 = useWorkerPoolCountsQuery（单请求跨货架聚合）。

     2026-09-30 三项修复（详见文末变更记录）：
       1. 对齐后端 `worker-pool` → `pool` 路径收敛（全部 URL 前缀 `/prod/worker-pool`
          → `/prod/pool`；assign + remove 合并为 `/prod/pool/move`）；
       2. 消除「进页面即加载全部工序池」的 N+1 —— PendingPoolCard 徽标改走
          useWorkerPoolCountsQuery，进页面请求数恒为 3；
       3. 删 useWorkerQueue.loadBoard + 模块级 workerHeld（唯一非 TanStack 数据源），
          同时删 activeProcessId provide（随 move 端点改造后无消费者）。

     2026-09-30 变更记录（自上而下按时间倒序）：
       - 2026-09-30：counts query 去 shelf_id params 维度（后端 counts 端点无
         shelf 维度）⇒ shelfId 不再必须在 useWorkerPoolCountsQuery 之前声明，
         2026-09-30 hotfix 第 1 轮加的 TDZ 防护随之退休；
       - 2026-09-29：提供 selectedIds / mutations 给 PendingBatchesPanel /
         PendingPoolsPanel 用（provide 注入 moveBatchToWorker / moveBatchToPool /
         shelfId）；
       - 2026-09-26：消费侧禁止解构 auth store（沿 CLAUDE.md）。
     2026-09-30 改造前历史：
       - 2026-08-26：阶段一，全部走 fixture；DnD 守卫已删。
       - 2026-09-14：useWorkerQueue 切真 v2。 -->
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
          <!-- 待下发 Tab：左栏 el-table 多选 + 右栏自产工序卡（PendingPoolCard
               零请求，徽标由 counts 透传）。 -->
          <el-splitter class="board-splitter">
            <el-splitter-panel size="40%" :min="320">
              <PendingBatchesPanel
                :batches="pendingDispatch.batches.value"
                :total="pendingDispatch.total.value"
                :is-loading="pendingDispatch.isLoading.value"
                :selected-ids="pendingDispatch.selectedIds"
                :set-selected-ids="pendingDispatch.setSelectedIds"
                :auto-dispatch-mutation="pendingDispatch.autoDispatchMutation"
              />
            </el-splitter-panel>
            <el-splitter-panel size="60%" :min="320">
              <PendingPoolsPanel
                :processes="inhouseProcessesForPanel"
                :selected-ids="pendingDispatch.selectedIds"
                :selected-count="pendingDispatch.selectedCount.value"
                :dispatch-mutation="pendingDispatch.dispatchMutation"
              />
            </el-splitter-panel>
          </el-splitter>
        </el-tab-pane>

        <el-tab-pane v-for="p in inhouseProcs" :key="p.id" :name="p.id" :lazy="true">
          <template #label>
            <span class="tab-label">
              <span class="tab-label__code">{{ p.code }}</span>
              <span class="tab-label__count">({{ poolCount(p.id) }})</span>
            </span>
          </template>
          <!-- 自产工序 Tab：WorkerPoolTab 自管 useWorkerPoolByProcessQuery，
               :lazy="true" 保证切到该 tab 才发请求。shelfId 由本组件 provide 注入
               给内嵌 WorkerColumn / PoolDrawer 消费，WorkerPoolTab 自身不需要。 -->
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
import { invalidateWorkerPoolByProcessAll } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { invalidateWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import { invalidateWorkerStateByWorkerAll } from '@/composables/queries/useWorkerStateByWorkerQuery';
import WorkerPoolTab from './components/WorkerPoolTab.vue';
import PendingBatchesPanel from './components/PendingBatchesPanel.vue';
import PendingPoolsPanel from './components/PendingPoolsPanel.vue';

const auth = useAuthStore();
// shelfId 通过 provide 注入给 WorkerColumn（其自管 useWorkerStateByWorkerQuery，
// 需要 shelfId 作为 queryKey 之一）与 PoolDrawer（WORKER→POOL 的 `to.shelf_id`）。
// 注意：2026-09-30 前它还被 useWorkerPoolCountsQuery 的 params 闭包读取，是
// TDZ hotfix 的根源；counts 端点去掉 shelf 维度后该依赖已消失。
const shelfId = computed(() => auth.activeShelfId ?? '');
const queue = useWorkerQueue();
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

// 2026-09-30：processes 走共享 useProcessesQuery（30s staleTime 去重缓存，与仓内
// 多处 caller 共享缓存身份），不再调 listProcesses + module-level ref。
const procsQuery = useProcessesQuery();
const inhouseProcs = computed(() =>
  procsQuery.data.value?.items.filter((p) => p.category === 'INHOUSE') ?? [],
);

// 2026-09-30：tab 标题 (N) 徽标 + 「待下发」工序卡徽标的**唯一数据源**
// （`GET /prod/pool/counts`，单请求跨所有货架 GROUP BY 聚合，eager 拉取）。
const countsQuery = useWorkerPoolCountsQuery();
function poolCount(pid: string): number | string {
  if (countsQuery.isLoading.value) return '…';
  const entry = countsQuery.data.value?.counts.find((c) => c.process_id === pid);
  return entry?.count ?? 0;
}

/** 2026-09-30：「待下发」Tab 工序卡 props —— 轻量元数据 + 聚合计数徽标。
 *  **不拉 per-process 详情**：改前每张卡自管 useWorkerPoolByProcessQuery，进页面
 *  即打 N 个 `GET /prod/pool/{pid}`（N = INHOUSE 工序数），与「切 tab 懒加载」
 *  的设计意图相反。现徽标直接复用上面已 eager 拉取的 counts。 */
const inhouseProcessesForPanel = computed(() =>
  inhouseProcs.value.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    count: poolCount(p.id),
  })),
);

const pendingDispatch = usePendingDispatch();
const { error, moveBatchToWorker, moveBatchToPool } = queue;

// 2026-09-30：loading 由 procsQuery.isLoading || countsQuery.isLoading 控制初始
// skeleton，不阻塞 tab 切换。（旧 queueLoading 随 loadBoard 一并删除。）
const loading = computed(() => procsQuery.isLoading.value || countsQuery.isLoading.value);

// 2026-09-29 review 第 1 轮修复（M1）：activeTab 默认 = __pending__（首屏即待下发 tab，
// 符合任务规约「待下发 Tab 在最前」）；URL ?tab=XXX 可覆盖（深链到具体工序），
// 覆盖优先级 > 默认。
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

// 2026-09-30：删 `activeProcessId` provide —— 它唯一的消费者 PoolDrawer 已不再需要
// （move 端点改造后撤回目标是「货架」而非「工序」，目标工序由后端从 batch 当前 step 自推）。

provide<typeof moveBatchToWorker>('moveBatchToWorker', moveBatchToWorker);
provide<typeof moveBatchToPool>('moveBatchToPool', moveBatchToPool);
provide<ComputedRef<string>>('shelfId', shelfId);

// 2026-09-30：workerHeld 的唯一消费者 WorkerColumn 已自管
// useWorkerStateByWorkerQuery，onMounted(loadBoard) 与 refreshBoard 注入一并删除。
// 本 watch 仍需保留：深链 ?tab=<某工序> 时，inhouseProcs 尚未从 procsQuery 解析完，
// 无法校验 tab 合法性 —— 解析后校正到第一个 INHOUSE 工序。
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

/** 2026-09-30：刷新 = 失效 pool 三域（counts / by-process / state）。
 *  下一帧 tab / WorkerColumn / PendingPoolCard 徽标重新拉数据。 */
async function onRefresh() {
  await invalidateWorkerPoolCountsQuery(qc);
  await invalidateWorkerPoolByProcessAll(qc);
  await invalidateWorkerStateByWorkerAll(qc);
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
