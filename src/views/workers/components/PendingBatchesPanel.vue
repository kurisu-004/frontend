<!-- 2026-09-29 卡片化：从 el-table 改为 flex-wrap 卡片网格（与其他 Tab 一致）；
     保留多选 + 拖拽 + 自动下发。字段补全：serial_no / L1客户 / note。
     2026-10-02：卡片渲染收敛到 BatchCard.vue（全看板唯一批次卡片），DTO 适配走
     poolItemToCard.pendingBatchToCard；拖拽从 HTML5 native drag 切到
     vue-draggable-plus，与工序池 / 工人列统一为同一套 Sortable 链路。本文件只持有
     工具条 / footer / 拖拽源配置。 -->
<template>
  <div class="pending-batches-panel">
    <div class="toolbar">
      <el-checkbox
        :model-value="isAllSelected"
        :indeterminate="isIndeterminate"
        @change="onToggleAll"
      >
        全选
      </el-checkbox>
      <span class="selected-hint">已选 {{ selectedIdsValue.size }} 件</span>
      <el-button
        type="primary"
        size="small"
        :loading="autoDispatchMutation.isPending.value"
        :disabled="selectedIdsValue.size === 0"
        @click="onAutoDispatch"
      >
        自动下发
      </el-button>
    </div>

    <div v-if="isLoading && batches.length === 0" class="loading-state">
      <el-skeleton :rows="5" animated />
    </div>

    <div v-else-if="batches.length === 0" class="empty-state">
      <el-empty description="暂无待下发批次" :image-size="60" />
    </div>

    <!-- 2026-10-02：Sortable 拖拽源。直接子元素**只能**是 v-for 出来的 BatchCard
         （el-tooltip 不产生包裹元素，BatchCard 根 div 就是直接子节点）—— 混入
         header / 空态会让 oldIndex ≠ oldDraggableIndex，污染后续所有事件。
         工具条 / footer 是本容器的兄弟节点，天然不在拖拽列表内。 -->
    <div v-else ref="cardsRef" class="pending-cards">
      <BatchCard
        v-for="card in cards"
        :key="card.batch_id"
        :batch="card"
        :selectable="true"
        :selected="selectedIdsValue.has(card.batch_id)"
        @toggle-select="onCardToggleSelect(card.batch_id)"
      />
    </div>

    <div class="footer">
      <span class="total-hint">总计 {{ total }} 件待下发</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';
import type { BatchCardModel } from '@/types/workerPool';
import { pendingBatchToCard } from '@/views/workers/composables/poolItemToCard';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';
import BatchCard from './BatchCard.vue';

interface Props {
  batches: PendingBatchItemDto[];
  total: number;
  isLoading: boolean;
  /** Ref<Set<string>> —— 多选已选集合（响应式，父级 composable 持有）。 */
  selectedIds: UsePendingDispatchReturn['selectedIds'];
  setSelectedIds: (ids: string[]) => void;
  autoDispatchMutation: UsePendingDispatchReturn['autoDispatchMutation'];
}

const props = defineProps<Props>();
// 解构 props.selectedIds 时 .value 拿响应式 Set（与父级 composable.selectedIds 同源）
const selectedIdsValue = computed<Set<string>>(() => props.selectedIds.value);

/** 2026-10-02：待下发 DTO → 卡片 model（统一适配层，组件零 DTO 依赖）。 */
const cards = computed<BatchCardModel[]>(() => props.batches.map(pendingBatchToCard));

const cardsRef = ref<HTMLElement | null>(null);
// 2026-10-02：Sortable 会 splice 这个数组，必须用本地可写副本（props.batches 来自
// TanStack query，只读）。拖拽跨容器落下时 Sortable 的内置 onRemove 会**乐观地**把
// 卡片从本列表移除，失败回滚由 usePendingDispatch 的 dispatchMutation.onError
// 重拉待下发列表承担。
const sortableCards = ref<BatchCardModel[]>([]);
watch(
  cards,
  (next) => {
    sortableCards.value = [...next];
  },
  { immediate: true },
);
// 2026-10-02：下发目标改由 PendingPoolCard 上的 Sortable 容器接（vue-draggable-plus
// 二参重载）。故本容器 put: false（不接收外部投放）、pull: true（只允许拖出去）、
// sort: false（池内不重排，待下发列表的顺序由后端排定）。
// 用 useLazyDraggable 而非裸 useDraggable：本容器位于 v-if / v-else-if / v-else
// 分支内，挂载瞬间 ref 必为 null。
useLazyDraggable(cardsRef, sortableCards, {
  // put / pull 是 Sortable 的 group 成员（Options 顶层不接受这两个键），故用对象形态。
  group: { name: 'pending-batches', put: false, pull: true },
  sort: false,
  animation: 150,
  ghostClass: 'sortable-ghost',
});

const isAllSelected = computed(() => {
  if (props.batches.length === 0) return false;
  return props.batches.every((b) => selectedIdsValue.value.has(b.batch_id));
});
const isIndeterminate = computed(() => {
  if (props.batches.length === 0) return false;
  const selectedCount = props.batches.filter((b) => selectedIdsValue.value.has(b.batch_id)).length;
  return selectedCount > 0 && selectedCount < props.batches.length;
});

// el-checkbox @change 给的是 CheckboxValueType（boolean | string | number），本组件只
// 处理 boolean 分支（其它分支视作 false）。
function onToggleAll(checked: unknown) {
  const isChecked = checked === true || checked === 'true';
  if (isChecked) {
    props.setSelectedIds(props.batches.map((r) => r.batch_id));
  } else {
    props.setSelectedIds([]);
  }
}

/** 2026-10-02：BatchCard 的 toggle-select 事件不带 payload（多张卡共用同一个监听器，
 *  靠模板侧闭包把 batch_id 绑进去）。 */
const onCardToggleSelect = (batchId: string) => {
  const next = new Set(selectedIdsValue.value);
  if (next.has(batchId)) next.delete(batchId);
  else next.add(batchId);
  props.setSelectedIds(Array.from(next));
};

function onAutoDispatch() {
  const ids = Array.from(selectedIdsValue.value);
  if (ids.length === 0) return;
  props.autoDispatchMutation.mutate({ batchIds: ids });
}
</script>

<style scoped>
.pending-batches-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  flex-shrink: 0;
}
.selected-hint {
  flex: 1;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.loading-state {
  flex: 1;
  padding: 24px;
}
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 2026-10-02：flex: 1 + min-height: 0 打通「固定一屏、内部滚动」的高度链 ——
   旧写法 max-height: calc(100% - 100px) 是魔法数，且对 auto 高度的父级解析为
   none，滚动条从未生效。 */
.pending-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0;
  align-content: flex-start;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* BatchCard 自身固定 200px 宽，此处只锁死不伸缩，避免拉伸破坏网格对齐。 */
.pending-cards :deep(.batch-card) {
  flex: 0 0 200px;
}
.footer {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
  text-align: right;
  flex-shrink: 0;
}
.total-hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
