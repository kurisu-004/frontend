<!-- 2026-09-30 重构：每张工序投放卡抽到 PendingPoolCard.vue。本组件只负责
     「分组渲染 + 空态兜底」，drop / click 交互都下沉到 PendingPoolCard。
     保留 selectedIds / dispatchMutation 接线。

     2026-09-30 懒加载：processes 元素新增 `count` 字段（由 WorkerQueueBoard 从
     useWorkerPoolCountsQuery 透传），PendingPoolCard 据此渲染徽标而**不再自行请求**
     per-process 详情 —— 消除了「进页面即打 N 个 GET /prod/pool/{pid}」的 N+1。
     同期删冗余的 shelfId prop（下发货架由后端按 target_process_id 在
     t_shelf_process 解析，前端不传）。

     2026-10-02：processes 元素新增 `color`（工序色，透传给卡片的左边框）；布局由
     单列改 flex-wrap 网格，与左栏待下发池同款；删死 prop selectedCount（模板从未消费）。
     2026-10-02 增 `hoveredProcessId`：拖拽悬停高亮态的透传口，逐卡折算成
     PendingPoolCard 的 dropping。

     2026-10-04 新增：纳入外协工序（需求「右侧的工序卡片增加外协工序，但要用分割线
     上下分开」）。分组在客户端做 —— `category` 只出现在工序列表 DTO
     （`GET /api/v2/prod/processes`）上，pool / counts 等其它端点都不返，所以由父级
     透传，本面板不新增请求、不置灰、不禁用：外协卡与自产卡完全同款（可点击、可拖入，
     走同一个 dispatch 端点）。已知取舍：后端 `POST /api/v2/prod/batches/dispatch` 对
     `target_process_id` 有守卫 `20508 BIZ_SHELF_PROCESS_NOT_FOUND`（该工序在
     t_shelf_process 无 active 货架映射即拒），外协工序通常不配货架 ⇒ 这类下发失败
     由 `usePendingDispatch.dispatchMutation` 的 onError 弹 ElMessage.error 呈现，
     前端不额外拦截。布局相应由「面板级 flex-wrap 网格」改为「纵向滚动列 + 组内
     flex-wrap」，让分割线能横贯整幅宽度；按需求不加任何文字标题。 -->
<template>
  <div class="pending-pools-panel">
    <div v-if="isEmpty" class="empty">暂无可下发工序</div>
    <div class="pool-group">
      <PendingPoolCard
        v-for="p in inhouseProcesses"
        :key="p.id"
        :process="p"
        :count="p.count"
        :selected-ids="selectedIds"
        :dispatch-mutation="dispatchMutation"
        :dropping="p.id === hoveredProcessId"
      />
    </div>
    <div v-if="showDivider" class="pool-divider" />
    <div class="pool-group">
      <PendingPoolCard
        v-for="p in outsourceProcesses"
        :key="p.id"
        :process="p"
        :count="p.count"
        :selected-ids="selectedIds"
        :dispatch-mutation="dispatchMutation"
        :dropping="p.id === hoveredProcessId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ProcessCategory } from '@/types/process';
import type { UsePendingDispatchReturn } from '@/views/production/composables/usePendingDispatch';
import PendingPoolCard from './PendingPoolCard.vue';

const props = defineProps<{
  /** 工序元数据列表（来自 useProcessesQuery.items，含自产与外协）。每项带
   *  `count`（来自 useWorkerPoolCountsQuery 的 counts[].count，加载中为占位 '…'）、
   *  `color`（工序色，用于卡片左边框）与 `category`（分组判据）。 */
  processes: Array<{
    id: string;
    code: string;
    name: string;
    color: string | null | undefined;
    count: number | string;
    category: ProcessCategory;
  }>;
  /** 多选已选集合（响应式 Ref，父级 composable 持有），透传给 PendingPoolCard。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  /** 下发 mutation 透传给 PendingPoolCard。 */
  dispatchMutation: UsePendingDispatchReturn['dispatchMutation'];
  /** 2026-10-02：当前被拖拽悬停的工序 id（父级 WorkerQueueBoard 持有，源面板
   *  PendingBatchesPanel 的 onMove 上报）。命中该 id 的工序卡渲染 .is-dropping 高亮，
   *  null = 无悬停目标、全部不亮。 */
  hoveredProcessId?: string | null;
}>();

/** 2026-10-04：按 category 分两组，filter 保序 ⇒ 两组各自维持父级传入的相对顺序。 */
function byCategory(category: ProcessCategory) {
  return computed(() => props.processes.filter((p) => p.category === category));
}
const inhouseProcesses = byCategory('INHOUSE');
const outsourceProcesses = byCategory('OUTSOURCE');

/** 分割线只在两组都非空时画：只有一组时，一条线会把内容无意义地劈成两半。 */
const showDivider = computed(
  () => inhouseProcesses.value.length > 0 && outsourceProcesses.value.length > 0,
);
/** 空态只在两组都为空时出现：只有一组为空不构成「无可下发工序」。 */
const isEmpty = computed(() => props.processes.length === 0);
</script>

<style scoped>
/* 2026-10-04：flex-wrap 网格 → 纵向滚动列 + 组内 flex-wrap，让 .pool-divider
   能横贯整幅宽度。面板本身不设 gap：卡片的 8px 间距由 .pool-group 自己带，两组之间
   的纵向节奏由 .pool-divider 的上下 margin 唯一决定。overflow-y 留在面板上，
   全面板只有这一层滚动容器。 */
.pending-pools-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow-y: auto;
}
/* 组内沿用 200px 卡片 + 8px gap 的网格。 */
.pool-group {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
}
/* 分割线：与 PendingBatchesPanel .footer 同款，用 EP 的 border 变量而非硬编码色。 */
.pool-divider {
  flex-shrink: 0;
  margin: 12px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}
.pending-pools-panel :deep(.pool-card) {
  flex: 0 0 200px;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
