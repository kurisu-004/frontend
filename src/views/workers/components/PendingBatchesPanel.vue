<!-- 2026-09-29 卡片化：从 el-table 改为 flex-wrap 卡片网格（与其他 Tab 一致）；
     保留多选 + 拖拽 + 自动下发。字段补全：serial_no / L1客户 / note。
     2026-10-02：卡片渲染收敛到 BatchCard.vue（全看板唯一批次卡片），DTO 适配走
     poolItemToCard.pendingBatchToCard；拖拽从 HTML5 native drag 切到
     vue-draggable-plus，与工序池 / 工人列统一为同一套 Sortable 链路。本文件只持有
     工具条 / footer / 拖拽源配置。
     2026-10-02：源容器顺带承担「拖入高亮」的事件源 —— Sortable 的 _onMove 只从被
     拖起的容器（源）取 options.onMove，投放目标（工序卡）侧永不触发，故由本容器读
     evt.related.dataset.processId 上报，父级 WorkerQueueBoard 转成 PendingPoolsPanel
     的 hoveredProcessId。 -->
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
         工具条 / footer 是本容器的兄弟节点，天然不在拖拽列表内。
         data-pending-pool 是「本容器 = 待下发池」的契约标记：投放目标侧
         （PendingPoolCard.onDrop）据此做来源白名单，因为 Sortable 的 put: true
         布尔形态不做 group 名比对、任何 Sortable 来源都会被 onAdd 接受。 -->
    <div v-else ref="cardsRef" class="pending-cards" data-pending-pool="1">
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
import type { BatchCardModel } from '@/types/batchCard';
import { pendingBatchToCard } from '@/views/workers/composables/poolItemToCard';
import type { UsePendingDispatchReturn } from '@/views/workers/composables/usePendingDispatch';
import BatchCard from '@/components/BatchCard.vue';

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

/** 2026-10-02：拖拽悬停的工序 id（null = 未悬停在任何工序卡上）。
 *  payload 契约：Sortable 的 MoveEvent.related = 悬停到的**目标容器元素本身**
 *  （工序卡内 `draggable: '.never'` 匹配不到任何子元素 ⇒ Sortable 找不到落点元素，
 *  related 退化为容器本身），其 dataset.processId 即工序 id。
 *  事件名取 camelCase（与 BatchCard 的 toggleSelect 同形）；模板侧写
 *  `@hover-process`，编译产物同为 `onHoverProcess`，两端互通。 */
const emit = defineEmits<(e: 'hoverProcess', processId: string | null) => void>();

// 解构 props.selectedIds 时 .value 拿响应式 Set（与父级 composable.selectedIds 同源）
const selectedIdsValue = computed<Set<string>>(() => props.selectedIds.value);

/** 2026-10-02：待下发 DTO → 卡片 model（统一适配层，组件零 DTO 依赖）。 */
const cards = computed<BatchCardModel[]>(() => props.batches.map(pendingBatchToCard));

const cardsRef = ref<HTMLElement | null>(null);
/** 2026-10-02：传给 useLazyDraggable 的本地副本，**不是渲染源**（模板 v-for 走
 *  props.batches 派生的 cards）。它存在的唯一理由是让 vue-draggable-plus 往本实例注入
 *  源端内置 handler —— 三参重载（el + list + options）下库才会挂上内部 onAdd /
 *  onRemove / onEnd 等，其中内部 onRemove 的第一句
 *  `from.insertBefore(item, from.children[oldIndex])` 负责**把被拖节点放回源容器**。
 *  ⚠️ 不要「简化」成二参重载（不传 list）：源端就没有内置 handler，被拖节点会永久卡
 *  在目标工序卡里，而且它不在 vnode 树中，Vue 后续重渲染也清不掉。 */
const sortableCards = ref<BatchCardModel[]>([]);
watch(
  cards,
  (next) => {
    sortableCards.value = [...next];
  },
  { immediate: true },
);
// 2026-10-02：下发目标由 PendingPoolCard 上的 Sortable 容器接（**二参重载**，目标端
// 不注入内置 handler，避免把拖入的 DOM 节点塞进目标却不交给 Vue 管）。本容器
// put: false（不接收外部投放）、pull: true（只允许拖出去）、sort: false（池内不重排，
// 待下发列表的顺序由后端排定）。
// 用 useLazyDraggable 而非裸 useDraggable：本容器位于 v-if / v-else-if / v-else
// 分支内，挂载瞬间 ref 必为 null。
useLazyDraggable(cardsRef, sortableCards, {
  // put / pull 是 Sortable 的 group 成员（Options 顶层不接受这两个键），故用对象形态。
  group: { name: 'pending-batches', put: false, pull: true },
  sort: false,
  animation: 150,
  ghostClass: 'sortable-ghost',
  // 2026-10-02：拖入工序卡高亮。onMove 只挂在**源**（本容器）上才收得到 —— Sortable
  // 的 _onMove 读 `fromEl.options.onMove`。返回值 void 即可，只有返回 false 才阻止放置。
  onMove: (evt) => {
    const related = evt?.related;
    emit('hoverProcess', related?.dataset?.processId ?? null);
  },
  // 2026-10-02：拖拽开始即清零 —— 防御性复位。onStart 每次拖拽只触发一次、且必然先于
  // 本次拖拽的首次 onMove，所以它不针对任何具体残留场景；保留它只为覆盖「onEnd 尚未
  // 触发」的窗口（下一次拖拽开始时若上一次的高亮还挂着，立刻清掉），成本一次 emit。
  onStart: () => {
    emit('hoverProcess', null);
  },
  // 清高亮：end 只派发给源，且「落在工序卡上」与「拖拽中途取消」都会走到 ⇒ 不会残留。
  onEnd: () => {
    emit('hoverProcess', null);
  },
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
/* 2026-10-02：待下发池的拖拽反馈。src/styles/ 下没有全局 .sortable-ghost 规则，
   仓内各处都在自己的 scoped style 里 :deep 定义 —— 漏掉就等于拖起来毫无视觉反馈。
   半透明度对齐旧实现（原生 DnD 时代 .is-dragging { opacity: 0.4 }）。 */
:deep(.sortable-ghost) {
  opacity: 0.4;
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
