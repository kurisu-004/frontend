<!-- 2026-09-30 重构：工人列自管 useWorkerStateByWorkerQuery（数据层 TanStack Query 化）。
     原先 `batches` prop 由父级 useWorkerQueue 聚合后传入；本 commit 起 WorkerColumn 内部
     自管 query（30s staleTime 去重缓存 + 写操作 invalidate），同一 workerId 跨 tab 共享
     cache identity。
     skeleton / empty 兜底：isLoading 时 max_held / current_held 占位「…」，
     error 时 el-empty description="加载失败"。

     2026-10-04：删掉 inject('shelfId')，state query 只按 workerId 取数。原先 shelfId
     接在 `auth.activeShelfId` 上，而该值只对 SHELF_ACCOUNT + 货架 scope 的角色非空 ——
     本页目标角色（MANAGER / CLERK / INSPECTOR）恒为 null ⇒ query 的 enabled 恒 false
     ⇒ 持有列表稳定显示「暂无持有工单」+ 0/0（静默假空），且 invalidateQueries 默认
     refetchType:'active' 遇 disabled query 也不补刷。后端 `GET /prod/pool/state` 已把
     shelf_id 降为可选，且它唯一影响的 pool_count_by_process 前端零消费。

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
        ⚠️ 二参形态下内建 onRemove 的**DOM 放回**也随之消失，必须由 options.onRemove
        补回（restoreNodeToSource），否则投放失败时幻影节点留在落点列且 invalidate
        清不掉。
     3. Sortable 容器只包卡片：loading / error 两种状态移出容器（Sortable 容器的直接
        子元素必须全是可拖项），空态**不能**移出 —— 容器不渲染就没有 Sortable 实例，
        空工人列会直接失去投放资格（POOL→WORKER 的主场景恰恰是往空闲工人派活）。
        空态改用 pointer-events:none 的兄弟覆盖层承担，视觉不变、落点判定不受影响。
     4. .col-body 补卡片网格（flex-wrap + gap 8px + :deep(.batch-card) 锁 200px），
        与工序池 / 待下发池同一条网格基线；列宽按该基线反算到 432px（见样式区）。
     5. sort: false 关闭列内原地重排（二参形态下库不挂 onUpdate，重排后无人回滚；
        详见 useLazyDraggable 调用处的注释）。 -->
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
      <!-- 2026-10-03：.col-body **无条件渲染**，不再挂在 v-else 上。空工人列必须一直是
           合法的 Sortable 落点 —— 容器不渲染 ⇒ useLazyDraggable 的 watch 走 destroy 分支 ⇒
           该列没有任何 Sortable 实例 ⇒「把批次派给当前没持有批次的工人」放不进去（卡片弹回
           源容器），而这正是 POOL→WORKER 的主场景、也是 WORKER→WORKER 的常见落点。
           代价控制：loading / error 仍走 v-if / v-else-if 两级互斥分支（不进容器），
           空态由下面的兄弟覆盖层承担（pointer-events:none，不吃落点判定）。 -->
      <div ref="containerRef" class="col-body" :data-worker-id="worker.id">
        <BatchCard v-for="batch in heldBatches" :key="batch.batch_id" :batch="batch" />
      </div>
      <div v-if="showEmpty" class="col-empty">
        <el-empty description="暂无持有工单" :image-size="60" />
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { Worker } from '@/types/workerPool';
import type { BatchCardModel as Card } from '@/types/batchCard';
import { useWorkerStateByWorkerQuery } from '@/composables/queries/useWorkerStateByWorkerQuery';
import { heldToCard } from '@/views/production/composables/poolItemToCard';
import {
  consumePoolSource,
  consumeWorkerSource,
  recordWorkerSource,
  restoreNodeToSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import BatchCard from '@/components/BatchCard.vue';

// 2026-09-30 重构：删除 `batches: Card[]` prop —— WorkerColumn 自管 useWorkerStateByWorkerQuery
// 拉取 held_batches；保留 worker prop。
const props = defineProps<{
  worker: Worker;
}>();

// 2026-10-04：**不再 inject('shelfId')** —— 该 query 的 shelf 维度已整体移除
// （后端 `/prod/pool/state` 的 shelf_id 降为可选且只影响前端零消费的
// pool_count_by_process；`auth.activeShelfId` 对 MANAGER / CLERK / INSPECTOR 恒空，
// 接上会让 enabled 恒 false、持有列表静默假空）。queryKey 现在只有 workerId 一个
// 维度，同一 worker 跨 tab / 跨货架共享同一 cache identity。
const stateQuery = useWorkerStateByWorkerQuery(() => props.worker.id);

// 2026-09-30：useWorkerStateByWorkerQuery error → ElMessage 错误桥接（沿 CLAUDE.md
// TanStack Query 一节的「ElMessage 错误桥接」条目与 usePartsListQuery 的写法）。
// 模板 v-else-if「加载失败」el-empty 只是 UI 占位，toast 必须走 ElMessage.error
// 才让用户看到。
watch(
  () => stateQuery.error.value,
  (e) => {
    if (e) ElMessage.error(e.message ?? '加载工人状态失败');
  },
);

/** 2026-10-02：把 useWorkerStateByWorkerQuery.held_batches 适配成 BatchCardModel[]。
 *  heldToCard 函数从 useWorkerQueue.ts 拆到 views/production/composables/poolItemToCard.ts，
 *  共享给 WorkerPoolTab / PoolDrawer / WorkerColumn（同 held 数据流）。 */
const heldBatches = computed<Card[]>(() => {
  const list = stateQuery.data.value?.held_batches ?? [];
  return list.map(heldToCard);
});

/** 空态覆盖层的显示条件。空态**不能**把 .col-body 顶掉（那会让空列失去 Sortable
 *  落点），只作为 pointer-events:none 的兄弟覆盖层叠在容器上方。 */
const showEmpty = computed<boolean>(
  () => !stateQuery.isLoading.value && !stateQuery.error.value && heldBatches.value.length === 0,
);

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

// 2026-10-03：Sortable 用**二参重载**（不传 list）—— 本容器是纯投放目标，库的内建
// onAdd / onRemove 不该介入（它们把 oldDraggableIndex 当 list 数组下标 splice 进去，
// 而本容器的渲染源是 query 派生的 heldBatches）；完整推导见 useLazyDraggable 的
// 文件头注释。
// 每次拖拽（成功 / 失败 / 参数早退）都要有一次 invalidate 与服务器对账：三条出口都在
// useWorkerQueue 内（moveMutation 的 onSuccess / onError，以及两个包装的入参早退分支），
// 都走 invalidatePoolDomains（早退那次包了 try/catch，见该文件的说明）。它负责的是
// 徽标数字与跨域计数 —— 卡片节点本身的归位不靠它，见下一段。
// onRemove 补内建那份的**DOM 放回**（二参形态下库不挂它）：投放失败时若不把节点放回
// 源列，invalidate 也救不回来 —— 失败时两侧 query 数据都没变，Vue 的 keyed diff 只
// patchElement，永远不删不在 vdom 里的外来节点。细节见 restoreNodeToSource 的注释。
// sort: false 关闭**容器内重排**：本 UI 每次落位都是「一次写操作 + 一次失效」，无重排
// 语义，重排后无人回滚 DOM 顺序。Sortable 只在「落点实例 === 拖拽起点实例」时才读
// 这个选项（跨实例投放走 group 的 checkPull / checkPut 分流，不看它），所以它不会
// 影响跨容器投放 —— 仓内 PendingBatchesPanel → PendingPoolCard 就是同 group 跨实例
// 投进一个 sort:false 落点的既有先例。
// 走 useLazyDraggable 而非裸 useDraggable：统一由它强制 immediate:false + 在
// flush:'post' 的 watch 里绑定，el 换节点时自动重绑、置 null 时自动 destroy。
const containerRef = ref<HTMLElement | null>(null);
useLazyDraggable(containerRef, {
  group: 'work-orders',
  sort: false,
  animation: 150,
  ghostClass: 'sortable-ghost',
  onStart: onDragStart,
  onAdd: onDragAdd,
  onRemove: restoreNodeToSource,
});

// 2026-09-30：moveBatchToWorker 签名收窄为 (batch_id, to_worker_id, from_shelf_id)
// —— 不再有 process_id。后端把 `admin/worker-pool/assign` 合并进了通用移动端点
// `POST /prod/pool/move`，入参是 `MoveRequest { batch_id, from, to, note? }`，
// 目标工序由 service 从 `batch.current_process_step.process_id` 自推
// （worker-pool.md）。inject 缺省用 noop 兜底（provider 缺失时不炸）。
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
  /* 2026-10-03：432px 来自下方两列网格的算式 —— 200px 卡片 × 2 + 8px gap
     + .el-card__body padding 10px × 2 + el-card 边框 1px × 2 = 430px，取 432 留 2px 余量。
     卡片 200px 是全看板硬约定（工序池 / 待下发池同一张卡），两列换行只能靠加宽列，不能
     压卡片；低于 430 时 flex-wrap 一行都换不出来，净效果是每行白多 8px 纵向间隙。
     一屏可见列数变少（~3.5 → ~2.5）由 .columns-container 的 overflow-x: auto 横向滚动
     兜底，不隐藏任何工人。 */
  width: 432px;
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
/* 2026-10-03：状态区（loading / error / 空态）与 Sortable 容器拆成兄弟三层。
   .col-content 承接 .el-card__body 的 flex:1 + min-height:0（高度链终点），
   并作为空态覆盖层的定位上下文；下面的状态节点与 .col-body 在它内部各按 v-if 出现。 */
.col-content {
  position: relative;
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
     容器，200px 定宽卡片逐行堆叠、行与行之间没有统一间隙。列宽按该基线反算（见
     .worker-column 的算式注释），432px 恰好放得下两列。min-height:100px 是空列时的
     落点面积下限：flex:1 已经能撑满 .col-content，这行保证 .el-card__body 高度被内容
     决定时（列内无卡 + 父级未定高）也留得下一块可感知的投放区。 */
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
/* 2026-10-03：空态是 .col-body 的**兄弟覆盖层**，不是容器内的子节点 ——
   ① 容器内混入非可拖子元素会让 Sortable 的可拖项下标与 DOM 下标错位；
   ② 容器不渲染会让空列失去 Sortable 实例，POOL→WORKER 的主场景直接放不进去。
   pointer-events:none 是关键：不写它，el-empty 的插画 DOM 会吃掉落点判定，
   拖到「空列中央」和拖到容器外的空白区变得等价。
   居中靠 flex 自身（align-items/justify-content），不再依赖外边距。 */
.col-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.loading-state,
.error-state {
  padding: 8px;
}
</style>
