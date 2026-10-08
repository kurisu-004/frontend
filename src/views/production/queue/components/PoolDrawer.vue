<!-- 工序候选池抽屉（Sortable 的源与落点），消费方 ProcessBoardTab。
     接收父级 provide 注入：moveBatchToPool / openBatchContextMenu。

     @start 把候选池源信息（含批次真实 shelf_id）写到 dndSourceTracker；@add 时调
     moveBatchToPool 撤回批次。徽标与跨域计数靠 move 的失效链与服务器对账（成功走
     onSuccess、失败走 onError、目标货架缺失的早退走包装内的显式失效，三条路都会失效
     queue 域）。

     Sortable 走二参重载（不传 list），本容器退化为「纯投放信号源」—— 二参形态下内建
     onRemove 的 DOM 放回也随之消失（卡片节点归位靠它、不靠失效），由
     options.onRemove（restoreNodeToSource）补回。完整推导见 useLazyDraggable 的文件头
     注释。

     卡片右键菜单：`@contextmenu.prevent` 挂在 BatchCard 上 —— 它是 inheritAttrs:false
     + v-bind="$attrs"，该监听原样落到卡片根 div，**零新增 DOM 节点**。
     ⚠️ 本容器是 Sortable 的源与落点，卡片的「可拖元素 == vnode 的 DOM footprint」
     是硬不变式（守卫 src/components/__tests__/BatchCardDndFootprint.spec.ts）：**不要**
     用 el-dropdown / el-tooltip / el-popover 之类去包 BatchCard 给右键菜单用
     （el-dropdown 的根是硬包裹 div，会让 evt.item.dataset.batchId 恒 undefined，直接
     断掉整条拖拽链路）；同理**不要**在容器内留模板注释 —— dev 构建保留注释，注释节点
     也是 Sortable 容器的直接子节点，容器内的说明一律写在容器 div 之外。
     菜单本体是 `@/composables/useBatchContextMenu.ts` 的 `showBatchContextMenu()`
     （`@imengyu/vue3-context-menu` 函数模式，菜单挂在 body 级单例容器上，与本
     Sortable 容器零 DOM 关系）。事件走 inject（PoolDrawer 与板级之间隔着
     ProcessBoardTab / QueueBoard 两层，prop 穿透不划算），键名 openBatchContextMenu，
     第三参是本容器自己的**区域常量** `'pool'`。

     moveBatchToPool 签名没有 next_process_id（`to` 是 MoveLocation tagged enum，POOL
     分支只认 shelf_id；目标工序由后端从批次当前 step 自推）。

     onDragStart 只记候选池源（recordPoolSource {processId, shelfId}）：本组件的
     onStart 是**从池里拖出**，evt.from 是池容器（只有 data-process-id），没有工人 id
     —— 记工人源是死代码（WorkerColumn 自己会记）。 -->
<template>
  <div class="pool-drawer">
    <div v-if="pool" class="pool-section">
      <div class="section-header">
        <span class="process-code">{{ pool.process_code }}</span>
        <span class="process-name">{{ pool.process_name }}</span>
        <el-tag size="small" type="info">{{ pool.batches.length }}</el-tag>
      </div>
      <!-- 卡片渲染收敛到 BatchCard.vue，无包装层。Sortable 容器的
           直接子元素必须**全是可拖项**（空态 div 是本容器的兄弟节点，不在其中）。
           data-shelf-id 经 BatchCard 的 fallthrough attrs 落到卡片根 div
           （BatchCard 是 inheritAttrs: false + v-bind="$attrs"）—— 它是撤回 move 的
           `from.shelf_id` 唯一正确来源。
           data-batch-version 同一条通道：撤回 move 的 `version`（OCC 锚，后端必填）
           也是从卡片 dataset 读的 —— 落点的 onDragAdd 只拿得到 evt.item，拿不到渲染源
           里的 batch 对象。
           @contextmenu.prevent 同样走 fallthrough attrs 落在同一张卡片
           根 div 上 —— 右键能力没有引入任何包裹层（包裹即破坏 Sortable 拖拽，见文件
           头注释）。事件的第二参传 v-for 变量 batch 本身（pool.batches 已是
           BatchCardModel[]），消费方要的就是它的 batch_id 与 version。
           这段说明**刻意留在容器之外**：dev 构建保留模板注释，注释节点同样算 Sortable
           容器的直接子节点（守卫见本组件 spec 的 D7b：容器内不许有 comment 节点）。 -->
      <div ref="containerRef" class="section-body pool-cards" :data-process-id="pool.process_id">
        <BatchCard
          v-for="batch in pool.batches"
          :key="batch.batch_id"
          :batch="batch"
          :data-shelf-id="batch.shelf_id ?? ''"
          :data-batch-version="batch.version"
          @contextmenu.prevent="onCardContextMenu($event, batch)"
        />
      </div>
    </div>
    <div v-else class="pool-empty">无工序数据</div>
  </div>
</template>

<script setup lang="ts">
import { inject, ref } from 'vue';
import { useLazyDraggable } from '@/composables/useLazyDraggable';
import type { BatchMenuOpener } from '@/composables/useBatchContextMenu';
import type { ProcessPoolView } from '@/types/productionQueue';
import type { BatchCardModel } from '@/types/batchCard';
import {
  consumeWorkerSource,
  recordPoolSource,
  restoreNodeToSource,
  type DraggableStartEvent,
} from '@/utils/dndSourceTracker';
import BatchCard from '@/components/BatchCard.vue';

// 不接变量 —— 模板直接用 pool（script setup 模板自动解包 props），脚本侧无 props 读取。
defineProps<{
  pool: ProcessPoolView | null;
}>();

// containerRef 在 <div v-if="pool"> 内，而 pool 要等父级 query 解析完才非 null，所以组件
// 挂载瞬间 containerRef 必为 null。裸 useDraggable 默认 immediate:true 会在 onMounted
// 里 new Sortable(null) 抛错，且此后不再重绑（「工人列 → 工序池」的回退拖拽会永久失效）
// ⇒ 必须用 useLazyDraggable 延后绑定。
// 走**二参重载**（不传 list）—— 本容器与 WorkerColumn 一样是纯投放目标：
// 库的内建 onAdd / onRemove 会把 `newDraggableIndex` / `oldDraggableIndex`（Sortable 报的
// **可拖项**下标）当 list 数组下标 splice 进去（`Dt(list, oldDraggableIndex)` 即
// `list.splice(oldDraggableIndex, 1)`），那只有在「list 与可拖子元素一一对应且同序」时
// 才成立。本容器的渲染源是 props 的 pool.batches，二参形态下这套 handler 整个不挂载。
// 代价：内建 onRemove 的**DOM 放回**（`from.insertBefore(item, from.children[oldIndex])`，
// 无论成败都先把节点物理放回源容器）也一并消失 → 必须由 options.onRemove 补回，
// 否则投放失败（20507 货架未映射等）时卡片永久留在池里、invalidate 也清不掉（失败时
// 两侧 query 数据都没变，Vue 只会复用既有元素）。细节见 restoreNodeToSource 的注释。
// WorkerColumn 侧同样必挂：两个容器互为源与落点。
// sort: false 关闭**池内重排**（候选池顺序由后端排定，本就无重排语义；二参形态下
// 重排后也无人回滚）。Sortable 只在「落点实例 === 拖拽起点实例」时才读这个选项，
// 跨实例投放走 group 的 checkPull / checkPut 分流、不看它，故不影响投放。
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

// page provide 必注入；moveBatchToPool 签名是
// (batch_id, version, from_worker_id) —— version 是 OCC 锚（源批次
// t_part_batch.version），撤回 move 必填。撤回的目标架由后端自动选，故没有第四个参数。
const moveBatchToPool =
  inject<(batch_id: string, version: number, from_worker_id: string) => Promise<boolean>>(
    'moveBatchToPool',
  )!;
/** 卡片右键 → 板级 opener（`showBatchContextMenu` 在板级调，菜单挂在 body 上，与本
 *  Sortable 容器零 DOM 关系）。opener 由 QueueBoard provide，本组件与板级之间隔着
 *  ProcessBoardTab 一层，走 inject 而非 prop 穿透。inject 缺省 noop 兜底
 *  （QueueBoard 未提供时右键无反应，不炸掉事件回调）。 */
const openBatchContextMenu = inject<BatchMenuOpener>('openBatchContextMenu', () => {});

/** 卡片根部的右键落点。只做「把 (事件, 卡片, 区域) 转交 opener」这一件事，
 *  不在本组件判权限 —— 权限闸在板级的派生函数里，单点收口。第三参 `'pool'` 是本容器
 *  恒定的区域标签（同一张卡在工序池与工人列上的动作集合不同，而两处的卡片字段集
 *  完全一样 —— 只能由容器给）。 */
function onCardContextMenu(evt: MouseEvent, batch: BatchCardModel): void {
  openBatchContextMenu(evt, batch, 'pool');
}

/** 记录「候选池 → 工人」拖拽源。**必须带 batch 的真实 shelf_id**：
 *  `POST /prod/queue/move` 的 `from: {kind:'POOL', shelf_id}` 需与
 *  batch.current_holder_id 严格一致，否则后端 20122。而工序看板的候选池是跨所有货架
 *  返回的，batch 货架未必等于当前激活货架 —— 所以从卡片自身的
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

/** vue-draggable-plus @add 事件 payload = Sortable.js 原生。 */
async function onDragAdd(evt: DraggableStartEvent) {
  const batchId = evt.item.dataset.batchId;
  if (!batchId) return;
  const fromWorkerId = consumeWorkerSource(batchId);
  if (!fromWorkerId) return;
  // 撤回的目标货架由后端按批次当前工序自动选（负载最低的那一个），前端不传。
  // OCC 锚同 WorkerColumn：走卡片的 data-batch-version dataset（本抽屉不传事件第二参
  // 给 useQueueMove 之前先自查，守卫在包装里）。缺失时 NaN，由 useQueueMove 拦下。
  const version = Number.parseInt(evt.item.dataset.batchVersion ?? '', 10);
  await moveBatchToPool(batchId, version, fromWorkerId);
}
</script>

<style scoped>
/* 需求「工序 tab 左侧的工序池显示高度固定为一个屏幕」的高度链落点 ——
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
/* 多列卡片布局用 flex + wrap。 */
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
