<!-- 2026-09-30 重构：工人列自管 useWorkerStateByWorkerQuery（数据层 TanStack Query 化）。
     原先 `batches` prop 由父级 useWorkerQueue 聚合后传入；本 commit 起 WorkerColumn 内部
     自管 query（30s staleTime 去重缓存 + 写操作 invalidate），同 workerId + shelfId 跨
     tab 共享 cache identity。
     skeleton / empty 兜底：isLoading 时 max_held / current_held 占位「…」，
     error 时 el-empty description="加载失败"。

     2026-09-30：拖拽链路对接后端 `POST /prod/pool/move`（取代 assign/remove 两端点）。
     - onStart 记 worker 源（PoolDrawer @add 消费）；onAdd 记/取候选池源时改为读
       `consumePoolSource` 返回的 { processId, shelfId }，其中 **shelfId 必须是
       batch 真实所在货架**（不能拿当前激活货架凑，候选池跨货架 → 后端 20122）。
     - moveBatchToWorker 去掉 process_id 形参（后端自推目标工序）。 -->
<template>
  <el-card class="worker-column" shadow="never">
    <template #header>
      <div class="col-header">
        <div class="worker-info">
          <el-avatar :size="32" class="avatar">{{ worker.name.charAt(0) }}</el-avatar>
          <div>
            <div class="name">{{ worker.name }}</div>
            <div class="badge">{{ worker.badge_code }} · {{ worker.work_type_code }}</div>
          </div>
        </div>
        <el-tag v-if="!worker.is_online" type="info" size="small">离线</el-tag>
      </div>
      <el-progress
        :percentage="capacityPercent"
        :format="() => `${currentHeldDisplay}/${maxHeldDisplay}`"
        :status="capacityStatus"
      />
    </template>
    <div ref="containerRef" class="col-body" :data-worker-id="worker.id">
      <div v-if="stateQuery.isLoading.value" class="loading-state">
        <el-skeleton :rows="3" animated />
      </div>
      <div v-else-if="stateQuery.error.value" class="error-state">
        <el-empty description="加载失败" :image-size="60" />
      </div>
      <template v-else>
        <div v-for="batch in heldBatches" :key="batch.batch_id" class="col-body-item">
          <WorkOrderCard :batch="batch" />
        </div>
        <el-empty v-if="heldBatches.length === 0" description="暂无持有工单" :image-size="60" />
      </template>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { ElMessage } from 'element-plus';
import { useDraggable } from 'vue-draggable-plus';
import type { Worker, WorkOrderCard as Card } from '@/types/workerPool';
import { useWorkerStateByWorkerQuery } from '@/composables/queries/useWorkerStateByWorkerQuery';
import { heldToCard } from '@/views/workers/composables/poolItemToCard';
import {
  consumePoolSource,
  recordWorkerSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import WorkOrderCard from './WorkOrderCard.vue';

// 2026-09-30 重构：删除 `batches: Card[]` prop —— WorkerColumn 自管 useWorkerStateByWorkerQuery
// 拉取 held_batches；保留 worker prop。
const props = defineProps<{
  worker: Worker;
}>();

// 2026-09-30：shelfId 通过 inject('shelfId') 从父级 WorkerQueueBoard 拿
// （provide 已沿用 2026-08-26 既有约定）。WorkerColumn 自管 useWorkerStateByWorkerQuery
// 走 qk.workerPoolStateByWorker(worker.id, shelfId) 缓存键，跨 tab 共享。
// 2026-09-30 review 第 1 轮修复（m3）：用 computed default 替代 `!` 非空断言 ——
// 未注入时拿 computed(() => '')，后续 query.enabled 闸门会短路（useWorkerStateByWorkerQuery
// 要求非空），workerState 拉不到自然走 error/empty 分支（与「无 active shelfId」语义对齐）。
const shelfId = inject<ComputedRef<string>>('shelfId', computed(() => ''));

const stateQuery = useWorkerStateByWorkerQuery(
  () => props.worker.id,
  () => shelfId.value,
);

// 2026-09-30 review 第 1 轮修复（m8）：useWorkerStateByWorkerQuery error → ElMessage 错误
// 桥接（沿 CLAUDE.md #9 usePartsListQuery.ts:334-336 范本）。模板 v-else-if「加载失败」
// el-empty 只是 UI 占位，toast 必须走 ElMessage.error 才让用户看到。
watch(
  () => stateQuery.error.value,
  (e) => {
    if (e) ElMessage.error(e.message ?? '加载工人状态失败');
  },
);

/** 2026-09-30：把 useWorkerStateByWorkerQuery.held_batches 适配成 WorkOrderCard[]。
 *  heldToCard 函数从 useWorkerQueue.ts 拆到 views/workers/composables/poolItemToCard.ts，
 * 共享给 WorkerPoolTab / PendingPoolCard / WorkerColumn（同 held 数据流）。 */
const heldBatches = computed<Card[]>(() => {
  const list = stateQuery.data.value?.held_batches ?? [];
  return list.map(heldToCard);
});

/** 2026-09-30：max_held / current_held 显示 —— 加载中占位「…」，resolved 后真实数字。 */
const maxHeldDisplay = computed<string>(() => {
  if (stateQuery.isLoading.value) return '…';
  return String(stateQuery.data.value?.max_held ?? 0);
});
const currentHeldDisplay = computed<string>(() => {
  if (stateQuery.isLoading.value) return '…';
  return String(stateQuery.data.value?.current_held ?? 0);
});

const capacityPercent = computed(() => {
  const maxHeld = stateQuery.data.value?.max_held ?? 0;
  if (maxHeld === 0) return 0;
  const currentHeld = stateQuery.data.value?.current_held ?? 0;
  return Math.round((currentHeld / maxHeld) * 100);
});

// 注：el-progress 的 status 只接受 '' | 'success' | 'warning' | 'exception'，
// 没有 'primary'。中段（>=70%）走空串，让 EP 走默认主色（蓝）。
const capacityStatus = computed<'success' | 'warning' | ''>(() => {
  const remaining = stateQuery.data.value?.capacity_remaining ?? 0;
  if (remaining === 0) return 'warning';
  if (capacityPercent.value >= 70) return '';
  return 'success';
});

// 2026-08-27 fix：useDraggable 内部 splice 触发 Vue readonly warn / 静默失败。包本地 ref + watch。
// 2026-09-13 PR-2：vue/no-setup-props-destructure 禁止顶层读 props.batches（已删 props.batches）；
// 此处仅保留 col-body 拖拽目标，不再注入具体可拖拽数据列表（用户拖出 worker-held 的 batch 后由
// onDragStart 记录源）。
const writableBatches = ref<Card[]>([]);
watch(
  heldBatches,
  (next) => {
    writableBatches.value = [...next];
  },
  { immediate: true },
);
const containerRef = ref<HTMLElement | null>(null);
useDraggable(containerRef, writableBatches, {
  group: 'work-orders',
  animation: 150,
  ghostClass: 'sortable-ghost',
  onStart: onDragStart,
  onAdd: onDragAdd,
});

// 2026-09-30：moveBatchToWorker 签名收窄为 (batch_id, to_worker_id, from_shelf_id)
// —— 不再有 process_id。后端把 `admin/worker-pool/assign` 合并进了通用移动端点
// `POST /prod/pool/move`，入参是 `MoveRequest { batch_id, from, to, note? }`，
// 目标工序由 service 从 `batch.current_process_step.process_id` 自推
// （worker-pool.md:146-147）。inject 缺省用 noop 兜底（provider 缺失时不炸，
// 与本文件既有 shelfId 注入风格一致）。
const moveBatchToWorker =
  inject<
    (batch_id: string, to_worker_id: string, from_shelf_id: string) => Promise<boolean>
  >('moveBatchToWorker', async () => false);

/** 2026-08-26：记录源 worker ID（拖出本工人列的 worker.id），供 PoolDrawer 的
 *  @add 构造 `from: {kind:'WORKER', worker_id}`。 */
function onDragStart(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  const fromWorkerId = evt.from.dataset.workerId;
  if (batchId && fromWorkerId) recordWorkerSource(batchId, fromWorkerId);
}

/** 2026-08-27 迁移：vue-draggable-plus @add 事件 payload = Sortable.js 原生，
 *  item 为被拖入的 HTMLElement；通过 WorkOrderCard 上的 :data-batch-id 反查 batch_id。 */
async function onDragAdd(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  if (!batchId) return;
  const src = consumePoolSource(batchId);
  if (!src) return;
  // 2026-09-30：`from.shelf_id` 取候选池卡片自带的**真实货架**（src.shelfId，来自
  // PoolDrawer 渲染的 :data-shelf-id），不是当前激活货架 —— 候选池跨所有货架，
  // 两者可能不一致；填错后端返 20122 BIZ_BATCH_LOCATION_MISMATCH（HTTP 409）。
  // src.processId 仅用于日志 / 定位，不再作为请求参数。
  await moveBatchToWorker(batchId, props.worker.id, src.shelfId);
}
</script>

<style scoped>
.worker-column {
  width: 280px;
  flex-shrink: 0;
}
.col-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}
.worker-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.avatar {
  background-color: var(--el-color-primary);
  color: white;
}
.name {
  font-weight: 600;
  font-size: 14px;
}
.badge {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.col-body {
  min-height: 100px;
  max-height: 70vh;
  overflow-y: auto;
}
.loading-state,
.error-state {
  padding: 8px;
}
</style>
