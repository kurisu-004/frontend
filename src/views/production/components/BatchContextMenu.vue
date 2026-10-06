<!-- src/views/production/components/BatchContextMenu.vue
     2026-10-06 新增：生产队列「已下发批次右键召回」的操作菜单。挂在 WorkerQueueBoard
     顶层，整页单例；卡片侧只挂一个 `@contextmenu.prevent` 并经 provide/inject 把
     (事件, 卡片) 交给板级 opener。

     ⚠️ 为什么**绝对不能**用任何组件去「包裹」BatchCard：
       BatchCard 是 Sortable 的可拖项，硬不变式是「可拖元素 == vnode 的 DOM footprint」
       （见 CLAUDE.md「拖拽投放（Sortable）」，守卫 src/components/__tests__/
       BatchCardDndFootprint.spec.ts）。Sortable 搬的是 `evt.item` 这一个节点、Vue 卸载
       时只认 `vnode.el`：
         - `<el-dropdown trigger="contextmenu">` 包住 BatchCard ⇒ 根变成
           `createElementBlock('div', { class: 'el-dropdown' })` 这个硬包裹 div，Sortable
           的 evt.item 变成它，而 `evt.item.dataset.batchId` 恒 undefined
           ⇒ PoolDrawer.onDragStart / WorkerColumn.onDragStart 断链，整条 POOL↔WORKER
           拖拽直接失效；
         - `el-tooltip` / `el-popover` 包根 ⇒ 同类事故（teleport 占位注释混进 Sortable
           容器 + Fragment 锚点残留），BatchCard 自身也是因此才把 tooltip 缩到根内部的
           .card-body 上。
       结论：右键能力只能挂在**卡片根部**上（BatchCard 是 inheritAttrs:false +
       v-bind="$attrs"，onContextmenu 原样落在根 div，零新增 DOM 节点），菜单本体必须
       待在 Sortable 容器之外 —— 即本组件挂在板级根下、teleport 到 body。

     为什么整页单例 + teleport：候选池 / 工人列里可能同时有几十张卡，逐卡一个菜单实例
     既无必要，也让 teleported 节点随卡片增删反复挂载。菜单的可见性与目标批次是「光标
     在哪」这一瞬时状态，天然属于板级；teleport 则保证它永远不被任何 Sortable 容器
     的 overflow / z-index 层级卷进去。

     视口钳制是**估算**（见脚本区 MENU_ESTIMATE_W/H 的说明）。

     组件保持 dumb：权限判断在调用方（Board 的 provide 里用 canRecall 闸），本组件只管
     「显示 + 派发 recall(target)」，不认识 api / store。 -->
<template>
  <teleport to="body">
    <div
      v-if="visible"
      ref="menuEl"
      class="batch-context-menu"
      :style="{ left: `${x}px`, top: `${y}px` }"
      @contextmenu.prevent
    >
      <el-menu @select="onSelect">
        <el-menu-item index="recall">召回到待下发</el-menu-item>
      </el-menu>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue';
import type { BatchCardModel } from '@/types/batchCard';

const emit = defineEmits<{
  /** 用户点了「召回到待下发」，payload 是当初 open 时记录的那张卡（同一实例）。 */
  recall: [batch: BatchCardModel];
}>();

/** 菜单项 index（`el-menu @select` 的第一参）。与后端动作名同名，便于对账。 */
const RECALL_INDEX = 'recall';

/** 视口钳制用的**估算**菜单盒模型（160×120，按单条菜单项的量级取保守值）：
 *  不去实测渲染尺寸 —— 那要在 open 之后强制回流一次再加 resize 监听，成本与收益不成
 *  比例。估算偏大时菜单在贴边处离光标稍远一点，不影响可用性。 */
const MENU_ESTIMATE_W = 160;
const MENU_ESTIMATE_H = 120;

const visible = ref(false);
const x = ref(0);
const y = ref(0);
/** 目标批次：**shallow**Ref。卡片 model 只被原样转交（emit 出去交给召回链路读
 *  batch_id / version），既不需要深层响应式追踪，也不想让存下来的对象与调用方传入的
 *  那个产生身份差异：卡片若是**裸对象**，`ref()` 会把它包成 reactive 代理，之后
 *  emit 出去的就是代理、不是渲染源里那一张卡本身（`PoolDrawer` 路径的卡片已经是响应式
 *  代理，`ref(代理)` 原样返回同一代理，那条路径上身份不变 —— 换 shallowRef 是为了把
 *  「不追踪内部字段」和「身份不变」两件事都钉死，而不是只对某一条路径成立）。 */
const target = shallowRef<BatchCardModel | null>(null);
const menuEl = ref<HTMLElement | null>(null);

let listening = false;

function attachListeners(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown, true);
}

function detachListeners(): void {
  if (!listening) return;
  listening = false;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeydown, true);
}

/** 关闭菜单并顺手摘掉 document 监听（unmount 路径另有兜底）。 */
function close(): void {
  visible.value = false;
  detachListeners();
}

/** 在鼠标坐标处开菜单。`batch` 原样存下、后续 emit 时原样交回 —— 消费方要的是
 *  batch_id 与 version 这两个卡片自带字段，不是渲染源里的某个下标。 */
function open(evt: MouseEvent, batch: BatchCardModel): void {
  target.value = batch;
  const cx = evt.clientX ?? 0;
  const cy = evt.clientY ?? 0;
  x.value = Math.max(0, Math.min(cx, window.innerWidth - MENU_ESTIMATE_W));
  y.value = Math.max(0, Math.min(cy, window.innerHeight - MENU_ESTIMATE_H));
  visible.value = true;
  attachListeners();
}

/** `el-menu @select(index, indexPath, item)` —— 只取 index，另两参用不到。 */
function onSelect(index: string): void {
  const batch = target.value;
  target.value = null;
  close();
  if (index === RECALL_INDEX && batch) emit('recall', batch);
}

/** 点菜单外部关闭：命中菜单自身（含其子节点）时不关，否则在 pointerdown 阶段
 *  （早于 click）先关掉菜单，随后的 click 就落不到菜单项上。 */
function onDocumentPointerDown(e: MouseEvent): void {
  const el = menuEl.value;
  if (el && e.target instanceof Node && el.contains(e.target)) return;
  close();
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

onBeforeUnmount(() => {
  detachListeners();
});

defineExpose({ open });
</script>

<style scoped>
/* 2026-10-06：定位容器只负责「固定定位 + 压在最上层」，**不覆写 el-menu 的任何
   视觉配置**（padding / 边框 / 宽度 / 圆角 / 字体）—— 菜单本体走 Element Plus 默认
   配置。z-index 取 3000：明显高于 EP 弹层默认的 2000 一档，右键菜单不会被
   el-dialog / el-message-box 盖住。 */
.batch-context-menu {
  position: fixed;
  z-index: 3000;
}
</style>
