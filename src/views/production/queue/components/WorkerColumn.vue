<!-- 2026-10-08 重构：工人列不再自管 query，数据全部由父级透传。
     原先 WorkerColumn 自管「单工人 state」请求（held_batches + max_held +
     current_held + capacity_remaining），后端把这一切内联进工序看板的
     `workers[]` 之后，本组件零请求 —— 一个工序 tab 从「1 + N 个请求」（1 个工序详情
     + N 个工人 state）降为恒 1 个请求。

     props 形态因此收敛成单个 `worker: QueueWorkerSchema`（后端 VO 原样透传），
     不再有 loading / error 两级互斥分支：数据由父级 tab 一次性到齐，列内不需要
     骨架。骨架 / 空态仍由 ProcessBoardTab 承担（粒度更粗但请求数是 1）。

     2026-10-06：卡片右键菜单（批次在工人持有中同样可召回 / 转交 / 拆批）。
     `@contextmenu.prevent` 挂在 BatchCard 上 —— 它是 inheritAttrs:false +
     v-bind="$attrs"，该监听原样落到卡片根 div，**零新增 DOM 节点**。
     ⚠️ 本列的 .col-body 是 Sortable 落点，卡片的「可拖元素 == vnode 的 DOM footprint」
     是硬不变式（守卫 src/components/__tests__/BatchCardDndFootprint.spec.ts）：**不要**
     用 el-dropdown / el-tooltip / el-popover 之类去包 BatchCard 给右键菜单用（包裹即
     多根 vnode，锚点残留 + evt.item 指向包裹层 ⇒ POOL↔WORKER 拖拽断链）。同理**不要**
     在容器内留模板注释 —— dev 构建保留注释，注释节点也是容器的直接子节点；容器内的说明
     一律写在容器 div 之外（守卫见本组件 spec 的 W13：容器内不许有 comment 节点）。菜单
     本体是 `@/composables/useBatchContextMenu.ts` 的 `showBatchContextMenu()`（库函数
     模式，菜单挂在 body 级单例容器上）。事件走 inject（本组件与板级之间隔着
     ProcessBoardTab / QueueBoard 两层），键名 openBatchContextMenu，第三参是本列恒定
     的区域标签 `'worker'`。

     2026-09-30：拖拽链路对接后端通用移动端点 `POST /prod/queue/move`。
     - onStart 记 worker 源（落点的 @add 消费）；onAdd 记/取候选池源时改为读
       `consumePoolSource` 返回的 { processId, shelfId }，其中 **shelfId 必须是
       batch 真实所在货架**（不能拿当前激活货架凑，候选池跨货架 ⇒ 后端 20122）。
     - moveBatchToWorker 不带 process_id 形参（目标工序由后端自推）。

     2026-10-03 四项修复（口径仍成立）：
     1. onDragAdd 拆两段：候选池源走 POOL→WORKER，工人源走 **WORKER→WORKER**
        （此前只有前者 ⇒ 批次移到另一名工人手中时前端零实现，Sortable 已把 DOM 搬进
        目标列却不发请求不失效，目标列凭空多一张卡、源列永久少一张）。从自己这一列
        拖回自己不构成移动，早退不发请求。
     2. Sortable 走二参重载（不传 list）：库的内建 onAdd/onRemove 假定「传进来的
        list 就是渲染源」，而本容器的渲染源是 props 派生的 heldBatches —— 传任何
        list 副本都只是往一个没人看的数组里 splice。详见 useLazyDraggable 的文件头
        注释（那里记录了「纯投放信号源」这条不变量的完整推导）。
        ⚠️ 二参形态下内建 onRemove 的**DOM 放回**也随之消失，必须由 options.onRemove
        补回（restoreNodeToSource），否则投放失败时幻影节点留在落点列且 invalidate
        清不掉。
     3. Sortable 容器只包卡片：状态区移出容器（Sortable 容器的直接子元素必须全是
        可拖项），空态**不能**移出 —— 容器不渲染就没有 Sortable 实例，空工人列会直接
        失去投放资格（POOL→WORKER 的主场景恰恰是往空闲工人派活）。空态改用
        pointer-events:none 的兄弟覆盖层承担，视觉不变、落点判定不受影响。
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
      </div>
      <el-progress
        :percentage="capacityPercent"
        :format="() => `${worker.current_held}/${worker.max_held}`"
        :status="capacityStatus"
      />
    </template>
    <div class="col-content">
      <!-- 2026-10-03：.col-body **无条件渲染**，不挂任何 v-if。空工人列必须一直是
           合法的 Sortable 落点 —— 容器不渲染 ⇒ useLazyDraggable 的 watch 走 destroy
           分支 ⇒ 该列没有任何 Sortable 实例 ⇒「把批次派给当前没持有批次的工人」放不
           进去（卡片弹回源容器），而这正是 POOL→WORKER 的主场景、也是 WORKER→WORKER
           的常见落点。空态由下面的兄弟覆盖层承担（pointer-events:none，不吃落点判定）。
      -->
      <!-- 2026-10-06：右键召回 —— @contextmenu.prevent 走 BatchCard 的 fallthrough
           attrs 落在卡片根 div，未引入任何包裹层（包裹即破坏 Sortable footprint，见文件
           头注释）。第二参传 v-for 变量 batch 本身（heldBatches 已是
           BatchCardModel[]，heldToCard 已填 version —— 召回与 move 的 OCC 锚）。
           data-batch-version 同理：move 的 version 必填，而落点的 onDragAdd 只拿得到
           DOM（evt.item），拿不到渲染源里的 batch 对象 ⇒ version 经 fallthrough attrs
           落在同一张卡片根 div 上，与 batch-id 走同一条 dataset 通道。
           这段说明**刻意留在容器之外**：dev 构建保留模板注释，注释节点同样算 Sortable
           容器的直接子节点（守卫见本 spec 的 W13：容器内不许有 comment 节点）。 -->
      <div ref="containerRef" class="col-body" :data-worker-id="worker.worker_id">
        <BatchCard
          v-for="batch in heldBatches"
          :key="batch.batch_id"
          :batch="batch"
          :data-batch-version="batch.version"
          @contextmenu.prevent="onCardContextMenu($event, batch)"
        />
      </div>
      <div v-if="showEmpty" class="col-empty">
        <el-empty description="暂无持有工单" :image-size="60" />
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { BatchMenuOpener } from '@/composables/useBatchContextMenu';
import type { QueueWorkerSchema } from '../composables/productionQueueSchema';
import type { BatchCardModel as Card } from '@/types/batchCard';
import { heldToCard } from '../utils/queueItemToCard';
import {
  consumePoolSource,
  consumeWorkerSource,
  recordWorkerSource,
  restoreNodeToSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import BatchCard from '@/components/BatchCard.vue';

/** props 只有 worker 一个对象：容量三字段与持有批次都由它带（后端内联，见文件头）。
 *  列内不再有任何 query，也不再有 loading / error 骨架分支。 */
const props = defineProps<{
  worker: QueueWorkerSchema;
}>();

/** 持有批次 → 卡片 model（适配层在本域 utils/queueItemToCard.ts，与工序池 / 待下发池
 *  共用同一张 BatchCard）。 */
const heldBatches = computed<Card[]>(() => props.worker.held_batches.map(heldToCard));

/** 空态覆盖层的显示条件（恒等于「该工人当前没持有批次」—— 数据由父级一次到齐，
 *  没有 loading / error 中间态）。空态**不能**把 .col-body 顶掉（那会让空列失去
 *  Sortable 落点），只作为 pointer-events:none 的兄弟覆盖层叠在容器上方。 */
const showEmpty = computed<boolean>(() => heldBatches.value.length === 0);

const capacityPercent = computed(() => {
  const maxHeld = props.worker.max_held;
  if (maxHeld === 0) return 0;
  return Math.round((props.worker.current_held / maxHeld) * 100);
});

// el-progress 的 status 只接受 '' | 'success' | 'warning' | 'exception'，
// 没有 'primary'。中段（>=70%）走空串，让 EP 走默认主色（蓝）。
const capacityStatus = computed<'success' | 'warning' | ''>(() => {
  if (props.worker.capacity_remaining === 0) return 'warning';
  if (capacityPercent.value >= 70) return '';
  return 'success';
});

// Sortable 用**二参重载**（不传 list）—— 本容器是纯投放目标，库的内建 onAdd /
// onRemove 不该介入（它们把 oldDraggableIndex 当 list 数组下标 splice 进去，而本容器
// 的渲染源是 props 派生的 heldBatches）；完整推导见 useLazyDraggable 的文件头注释。
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

/** moveBatchToWorker 签名 (batch_id, version, to_worker_id, from_shelf_id)，由
 *  QueueBoard provide、useQueueMove 实现。inject 缺省用 noop 兜底（provider 缺失时
 *  不炸）。目标工序由后端自推，故没有 process_id 形参。
 *  `version` 排在第二参：它是**每个方向都要带**的 OCC 锚（源批次 t_part_batch.version），
 *  排在这里三个包装的形参顺序就完全一致（batch_id, version, …），调用侧不会漏。 */
const moveBatchToWorker = inject<
  (
    batch_id: string,
    version: number,
    to_worker_id: string,
    from_shelf_id: string,
  ) => Promise<boolean>
>('moveBatchToWorker', async () => false);

/** WORKER→WORKER 包装（把别的工人列里的批次拖到本列 = 转交）。inject 缺省 noop
 *  兜底：拿不到包装时 onDragAdd 的工人源分支退化为不发请求，而不是抛错炸掉整个
 *  drop 回调。 */
const moveBatchBetweenWorkers = inject<
  (
    batch_id: string,
    version: number,
    from_worker_id: string,
    to_worker_id: string,
  ) => Promise<boolean>
>('moveBatchBetweenWorkers', async () => false);

/** 卡片右键 → 板级 opener（菜单本体由板级调 `showBatchContextMenu` 挂在 body 上，与本
 *  Sortable 容器零 DOM 关系）。opener 由 QueueBoard provide；本组件与板级之间隔着
 * ProcessBoardTab 一层，走 inject 而非 prop 穿透。inject 缺省 noop 兜底
 * （QueueBoard 未提供时右键无反应，不炸掉事件回调）。 */
const openBatchContextMenu = inject<BatchMenuOpener>('openBatchContextMenu', () => {});

/** 卡片根部的右键落点。只做「把 (事件, 卡片, 区域) 转交 opener」这一件事，权限闸在
 * 板级的派生函数里，本组件不重复判。第三参 `'worker'` 是本列恒定的区域标签。 */
function onCardContextMenu(evt: MouseEvent, batch: Card): void {
  openBatchContextMenu(evt, batch, 'worker');
}

/** 记录源 worker ID（拖出本工人列的 `worker.worker_id`），供落点的 @add 构造
 *  `from: {kind:'WORKER', worker_id}`。落点可能是工序池（撤回批次）也可能是另一个
 *  工人列（转交批次），两者消费同一个工人源条目、各取其一。 */
function onDragStart(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  const fromWorkerId = evt.from.dataset.workerId;
  if (batchId && fromWorkerId) recordWorkerSource(batchId, fromWorkerId);
}

/** Sortable @add 的 payload 是原生事件本体，item 为被拖入的 HTMLElement；通过
 *  BatchCard 上的 :data-batch-id 反查 batch_id、:data-batch-version 反查 OCC 锚
 *  version（落点拿不到渲染源里的 batch 对象 —— 卡片可能已随 key 变化卸载）。
 *
 *  两段来源：候选池源（POOL→WORKER）与工人源（WORKER→WORKER）。此前只认候选池源、
 *  拿不到就早退 ⇒ 把 A 手中的卡片拖到 B 手中时前端既不发请求也不失效。
 */
async function onDragAdd(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  if (!batchId) return;
  // dataset 缺失时 parseInt('') ⇒ NaN，被 useQueueMove 的 version 守卫拦下（warning +
  // 早退）。⚠️ 不能写 `|| 0`：0 是合法形态的假 version，会让后端按 OCC 冲突（40901）
  // 拒一次用户没做错的投放。
  const version = Number.parseInt(evt.item.dataset.batchVersion ?? '', 10);

  // ① POOL → WORKER：候选池卡片拖进本列。`from.shelf_id` 取卡片自带的**真实货架**
  // （src.shelfId，来自 PoolDrawer 渲染的 :data-shelf-id），不是当前激活货架 ——
  // 候选池跨所有货架，两者可能不一致；填错后端返 20122 BIZ_BATCH_LOCATION_MISMATCH。
  const poolSrc = consumePoolSource(batchId);
  if (poolSrc) {
    await moveBatchToWorker(batchId, version, props.worker.worker_id, poolSrc.shelfId);
    return;
  }

  // ② WORKER → WORKER：另一个工人列的卡片拖进本列（转交）。源 worker id 由源列的
  // onDragStart 记下，consume 后即失效。拖回自己那一列不构成一次移动，早退不发请求。
  const fromWorkerId = consumeWorkerSource(batchId);
  if (!fromWorkerId) return;
  if (fromWorkerId === props.worker.worker_id) return;
  await moveBatchBetweenWorkers(batchId, version, fromWorkerId, props.worker.worker_id);
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
  /* 显式声明纵向 flex（EP 2.14 的 .el-card 本身已是 display:flex +
     flex-direction:column，此处显式写出来是为了让下方高度链不依赖 EP 内部实现）。
     高度由外层 .columns-container 的 align-items: stretch 撑开，随 splitter 拖动走。 */
  display: flex;
  flex-direction: column;
}
/* .col-body 的 flex: 1 需要父级 .el-card__body 是纵向 flex 容器才生效
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
/* .col-content 承接 .el-card__body 的 flex:1 + min-height:0（高度链终点），并作为
   空态覆盖层的定位上下文；下面的覆盖层与 .col-body 在它内部各按条件出现。 */
.col-content {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
/* 高度改跟 splitter 走（flex: 1 + min-height: 0），不用 70vh 魔法数 ——
   固定尺寸卡片必须随 splitter 拖动实时改变可视区高度。 */
.col-body {
  /* 卡片网格（与 PoolDrawer 的 .pool-cards、PendingBatchesPanel 的 .pending-cards
     同一条基线：gap 8px + align-content: flex-start）。min-height:100px 是空列时的
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
/* 空态是 .col-body 的**兄弟覆盖层**，不是容器内的子节点 ——
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
</style>