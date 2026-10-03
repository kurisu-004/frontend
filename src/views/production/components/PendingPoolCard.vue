<!-- 2026-09-30：自产工序 pool 卡（PendingPoolsPanel 的 v-for 项）——「待下发」Tab
     右栏的**下发目标**卡片（单击下发 / 拖放批次到此工序）。
     渲染：标题 (code + name + badge 候选 batch 数) + 交互区。

     2026-09-30 懒加载关键改动：**本卡片不再自管 useWorkerPoolByProcessQuery**。
     改前：卡片为了渲染右上角 badge（`items.length`）而发 `GET /prod/pool/{pid}`，
     而本卡片位于**默认首屏激活的「待下发」tab**内、且 `v-for` 全部 INHOUSE 工序
     ⇒ 进页面即打出 N 个 per-process 详情请求（N+1），与「切到 tab 才懒加载」的
     设计意图完全相反。
     改后：badge 直接取 `useWorkerPoolCountsQuery` 的聚合计数（单请求，本页已 eager
     拉取用于 tab 标题徽标），本组件**零网络请求**。per-process 详情只有
     `WorkerPoolTab`（el-tab-pane `:lazy="true"`）会拉。
     ⇒ 进入页面的请求数恒为 3：`GET /prod/processes` + `GET /prod/pool/counts` +
     `GET /prod/batches/pending`。

     2026-10-02 三项变更：
       1. **盒模型对齐 BatchCard**（固定 200×96 + 4px 左边框 + 8px 圆角），与左侧
          批次卡同款网格节奏；
       2. **左边框取工序色**（process.color，未设置时回落主色）—— 工序卡是下发的
          视觉归属标识，与左侧批次卡的「加急橙」左边框占同一视觉位；
     3. **拖拽改 vue-draggable-plus**：本卡片根 div 即 Sortable 投放目标容器，
        用**二参重载**（不传 list）—— 传了 list 会带上一整套内置 handler，反过来
        污染目标状态；且内置 onAdd 会把拖入的 DOM 节点塞进本容器却不受 Vue 管理。
        成功态反馈只能挂目标的 onAdd（跨容器 drop 时目标的 onEnd 永不触发）；
     4. **拖入高亮（.is-dropping）由父级驱动**：Sortable 的 _onMove 只从**被拖起的
        那个容器**（源，即待下发批次列表）的 options.onMove 取回调，投放目标的 onMove
        一次都不触发 ⇒ 高亮态由源面板 onMove 上报 process.id、经 WorkerQueueBoard 落到
        本组件的 `dropping` prop。根 div 的 data-process-id 就是这条链路的识别标记。

     2026-10-04 拖入下发加二次确认：手动把批次拖到工序卡是「不可逆写操作 + 手滑高发」
     （指针划过即亮、稍一松手即下发），故 mutate 之前弹一次确认框。弹窗**只报工序名**：
     被拖卡片的 DOM 上只有 data-batch-id，零件名 / 批次号在另一面板的 batches 里，
     为此把批次详情接进投放卡并不划算。确认框**只挂在拖拽路径**上，单击工序卡的既有
     下发语义（多选集合 + 空选兜底）完全不动。弹窗的异步性不影响节点归位：拖拽源
     PendingBatchesPanel 走的是 vue-draggable-plus **三参重载**（传了 list），库内建
     onRemove 的第一句 `from.insertBefore(item, from.children[oldIndex])` 在同一个
     _onDrop 里、目标 onAdd 返回后**同步**把被拖节点放回源容器 ⇒ 本组件不必自备
     onRemove 回滚。 -->
<template>
  <div
    ref="dropRef"
    :class="['pool-card', { 'is-dropping': props.dropping }]"
    :style="{ borderLeftColor: accent }"
    :data-process-id="props.process.id"
    @click="onClick"
  >
    <div class="row">
      <span class="process-code">{{ props.process.code }}</span>
    </div>
    <div class="row">
      <span class="process-name">{{ props.process.name }}</span>
      <el-tag size="small" type="info">{{ props.count }}</el-tag>
    </div>
    <div class="row">
      <span class="pool-hint">点击下发 / 拖入批次</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useDraggable, type DraggableEvent } from 'vue-draggable-plus';
import { useConfirm } from '@/composables/useConfirm';
import type { UsePendingDispatchReturn } from '@/views/production/composables/usePendingDispatch';

interface Props {
  /** 单工序的轻量元数据（来自 useProcessesQuery.items.filter(INHOUSE)）。 */
  process: { id: string; code: string; name: string; color?: string | null | undefined };
  /** 该工序候选批次徽标 —— 由父级 WorkerQueueBoard 从 useWorkerPoolCountsQuery 的
   *  `counts[].count` 透传（`number` 或加载中占位 `'…'`）。本卡片不自行请求。 */
  count: number | string;
  /** 多选已选集合（响应式 Ref，父级 composable 持有）。 */
  selectedIds: Ref<Set<string>>;
  /** 下发 mutation（来自 usePendingDispatch.dispatchMutation）。 */
  dispatchMutation: UsePendingDispatchReturn['dispatchMutation'];
  /** 2026-10-02：拖拽悬停高亮态，由父级（PendingPoolsPanel ← WorkerQueueBoard）
   *  透传。Sortable 只从源的 options.onMove 派发，投放目标自身收不到 onMove ⇒
   *  本组件不持有该状态，只按 prop 渲染 .is-dropping。 */
  dropping?: boolean;
}

const props = withDefaults(defineProps<Props>(), { dropping: false });

/** 2026-10-02：左侧 4px 竖条色 = 工序色。工序色是 el-color-picker color-format="hex8"
 *  产出的 `#RRGGBBAA`（9 字符），CSS border-left-color 直接吃，不做任何字符串加工；
 *  后端 color 为 NULL（未设置）时回落主色。 */
const accent = computed<string>(() => props.process.color ?? 'var(--el-color-primary)');

const dropRef = ref<HTMLElement | null>(null);

/** 2026-10-04：拖入下发的二次确认。按钮文案与 usePendingDispatch 的自动下发确认框
 *  统一（「下发 / 取消」），两处下发入口在用户心智里是同一个动作。 */
const { dangerous: confirmDangerous } = useConfirm();
/** 2026-10-02：Sortable 投放目标（二参重载，不传 list）。本卡片根 div 无条件渲染，
 *  mount 即非 null，直接用 useDraggable（不需要 useLazyDraggable 的延后绑定）。
 *  - `draggable: '.never'`：容器内没有任何匹配 `.never` 的子元素 ⇒ 卡片自身不可从
 *    本容器拖出，但外部投放仍可被 Sortable 的 _onDragOver 接受；
 *  - 成功态只能挂 onAdd：跨容器 drop 时目标的 onEnd 永不触发（end 只派发给源）。
 *
 *  这里**不挂 onMove / onSort**：Sortable 的 _onMove 取的是 `fromEl.options.onMove`
 *  （源的实例），投放目标侧挂了在真机上永不触发，留着只会让人误以为高亮已接通。 */
useDraggable(dropRef, {
  group: { name: 'pending-batches', put: true, pull: false },
  sort: false,
  draggable: '.never',
  animation: 150,
  onAdd: onDrop,
});

/** 单击工序卡 → 对已选 batchIds 下发到该工序。
 *  selectedIds 空 → ElMessage.warning 兜底；非空 → dispatchMutation.mutate。
 *  单件下发 = `batchIds.length === 1`（后端 dispatch 已是 bulk-only 形态）。 */
function onClick() {
  const ids = Array.from(props.selectedIds.value);
  if (ids.length === 0) {
    ElMessage.warning('请先选择待下发批次');
    return;
  }
  props.dispatchMutation.mutate({
    batchIds: ids,
    targetProcessId: props.process.id,
  });
}

/** sortablejs 派发的 add 事件体最小投影：sortablejs 1.15.2 构造 CustomEvent 时
 *  会挂上 `originalEvent`（原生事件本体），vue-draggable-plus 的 handler 组合原样
 *  透传同一个对象；@types/sortablejs 的 SortableEvent 未声明该字段，故本地补投影。 */
type AddEvent = DraggableEvent & { originalEvent?: Event };

/** 2026-10-02：拖入批次 → 下发（Sortable 目标端 onAdd）。
 *  - batch_id 取 `evt.item.dataset.batchId`（卡片上的 data-batch-id），**不取
 *    `evt.data`：源容器混入非可拖子节点时 evt.data 不可靠；且节点即使已被 Sortable
 *    从 DOM 摘掉，dataset 仍可读；
 *  - 拖拽 = 只发被拖的那一件，**不读 selectedIds**（多选集合只属于单击路径）；
 *  - evt.item 可能缺失（Sortable 在目标无有效落点时不派发 item），兜一句短路。
 *
 *  投放确认守卫：onAdd 何时触发完全由库决定，库给的头号判据只有一条「被拖节点当前的
 *  父容器 ≠ 拖起它的那一个容器」（Sortable `_onDrop` 里的 `rootEl !== parentEl` 分支），
 *  库里**没有**「释放在目标外就回滚」的能力。指针 dragover 进本卡时 Sortable 会把被拖
 *  卡片**真实插入**本容器占位，而指针随后移出或用户按 Esc 都没有 handler 撤回占位 ——
 *  于是用户以为放弃了，下发却照发。故判据改用 `originalEvent`（原生事件本体）
 *  自证落点，三条路径各由不同的守卫挡：
 *   - 按 Esc / 原生拖拽自行终止 ⇒ 触发的是 `dragend`（该监听挂在被拖节点上，`drop`
 *     压根不派发；Sortable 的 `handleEvent` 把 `drop` 与 `dragend` 归到同一个
 *     `_onDrop`），第一道守卫挡掉；
 *   - 指针在卡片间隙 / 面板空白 / 工具条 / tab 条上松手 ⇒ 这些区域不在任何 Sortable
 *     容器内，没人对其 `dragover` 调 `preventDefault` ⇒ 按 HTML 规范浏览器不派发
 *     `drop`、改派 `dragend` ⇒ 同样被**第一道**守卫挡掉；
 *   - `drop` 落在**另一个** Sortable 容器内（典型：指针从本卡回到待下发池
 *     `.pending-cards` 后松手 —— 那里是已注册的 Sortable，`dragover` 被
 *     `preventDefault` ⇒ 真的派发 `drop` 并冒泡到 document，可 target 在本卡之外）
 *     ⇒ 兜底的第二道守卫挡掉。
 *
 *  覆盖面限制：本守卫只覆盖**桌面鼠标的原生 DnD 路径**。触屏（`pointerType ===
 *  'touch'` ⇒ Sortable 走 fallback 模拟）或将来任一调用点开 `forceFallback` 时，完成
 *  事件是 `touchend` / `mouseup` 而非 `drop` ⇒ 第一道守卫会把所有投放一并丢弃 ⇒
 *  表现为「触屏上拖得动、亮得起来、松手没反应」。该半可用状态是本次切 Sortable 新引入
 *  的（改造前用 HTML5 原生 DnD，触屏上本就不可拖），故只在此声明，不做
 *  `elementFromPoint` 之类的扩展。
 *
 *  来源白名单：Sortable 的 `checkPut` 在**布尔形态**（`put: true`）下直接
 *  `return true`，不做 group 名比对 ⇒ 将来页面上若出现第二个 Sortable 列表，从它那里
 *  拖一张卡进本工序卡同样会触发 onAdd ⇒ 违反「只有待下发池能投放到工序卡」。来源校验
 *  只能在本组件做：待下发池容器在模板上标了 `data-pending-pool="1"`。
 *
 *  高亮的清理由源侧 onEnd 负责（end 只派发给源，跨容器 drop 时本目标的 onEnd 永不
 *  触发，故此处不能也不该复位 dropping）。
 *
 *  2026-10-04 二次确认：三道守卫与 item / batchId 提取全部**同步**跑在第一个 await
 *  之前 —— 它们是「这次根本不算投放」的静默短路，不该被一个弹窗拦在中间（用户按了 Esc
 *  却还要再点一次「取消」才能消掉弹窗）。守卫全过才弹确认框，取消即不发请求。
 *
 *  async 化不引入 DOM 回滚义务：拖拽源走三参重载（传了 list），库内建 onRemove 的
 *  第一句 `from.insertBefore(item, from.children[oldIndex])` 在同一个 _onDrop 里、
 *  目标 onAdd 返回后**同步**执行 ⇒ 确认框 await 期间被拖节点早已归位。 */
async function onDrop(evt: DraggableEvent) {
  // 释放在本卡之外（含 Esc 取消）⇒ 视为放弃投放，不下发
  const orig = (evt as AddEvent).originalEvent;
  if (orig?.type !== 'drop') {
    warnDropped('完成事件不是 drop', orig);
    return;
  }
  const rootEl = dropRef.value;
  const target = orig.target as Node | null;
  if (!rootEl || !target || !rootEl.contains(target)) {
    warnDropped('落点不在本卡内', orig);
    return;
  }
  // 来源必须是待下发池（Sortable 的 put: true 不做来源白名单，见上方注释）
  if (!evt.from?.dataset?.pendingPool) {
    warnDropped('来源不是待下发池', orig);
    return;
  }

  const item = evt?.item;
  if (!item) return;
  const batchId = item.dataset.batchId;
  if (!batchId) return;
  const confirmed = await confirmDangerous(
    '确认下发',
    `确认将批次下发到工序「${props.process.code} ${props.process.name}」？`,
    { type: 'warning', confirmText: '下发', cancelText: '取消' },
  );
  if (!confirmed) return;
  props.dispatchMutation.mutate({
    batchIds: [batchId],
    targetProcessId: props.process.id,
  });
}

/** 2026-10-02：守卫生效时的 dev-only 诊断。三道守卫全是**静默 return**，而
 *  vue-draggable-plus 一旦升级就可能换掉 `originalEvent` 字段或事件名，届时所有拖拽
 *  下发会无声失效、控制台一片干净 ⇒ 这里在 dev 把命中的守卫与 `orig.type` 打出来，
 *  日后一眼定位。生产不打：守卫生效是正常路径，量级随拖拽次数。 */
function warnDropped(guard: string, orig?: Event): void {
  if (!import.meta.env.DEV) return;
  console.warn(
    `[PendingPoolCard] 投放被守卫「${guard}」丢弃：originalEvent.type=${orig?.type ?? '(无 originalEvent)'}`,
  );
}
</script>

<style scoped>
/* 2026-10-02：盒模型与 BatchCard 对齐（200×96 / 4px 左边框 / 8px 圆角），
   让待下发池与工序卡共用同一条网格基线。 */
.pool-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 200px;
  height: 96px;
  padding: 8px 10px;
  overflow: hidden;
  /* 左边框在模板上以 :style borderLeftColor 单独着色，这里只给透明占位 */
  border: 1px solid var(--el-border-color-lighter);
  border-left: 4px solid transparent;
  border-radius: 8px;
  background: var(--el-bg-color);
  cursor: pointer;
  transition:
    border-color 0.2s,
    background 0.2s,
    box-shadow 0.2s;
}
.pool-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
/* 2026-10-02：拖入高亮只覆盖上/右/下三边 —— 左边框是工序色的语义位，用
   border-color 简写会连带干掉它。 */
.pool-card.is-dropping {
  border-top-color: var(--el-color-primary);
  border-right-color: var(--el-color-primary);
  border-bottom-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.row {
  display: flex;
  align-items: center;
  min-width: 0;
  /* 3 行统一 18px 行高，但第 2 行的行高由 el-tag size="small" 决定（EP 2.14.6 把
     .el-tag--small 钉成 height:20px，flex 行内实际高 20px）：18 + 20 + 18 + 2×2 gap
     + 上下各 8 padding + 上下各 1px 边框 = 78px ≤ 96px 固定高，余量 18px 吸收
     字体渲染的行高波动。 */
  line-height: 18px;
  font-size: 12px;
}
.process-code {
  font-weight: 600;
  font-family: var(--el-font-family-monospace, monospace);
}
.process-name {
  flex: 1;
  min-width: 0;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pool-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
</style>
