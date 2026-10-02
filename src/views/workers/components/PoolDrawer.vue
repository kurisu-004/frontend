<!-- 2026-08-26 重构：工序 pool 容器（vuedraggable target）。
     接收父级 provide 注入：moveBatchToPool / shelfId。

     @start 把候选池源信息（含 batch 真实 shelf_id）写到 dndSourceTracker；
     @add 时调 moveBatchToPool 撤回批次。

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
        <div v-for="batch in pool.batches" :key="batch.batch_id" class="pool-cards-item">
          <WorkOrderCard :batch="batch" />
        </div>
      </div>
    </div>
    <div v-else class="pool-empty">无工序数据</div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { ElMessage } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { ProcessPoolView, BatchCardModel as Card } from '@/types/workerPool';
import {
  consumeWorkerSource,
  recordPoolSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import WorkOrderCard from './WorkOrderCard.vue';

const props = defineProps<{
  pool: ProcessPoolView | null;
}>();

// 同 WorkerColumn 的 fix 模式：props.pool.batches readonly，本地 ref + watch。
// 2026-09-13 PR-2：vue/no-setup-props-destructure 禁止顶层读 props.pool，
// 包一层 IIFE 把读取放进函数体。
const writablePoolBatches = ref<Card[]>((() => (props.pool ? [...props.pool.batches] : []))());
watch(
  () => props.pool?.batches,
  (next) => {
    writablePoolBatches.value = next ? [...next] : [];
  },
  { deep: true, immediate: false },
);
// 2026-08-27 fix：containerRef 在 <div v-if="pool"> 内，而父级 activePool 在
// WorkerQueueBoard 的 onMounted 里 await loadBoard() 解析前恒为 null，所以组件挂载
// 瞬间 containerRef 必为 null。原 composable 默认 immediate:true 会在 onMounted 里
// new Sortable(null) 抛错，且此后不再重绑（此前解构了 start 却从未调用，导致
// 「工人列 → 工序池」的回退拖拽永久失效）。改用 useLazyDraggable 延后绑定。
const containerRef = ref<HTMLElement | null>(null);
useLazyDraggable(containerRef, writablePoolBatches, {
  group: 'work-orders',
  animation: 150,
  ghostClass: 'sortable-ghost',
  onStart: onDragStart,
  onAdd: onDragAdd,
});

// 2026-09-30：page provide 必注入；moveBatchToPool 签名收窄为
// (batch_id, from_worker_id, to_shelf_id) —— 不再有 next_process_id（后端
// `POST /prod/pool/move` 的 `to` 是 `MoveLocation` tagged enum，POOL 分支只认
// shelf_id；目标工序由 service 从 batch 当前 step 自推，见 worker-pool.md:101-176）。
const moveBatchToPool =
  inject<
    (batch_id: string, from_worker_id: string, to_shelf_id: string) => Promise<boolean>
  >('moveBatchToPool')!;
// 2026-09-30：shelfId 仍是 WORKER→POOL 的 `to.shelf_id`（撤回目标货架）。
// 后端校验该货架必须映射到 batch 当前工序，否则 20507 BIZ_SHELF_PROCESS_NOT_MAPPED
// （HTTP 422）—— 用当前激活货架是唯一合理默认（用户视角「放回我正在看的货架」）。
const shelfId = inject<ComputedRef<string>>('shelfId', computed(() => ''));

/** 2026-09-30：记录「候选池 → 工人」拖拽源。**必须带 batch 的真实 shelf_id**：
 *  `POST /prod/pool/move` 的 `from: {kind:'POOL', shelf_id}` 需与
 *  batch.current_holder_id 严格一致，否则后端 20122。而 `GET /prod/pool/{pid}` 是
 *  跨所有货架返回候选批次的，batch 货架未必等于当前激活货架 —— 所以从卡片自身的
 *  `data-shelf-id` dataset 读（WorkOrderCard.vue 渲染），不能用 shelfId.value。 */
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
.pool-drawer {
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  overflow-y: auto;
}
.pool-section {
  margin-bottom: 24px;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
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
  min-height: 60px;
}
.pool-empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
