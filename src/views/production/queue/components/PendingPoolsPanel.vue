<!-- 「待下发」Tab 右栏的工序卡集合（每张卡是 PendingPoolCard）。本组件只负责
     「按 category 分组渲染 + 空态兜底」，drop / click 交互都在 PendingPoolCard 内。
     保留 selectedIds / dispatchMutation 接线。

     零网络请求：`processes` 元素由父级 QueueBoard 组装 —— 工序元数据来自共享的
     useProcessesQuery（一次请求，含自产与外协），`count` / `color` 来自队列快照
     （`GET /prod/queue/snapshot`，单请求跨所有货架聚合）。per-process 详情只有切到
     对应工序 tab 时才拉。

     纳入外协工序（需求「右侧的工序卡片增加外协工序，但要用分割线上下分开」）。分组
     在客户端做 —— `category` 只出现在工序列表 DTO（`GET /api/v2/prod/processes`）上，
     本面板不新增请求、不置灰、不禁用：外协卡与自产卡完全同款（可点击、可拖入，走
     同一个 dispatch 端点）。已知取舍：后端 dispatch 对 `target_process_id` 有守卫
     `20508 BIZ_SHELF_PROCESS_NOT_FOUND`（该工序在 t_shelf_process 无 active 货架映射
     即拒），外协工序通常不配货架 ⇒ 这类下发失败由 `useQueueDispatch.dispatchMutation`
     的 onError 弹 ElMessage.error 呈现，前端不额外拦截。布局是「纵向滚动列 + 组内
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
import type { UseQueueDispatchReturn } from '@/views/production/queue/composables/useQueueDispatch';
import PendingPoolCard from './PendingPoolCard.vue';

const props = defineProps<{
  /** 工序元数据列表（来自 useProcessesQuery.items，含自产与外协）。每项带
   *  `count`（队列快照的 processes[].pool_count；零候选的工序快照里没有、父级填 0）、
   *  `color`（工序色，卡片左边框）与 `category`（分组判据）。 */
  processes: Array<{
    id: string;
    code: string;
    name: string;
    color: string | null | undefined;
    count: number | string;
    category: ProcessCategory;
  }>;
  /** 多选已选集合（响应式 Ref，父级 composable 持有），透传给 PendingPoolCard。 */
  selectedIds: UseQueueDispatchReturn['selectedIds'];
  /** 下发 mutation 透传给 PendingPoolCard。 */
  dispatchMutation: UseQueueDispatchReturn['dispatchMutation'];
  /** 当前被拖拽悬停的工序 id（父级 QueueBoard 持有，源面板
   *  PendingBatchesPanel 的 onMove 上报）。命中该 id 的工序卡渲染 .is-dropping 高亮，
   *  null = 无悬停目标、全部不亮。 */
  hoveredProcessId?: string | null;
}>();

/** 按 category 分两组，filter 保序 ⇒ 两组各自维持父级传入的相对顺序。 */
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
/* flex-wrap 网格 → 纵向滚动列 + 组内 flex-wrap，让 .pool-divider
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
/* 组内沿用 200px 卡片 + 8px gap 的网格。flex-shrink: 0：面板是纵向滚动列，组一旦被压扁，
   200px 固定高的卡片就会互相重叠。当前靠 flex item 的 content-based 最小尺寸兜住不收缩，
   显式写死是防它哪天不成立。 */
.pool-group {
  flex-shrink: 0;
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
