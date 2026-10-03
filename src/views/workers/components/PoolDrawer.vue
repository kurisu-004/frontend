<!-- 2026-08-26 重构：工序 pool 容器（vuedraggable target）。
     接收父级 provide 注入：moveBatchToPool / shelfId。

     @start 把候选池源信息（含 batch 真实 shelf_id）写到 dndSourceTracker；
     @add 时调 moveBatchToPool 撤回批次。
     2026-10-03：Sortable 走二参重载（不传 list），本容器退化为「纯投放目标」——
     DOM 搬位一律靠 move 的失效链重拉回来（成功走 onSuccess、失败走 onError、目标
     货架缺失的早退走包装内的显式失效，三条路都失效 pool 三域）。完整推导见
     useLazyDraggable 的文件头注释。

     2026-09-30：
     - moveBatchToPool 签名去掉 next_process_id（后端 `POST /prod/pool/move` 的
       `to` 是 MoveLocation tagged enum，POOL 分支只认 shelf_id；目标工序由 service
       从 batch 当前 step 自推）。
     - 删 activeProcessId 注入（随之废止 —— 撤回目标货架改用当前激活货架）。
     - 修 onDragStart 的历史 bug：旧代码在这里调 recordWorkerSource（试图记录
       「拖出 WorkerColumn 的 worker」），但本组件的 onStart 是**从池里拖出**，
       evt.from 是池容器（只有 data-process-id），fromWorkerId 恒 undefined ⇒
       死代码。现改为 recordPoolSource 记录 {processId, shelfId}。
     -->
<template>
  <div class="pool-drawer">
    <div v-if="pool" class="pool-section">
      <div class="section-header">
        <span class="process-code">{{ pool.process_code }}</span>
        <span class="process-name">{{ pool.process_name }}</span>
        <el-tag size="small" type="info">{{ pool.batches.length }}</el-tag>
      </div>
      <div ref="containerRef" class="section-body pool-cards" :data-process-id="pool.process_id">
        <!-- 2026-10-02：卡片渲染收敛到 BatchCard.vue，包装层删除。Sortable 容器的
             直接子元素必须**全是可拖项**（空态 div 是本容器的兄弟节点，不在其中）。
             data-shelf-id 经 BatchCard 的 fallthrough attrs 落到卡片根 div
             （BatchCard 是 inheritAttrs: false + v-bind="$attrs"）。 -->
        <BatchCard
          v-for="batch in pool.batches"
          :key="batch.batch_id"
          :batch="batch"
          :data-shelf-id="batch.shelf_id ?? ''"
        />
      </div>
    </div>
    <div v-else class="pool-empty">无工序数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { ComputedRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { MoveEvent } from 'sortablejs';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { ProcessPoolView } from '@/types/workerPool';
import {
  consumeWorkerSource,
  recordPoolSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import BatchCard from '@/components/BatchCard.vue';

// 2026-10-03：不接变量 —— 模板直接用 pool（script setup 模板自动解包 props），
// 脚本侧已无 props 读取（旧的 writablePoolBatches 镜像随二参重载一起删掉）。
defineProps<{
  pool: ProcessPoolView | null;
}>();

// 2026-08-27 fix：containerRef 在 <div v-if="pool"> 内，而父级 activePool 在
// WorkerQueueBoard 的 onMounted 里 await loadBoard() 解析前恒为 null，所以组件挂载
// 瞬间 containerRef 必为 null。原 composable 默认 immediate:true 会在 onMounted 里
// new Sortable(null) 抛错，且此后不再重绑（此前解构了 start 却从未调用，导致
// 「工人列 → 工序池」的回退拖拽永久失效）。改用 useLazyDraggable 延后绑定。
// 2026-10-03：走**二参重载**（不传 list）—— 本容器与 WorkerColumn 一样是纯投放目标：
// Sortable 搬进来的 DOM 一律由 query refetch 后的 Vue 渲染覆盖，库的内建 onAdd /
// onRemove 唯一的实际动作是把 `newDraggableIndex` / `oldDraggableIndex`（Sortable 报的
// **可拖项**下标）当 list 数组下标 splice 进去（`Dt(list, oldDraggableIndex)` 即
// `list.splice(oldDraggableIndex, 1)`），那只有在「list 与可拖子元素一一对应且同序」时
// 才成立。本容器的渲染源是 pool.batches、此前传入的 writablePoolBatches 只是它的镜像，
// 对不齐 ⇒ 内建 splice 写进一个 Vue 根本不读的数组。二参形态下这套 handler 整个不挂载。
// 同理不接 onUpdate：池内重排无人回滚（候选池顺序由后端排定，本就无重排语义），
// 改由下面的 onMove 守卫直接拒掉。
const containerRef = ref<HTMLElement | null>(null);
useLazyDraggable(containerRef, {
  group: 'work-orders',
  animation: 150,
  ghostClass: 'sortable-ghost',
  onMove: rejectInPlaceReorder,
  onStart: onDragStart,
  onAdd: onDragAdd,
});

/** 2026-10-03：拒掉池内原地重排（理由与 WorkerColumn 的同名守卫一致：不接 onUpdate
 *  时重排会留下无人回滚的幽灵 DOM 顺序；`sort: false` 是落点侧开关，本看板各容器
 *  共用同一个 group 字符串，落点侧关掉它会把跨容器投放一起打死）。
 *  onMove 只从**源**容器的 options 读取，所以从池里拖出的投放由这里负责，从工人列
 *  拖出的投放由 WorkerColumn 负责 —— 两处都要挂，缺一处就漏一种来源的池内重排。 */
function rejectInPlaceReorder(evt: MoveEvent): boolean {
  return evt.dragged.parentNode !== evt.to;
}

// 2026-09-30：page provide 必注入；moveBatchToPool 签名收窄为
// (batch_id, from_worker_id, to_shelf_id) —— 不再有 next_process_id（后端
// `POST /prod/pool/move` 的 `to` 是 `MoveLocation` tagged enum，POOL 分支只认
// shelf_id；目标工序由 service 从 batch 当前 step 自推，见 worker-pool.md:101-176）。
const moveBatchToPool =
  inject<(batch_id: string, from_worker_id: string, to_shelf_id: string) => Promise<boolean>>(
    'moveBatchToPool',
  )!;
// 2026-09-30：shelfId 仍是 WORKER→POOL 的 `to.shelf_id`（撤回目标货架）。
// 后端校验该货架必须映射到 batch 当前工序，否则 20507 BIZ_SHELF_PROCESS_NOT_MAPPED
// （HTTP 422）—— 用当前激活货架是唯一合理默认（用户视角「放回我正在看的货架」）。
const shelfId = inject<ComputedRef<string>>(
  'shelfId',
  computed(() => ''),
);

/** 2026-09-30：记录「候选池 → 工人」拖拽源。**必须带 batch 的真实 shelf_id**：
 *  `POST /prod/pool/move` 的 `from: {kind:'POOL', shelf_id}` 需与
 *  batch.current_holder_id 严格一致，否则后端 20122。而 `GET /prod/pool/{pid}` 是
 *  跨所有货架返回候选批次的，batch 货架未必等于当前激活货架 —— 所以从卡片自身的
 *  `data-shelf-id` dataset 读（模板上以 fallthrough attrs 传进 BatchCard），不能用
 *  shelfId.value。 */
function onDragStart(evt: DraggableStartEvent) {
  // dataset 里的 kebab-case 自动转 camelCase：data-process-id → processId。
  const batchId = evt.item.dataset.batchId;
  const fromProcessId = evt.from.dataset.processId;
  const fromShelfId = evt.item.dataset.shelfId;
  if (batchId && fromProcessId) {
    recordPoolSource(batchId, { processId: fromProcessId, shelfId: fromShelfId ?? '' });
  }
}

/** 2026-08-27 迁移：vue-draggable-plus @add 事件 payload = Sortable.js 原生。 */
async function onDragAdd(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  if (!batchId) return;
  const fromWorkerId = consumeWorkerSource(batchId);
  if (!fromWorkerId) return;
  // 撤回目标货架 = 当前激活货架。
  const toShelfId = shelfId.value;
  if (!toShelfId) {
    ElMessage.warning('请先选择目标货架');
    return;
  }
  await moveBatchToPool(batchId, fromWorkerId, toShelfId);
}
</script>

<style scoped>
/* 2026-10-02：需求「工序 tab 左侧的工序池显示高度固定为一个屏幕」的高度链落点 ——
   抽屉本身不再滚（overflow: hidden），只有卡片区 .pool-cards 内部滚动，
   .section-header（工序 code + name + 数量徽标）常驻可见。 */
.pool-drawer {
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pool-section {
  margin-bottom: 24px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  flex-shrink: 0;
}
.process-code {
  font-weight: 600;
  font-family: var(--el-font-family-monospace, monospace);
}
.process-name {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  flex: 1;
}
/* 2026-08-26：多列卡片布局用 flex + wrap。 */
.pool-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0;
  align-content: flex-start;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.pool-cards :deep(.batch-card) {
  flex: 0 0 200px;
}
.pool-empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  flex-shrink: 0;
}
</style>
