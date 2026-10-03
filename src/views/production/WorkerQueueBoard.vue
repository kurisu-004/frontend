<!-- 生产队列看板（路由 /production/worker-queue，menuCode worker_queue）。
     自 2026-09-30 起的结构：
       - 顶部 el-tabs（行上移，底边线视觉承接）
       - 首个固定 tab「待下发」(name = __pending__)：el-splitter 40/60 分栏
          （左 PendingBatchesPanel 待下发批次列表 / 右 PendingPoolsPanel 工序卡）
       - 后续每张 INHOUSE 工序一个 tab，body = <WorkerPoolTab :process-id="p.id" />，
         全部带 :lazy="true" ⇒ 切到该 tab 才 mount 才发 `GET /prod/pool/{pid}`
     tab 标题 `(N)` 徽标数据源 = useWorkerPoolCountsQuery（单请求跨货架聚合）。

     2026-10-04 「待下发」右栏纳入外协工序（详见文末变更记录）：
       - 右栏工序卡数据源由「只含 INHOUSE」放宽到「全部工序」，并在 props 上透传
         category，由 PendingPoolsPanel 客户端分两组渲染、中间一条分割线；
       - 顶部工序 tab 与深链校正 watch 仍只认自产工序，本次不动；
       - procsQuery 显式 limit=200，避免工序总数超默认 limit 时外协工序被截断。

     2026-10-02 卡片统一（详见文末变更记录）：
       - 原先待下发池与工序池 / 工人列分用的两张旧卡片合并为全看板唯一的 BatchCard，
         工序池 / 工人列 / 待下发池三处共用，DTO 差异收在
         views/production/composables/poolItemToCard.ts 适配层；
       - 全站拖拽统一 vue-draggable-plus（含「待下发 → 工序卡」这条下发链路，
         从原生 HTML5 DnD 改为 Sortable）；
       - 右侧工序卡与左侧批次卡同款 200×96 盒模型 + 工序色左边框 + flex 网格；
       - 左侧待下发池 / 工序 tab 的工序池改为「固定一屏 + 内部滚动」。

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
          <!-- 待下发 Tab：左栏 el-table 多选 + 右栏工序卡（PendingPoolCard
               零请求，徽标由 counts 透传；2026-10-04 起右栏含外协工序，
               自产在上、外协在下，中间一条分割线）。 -->
          <el-splitter class="board-splitter">
            <el-splitter-panel size="40%" :min="320">
              <PendingBatchesPanel
                :batches="pendingDispatch.batches.value"
                :total="pendingDispatch.total.value"
                :is-loading="pendingDispatch.isLoading.value"
                :selected-ids="pendingDispatch.selectedIds"
                :set-selected-ids="pendingDispatch.setSelectedIds"
                :auto-dispatch-mutation="pendingDispatch.autoDispatchMutation"
                @hover-process="hoveredProcessId = $event"
              />
            </el-splitter-panel>
            <el-splitter-panel size="60%" :min="320">
              <PendingPoolsPanel
                :processes="panelProcesses"
                :selected-ids="pendingDispatch.selectedIds"
                :dispatch-mutation="pendingDispatch.dispatchMutation"
                :hovered-process-id="hoveredProcessId"
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
               给内嵌 PoolDrawer 消费（WORKER→POOL 撤回目标货架），WorkerPoolTab
               与 WorkerColumn 自身都不需要。 -->
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
import { useWorkerQueue } from '@/views/production/composables/useWorkerQueue';
import { usePendingDispatch } from '@/views/production/composables/usePendingDispatch';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import { invalidateWorkerPoolByProcessAll } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { invalidateWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import { invalidateWorkerStateByWorkerAll } from '@/composables/queries/useWorkerStateByWorkerQuery';
import WorkerPoolTab from './components/WorkerPoolTab.vue';
import PendingBatchesPanel from './components/PendingBatchesPanel.vue';
import PendingPoolsPanel from './components/PendingPoolsPanel.vue';

const auth = useAuthStore();
// 2026-10-04：shelfId 现在**只服务 PoolDrawer 的 WORKER→POOL 撤回目标货架**；
// 工人列的 state query 已不依赖它（`useWorkerStateByWorkerQuery` 去掉 shelf 维度）。
//
// ⚠️ 该值取自 `auth.activeShelfId = boundShelves[0]`，而后端只给「SHELF_ACCOUNT +
// scope_type='shelf'」的角色行返 shelf_ids ⇒ 对 MANAGER / CLERK / INSPECTOR 恒为
// null ⇒ shelfId 恒 `''`。后果：「把批次撤回候选池」对这三类角色结构性不可用 ——
// PoolDrawer 落点校验会弹「请先选择目标货架」，用户无法完成撤回。
// 之所以不能像 state 端点那样把货架参数删掉：后端对 `to.shelf_id` 是**真实使用**的
// —— 目标货架必须命中 t_shelf_process 映射，否则 20507 / HTTP 422，货架语义无法从
// 请求里省掉。正解是补一个显式「当前货架」选择器，或一个
// `/shelves/for-return?next_process_id=` picker（下轮再做）。
const shelfId = computed(() => auth.activeShelfId ?? '');
const queue = useWorkerQueue();
const route = useRoute();
const router = useRouter();
const qc = useQueryClient();

// 2026-09-30：processes 走共享 useProcessesQuery（30s staleTime 去重缓存，与仓内
// 多处 caller 共享缓存身份），不再调 listProcesses + module-level ref。
// 2026-10-04 显式 limit=200：右栏「待下发」工序卡要含外协工序，而工序总数超 200
// 时仍会被静默截断（后端 clamp 上限 500，取 200 是在「全量够用」与响应体积之间
// 的折中）。仍是**一个**请求，「进页面请求数恒为 3」的不变式不变。
const procsQuery = useProcessesQuery({ limit: 200 });
const inhouseProcs = computed(
  () => procsQuery.data.value?.items.filter((p) => p.category === 'INHOUSE') ?? [],
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
 *  的设计意图相反。现徽标直接复用上面已 eager 拉取的 counts。
 *  2026-10-02：补 `color`（工序色，PendingPoolCard 用作左边框）。Process.color
 *  已在 useProcessesQuery 的返回里，零新增请求。
 *  2026-10-04：改遍历**全部**工序（不再只取 INHOUSE），并透传 `category`
 *  交给 PendingPoolsPanel 分组 —— 外协工序同样作为下发目标参与点击/拖入。
 *  顶部工序 tab 仍只含自产工序（`inhouseProcs`），本次只扩右栏这一片。 */
const panelProcesses = computed(() =>
  (procsQuery.data.value?.items ?? []).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    color: p.color ?? null,
    count: poolCount(p.id),
    category: p.category,
  })),
);

const pendingDispatch = usePendingDispatch();
const { error, moveBatchToWorker, moveBatchToPool, moveBatchBetweenWorkers } = queue;

/** 2026-10-02：拖拽悬停的工序 id（null = 未悬停在任何工序卡上）—— 工序卡
 *  `.is-dropping` 高亮的唯一状态源。
 *  Sortable 的 onMove 只派发给**源**（待下发批次列表），投放目标侧收不到 ⇒ 状态落在
 *  两个面板的共同父级，由源面板 emit 上报、逐级透传到 PendingPoolCard 的 dropping
 *  prop。放在本组件而不是 usePendingDispatch：它是纯视觉反馈，不属于「下发」域。 */
const hoveredProcessId = ref<string | null>(null);

// 2026-09-30：loading 由 procsQuery.isLoading || countsQuery.isLoading 控制初始
// skeleton，不阻塞 tab 切换。（旧 queueLoading 随 loadBoard 一并删除。）
const loading = computed(() => procsQuery.isLoading.value || countsQuery.isLoading.value);

// 2026-09-29：activeTab 默认 = __pending__（首屏即待下发 tab，符合任务规约「待下发 Tab
// 在最前」）；URL ?tab=XXX 可覆盖（深链到具体工序），覆盖优先级 > 默认。
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
// 2026-10-03 新增：WorkerColumn 落点消费（把 A 手中的批次拖到 B 手中 = WORKER→WORKER）。
provide<typeof moveBatchBetweenWorkers>('moveBatchBetweenWorkers', moveBatchBetweenWorkers);
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
  /* 2026-10-02：需求「待下发池与工序池显示高度固定为一个屏幕」的高度链起点。
     EP 2.14.6 的 .el-tabs 是 display:flex / .el-tabs--top 是 column / .el-tabs__content
     是 flex-grow:1 + overflow:hidden —— 只要本页 .worker-queue-board 把 .pool-tabs
     撑开，下游 el-splitter（height:100%）与 splitter-panel（无 CSS 规则，靠
     align-items:stretch 拿确定高度）就能逐级传递。 */
  flex: 1;
  min-height: 0;
}
/* .el-tabs__content 自带 padding:15px，min-height:0 让内部 el-tab-pane 可以收缩，
   否则 height:100% 会在内容盒上加 padding 溢出。 */
.pool-tabs :deep(.el-tabs__content) {
  min-height: 0;
}
.pool-tabs :deep(.el-tab-pane) {
  height: 100%;
}
.pool-tabs :deep(.el-tabs__nav-wrap)::after {
  background: transparent;
}
/* 2026-09-29：EP 内部结构升级时的兜底，避免 nav-wrap::after 失效时丢失分割线 */
.pool-tabs :deep(.el-tabs__header) {
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.board-splitter {
  /* 2026-10-02 记档：父级 .el-tab-pane 是块容器（EP 2.14.6 的 el-tabs.css 里没有
     .el-tab-pane 规则），故下面这两行 flex/min-height 实际不生效；撑满高度的是
     EP 自带的 `.el-splitter { height: 100% }`。留着只是历史惯性，不要以为高度靠它们。 */
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
