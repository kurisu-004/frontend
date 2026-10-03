<!-- 2026-09-30 重构：工人列自管 useWorkerStateByWorkerQuery（数据层 TanStack Query 化）。
     原先 `batches` prop 由父级 useWorkerQueue 聚合后传入；本 commit 起 WorkerColumn 内部
     自管 query（30s staleTime 去重缓存 + 写操作 invalidate），同 workerId + shelfId 跨
     tab 共享 cache identity。
     skeleton / empty 兜底：isLoading 时 max_held / current_held 占位「…」，
     error 时 el-empty description="加载失败"。

     2026-09-30：拖拽链路对接后端 `POST /prod/pool/move`（取代 assign/remove 两端点）。
     - onStart 记 worker 源（落点的 @add 消费）；onAdd 记/取候选池源时改为读
       `consumePoolSource` 返回的 { processId, shelfId }，其中 **shelfId 必须是
       batch 真实所在货架**（不能拿当前激活货架凑，候选池跨货架 → 后端 20122）。
     - moveBatchToWorker 去掉 process_id 形参（后端自推目标工序）。

     2026-10-03 四项修复：
     1. onDragAdd 拆两段：候选池源走 POOL→WORKER，工人源走 **WORKER→WORKER**
        （此前只有前者 ⇒ 批次移到另一名工人手中时前端零实现，Sortable 已把 DOM 搬进
        目标列却不发请求不失效，目标列凭空多一张卡、源列永久少一张）。从自己这一列
        拖回自己不构成移动，早退不发请求。
     2. Sortable 走二参重载（不传 list）：库的内建 onAdd/onRemove 假定「传进来的
        list 就是渲染源」，而本容器的渲染源是 query 派生的 heldBatches —— 传任何
        list 副本都只是往一个没人看的数组里 splice。详见 useLazyDraggable 的文件头
        注释（那里记录了「纯投放信号源」这条不变量的完整推导）。
     3. Sortable 容器只包卡片：loading / error / 空态三种状态移出容器（Sortable 容
        器的直接子元素必须全是可拖项）。
     4. .col-body 补卡片网格（flex-wrap + gap 8px + :deep(.batch-card) 锁 200px），
        与工序池 / 待下发池同一条网格基线。 -->
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
    <div class="col-content">
      <div v-if="stateQuery.isLoading.value" class="loading-state">
        <el-skeleton :rows="3" animated />
      </div>
      <div v-else-if="stateQuery.error.value" class="error-state">
        <el-empty description="加载失败" :image-size="60" />
      </div>
      <el-empty
        v-else-if="heldBatches.length === 0"
        class="col-empty"
        description="暂无持有工单"
        :image-size="60"
      />
      <!-- 2026-10-03：Sortable 投放目标容器的直接子元素**只有卡片**。
           loading / error / 空态三种状态一律移出容器（此前混在容器里），它们不是
           可拖项，留在里面会让 Sortable 的 DOM 下标与「可拖项下标」错位。 -->
      <div v-else ref="containerRef" class="col-body" :data-worker-id="worker.id">
        <BatchCard v-for="batch in heldBatches" :key="batch.batch_id" :batch="batch" />
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { ElMessage } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { Worker } from '@/types/workerPool';
import type { BatchCardModel as Card } from '@/types/batchCard';
import { useWorkerStateByWorkerQuery } from '@/composables/queries/useWorkerStateByWorkerQuery';
import { heldToCard } from '@/views/workers/composables/poolItemToCard';
import {
  consumePoolSource,
  consumeWorkerSource,
  recordWorkerSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import BatchCard from '@/components/BatchCard.vue';

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
const shelfId = inject<ComputedRef<string>>(
  'shelfId',
  computed(() => ''),
);

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

/** 2026-10-02：把 useWorkerStateByWorkerQuery.held_batches 适配成 BatchCardModel[]。
 *  heldToCard 函数从 useWorkerQueue.ts 拆到 views/workers/composables/poolItemToCard.ts，
 *  共享给 WorkerPoolTab / PoolDrawer / WorkerColumn（同 held 数据流）。 */
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

// 2026-10-03：Sortable 用**二参重载**（不传 list）—— 本容器是纯投放目标，DOM
// 一律由 query refetch 后的 Vue 渲染覆盖，库的内建 onAdd / onRemove（它们会把被拖
// 节点按 list 数组 splice 进去）不该介入；配合上面的「直接子元素只有卡片」，容器里
// 也不会混入 header / 空态把 DOM 下标与可拖项下标搅浑。
// 代价：列内不再支持拖拽重排（本列每次落位都是一次写操作 + 一次失效，重排无语义）。
// 用 useLazyDraggable 而非裸 useDraggable：容器在 v-else 分支内，挂载瞬间 ref 必为
// null，裸 useDraggable 会在 onMounted 里 new Sortable(null) 抛错。
// 每次拖拽（成功或失败）都必须有一次 invalidate 把 DOM 搬位对账回来 —— 成功走
// useWorkerQueue 的 onSuccess，失败走它的 onError，两条路都失效 pool 三域。
const containerRef = ref<HTMLElement | null>(null);
useLazyDraggable(containerRef, {
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
const moveBatchToWorker = inject<
  (batch_id: string, to_worker_id: string, from_shelf_id: string) => Promise<boolean>
>('moveBatchToWorker', async () => false);

/** 2026-10-03 新增：WORKER→WORKER 包装（把别的工人列里的批次拖到本列 = 转交）。
 *  inject 缺省 noop 兜底，与上方 moveBatchToWorker 同款 —— 拿不到包装时 onDragAdd
 *  的工人源分支退化为不发请求，而不是抛错炸掉整个 drop 回调。 */
const moveBatchBetweenWorkers = inject<
  (batch_id: string, from_worker_id: string, to_worker_id: string) => Promise<boolean>
>('moveBatchBetweenWorkers', async () => false);

/** 2026-08-26：记录源 worker ID（拖出本工人列的 worker.id），供落点的
 *  @add 构造 `from: {kind:'WORKER', worker_id}`。落点可能是工序池（撤回批次）也
 *  可能是另一个工人列（转交批次），两者消费同一个工人源条目、各取其一。 */
function onDragStart(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  const fromWorkerId = evt.from.dataset.workerId;
  if (batchId && fromWorkerId) recordWorkerSource(batchId, fromWorkerId);
}

/** 2026-08-27 迁移：vue-draggable-plus @add 事件 payload = Sortable.js 原生，
 *  item 为被拖入的 HTMLElement；通过 BatchCard 上的 :data-batch-id 反查 batch_id。
 *
 *  2026-10-03：拆成两段 —— 候选池源（POOL→WORKER）与工人源（WORKER→WORKER）。
 *  此前只认候选池源、拿不到就早退：把 A 手中的卡片拖到 B 手中时 Sortable 已经把
 *  DOM 搬进了 B 的列，前端既不发请求也不失效 ⇒ B 列凭空多一张卡、A 列永久少一张
 *  （全局 refetchOnWindowFocus=false，只能手点刷新恢复）。 */
async function onDragAdd(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  if (!batchId) return;

  // ① POOL → WORKER：候选池卡片拖进本列。`from.shelf_id` 取卡片自带的**真实货架**
  // （src.shelfId，来自 PoolDrawer 渲染的 :data-shelf-id），不是当前激活货架 ——
  // 候选池跨所有货架，两者可能不一致；填错后端返 20122 BIZ_BATCH_LOCATION_MISMATCH。
  // src.processId 仅用于日志 / 定位，不再作为请求参数。
  const poolSrc = consumePoolSource(batchId);
  if (poolSrc) {
    await moveBatchToWorker(batchId, props.worker.id, poolSrc.shelfId);
    return;
  }

  // ② WORKER → WORKER：另一个工人列的卡片拖进本列（转交）。源 worker id 由源列的
  // onDragStart 记下，consume 后即失效。拖回自己那一列不构成一次移动，早退不发请求。
  const fromWorkerId = consumeWorkerSource(batchId);
  if (!fromWorkerId) return;
  if (fromWorkerId === props.worker.id) return;
  await moveBatchBetweenWorkers(batchId, fromWorkerId, props.worker.id);
}
</script>

<style scoped>
.worker-column {
  width: 280px;
  flex-shrink: 0;
  /* 2026-10-02：显式声明纵向 flex（EP 2.14 的 .el-card 本身已是 display:flex +
     flex-direction:column，此处显式写出来是为了让下方高度链不依赖 EP 内部实现）。
     高度由外层 .columns-container 的 align-items: stretch 撑开，随 splitter 拖动走。 */
  display: flex;
  flex-direction: column;
}
/* 2026-10-02：.col-body 的 flex: 1 需要父级 .el-card__body 是纵向 flex 容器才生效
   （EP 只给了它 flex-grow:1 + overflow:auto，自身高度由内容决定）。padding 由默认的
   var(--el-card-padding)=20px 收到 10px，与 .columns-container 的 12px 内边距对齐。 */
.worker-column :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  padding: 10px;
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
/* 2026-10-03：状态区（loading / error / 空态）与 Sortable 容器拆成兄弟两层。
   .col-content 承接 .el-card__body 的 flex:1 + min-height:0（高度链终点），
   下面的状态节点与 .col-body 在它内部按 v-if/v-else 互斥出现。 */
.col-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
/* 2026-10-02：高度改跟 splitter 走（flex: 1 + min-height: 0），不再用 70vh 魔法数 ——
   固定尺寸卡片必须随 splitter 拖动实时改变可视区高度。 */
.col-body {
  /* 2026-10-03：卡片网格（与 PoolDrawer 的 .pool-cards、PendingBatchesPanel 的
     .pending-cards 同一条基线：gap 8px + align-content: flex-start）。此前是普通块
     容器，200px 定宽卡片逐行堆叠、行与行之间没有统一间隙。列宽 280px 减去
     .el-card__body 的 10px×2 padding 后约 258px，两张 200px 卡 + 8px 间隙放不下，
     实际仍是一行一张 —— 先把网格基线立起来，列宽一旦放宽即自动两列。 */
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: flex-start;
  flex: 1;
  min-height: 100px;
  overflow-y: auto;
}
/* BatchCard 自身固定 200px 宽，此处只锁死不伸缩，避免拉伸破坏网格对齐。 */
.col-body :deep(.batch-card) {
  flex: 0 0 200px;
}
/* 空态居中：.col-content 是纵向 flex 容器，横向对齐靠 align-self（默认 stretch 会把
   el-empty 拉满整列宽），纵向居中靠 auto 外边距。 */
.col-empty {
  align-self: center;
  margin: auto 0;
}
.loading-state,
.error-state {
  padding: 8px;
}
</style>
