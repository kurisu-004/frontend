<!-- src/components/BatchContextMenu.vue
     批次卡片的右键操作菜单（共享组件，2026-10-08 从生产队列域升上来）。
     挂在看板顶层、整页单例；卡片侧只挂一个 `@contextmenu.prevent` 并经 provide/inject
     把 (事件, 卡片) 交给板级 opener。

     菜单项由调用方经 `items` prop 配置，组件只管「显示 + 派发 select(key, batch)」，
     **不认识任何具体动作**：生产队列的「召回到待下发」与外协看板的收发动作各自在板级
     决定自己有哪些项（无权角色给空数组即可）。

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

     视口钳制是**估算**（见脚本区 MENU_ESTIMATE_W / menuHeight 的说明）。

     组件保持 dumb：权限判断全在调用方（按动作过滤 items），不认识 api / store。 -->
<template>
  <teleport to="body">
    <div
      v-if="visible && items.length > 0"
      ref="menuEl"
      class="batch-context-menu"
      :style="{ left: `${x}px`, top: `${y}px` }"
      @contextmenu.prevent
    >
      <el-menu @select="onSelect">
        <el-menu-item
          v-for="item in items"
          :key="item.key"
          :index="item.key"
          :class="{ 'is-danger': item.danger }"
        >
          {{ item.label }}
        </el-menu-item>
      </el-menu>
    </div>
  </teleport>
</template>

<script lang="ts">
/** 单条菜单项：`key` 是动作标识（emit 出去的第一参，调用方按它分发），
 *  `label` 是文案，`danger` 标 destructive 动作（EP 的 el-menu-item 没有 danger
 *  prop，红字由样式区的 `.is-danger` 给）。
 *
 *  声明在普通 `<script>` 块里（`<script setup>` 不允许 export）：调用方需要 import
 *  这个类型来给 `items` 赋值。 */
export interface BatchContextMenuItem {
  key: string;
  label: string;
  danger?: boolean;
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { BatchCardModel } from '@/types/batchCard';

const props = defineProps<{
  /** 菜单项。**空数组 = 不渲染任何菜单**（调用方用它表达「本角色无任何可执行动作」，
   *  组件自己不判权限）。 */
  items: BatchContextMenuItem[];
}>();

const emit = defineEmits<{
  /** 用户点了某一项：第一参是该项的 key，第二参是当初 open 时记录的那张卡
   *  （**同一实例**，消费方要的是卡片自带的 batch_id / version）。 */
  select: [key: string, batch: BatchCardModel];
}>();

/** 视口钳制用的**估算**菜单盒模型。宽取 160（按最长一项文案的量级保守取值）；
 *  高按条目数算：`项高 40px × 条数 + 上下内边距`。不去实测渲染尺寸 —— 那要在 open
 *  之后强制回流一次再加 resize 监听，成本与收益不成比例。估算偏大时菜单在贴边处离
 *  光标稍远一点，不影响可用性。 */
const MENU_ESTIMATE_W = 160;
/** 单条菜单项的行高（含 el-menu-item 的上下 padding），与 EP 默认字号下的实际高度
 *  同量级。 */
const MENU_ITEM_H = 40;
/** 菜单上下内边距（el-menu 自带的 padding 量级）。 */
const MENU_PADDING_H = 16;

const visible = ref(false);
const x = ref(0);
const y = ref(0);
/** 目标批次：**shallow**Ref。卡片 model 只被原样转交（emit 出去交给调用方的写链路读
 *  batch_id / version），既不需要深层响应式追踪，也不想让存下来的对象与调用方传入的
 *  那个产生身份差异：卡片若是**裸对象**，`ref()` 会把它包成 reactive 代理，之后
 *  emit 出去的就是代理、不是渲染源里那一张卡本身（`PoolDrawer` 路径的卡片已经是响应式
 *  代理，`ref(代理)` 原样返回同一代理，那条路径上身份不变 —— 换 shallowRef 是为了把
 *  「不追踪内部字段」和「身份不变」两件事都钉死，而不是只对某一条路径成立）。 */
const target = shallowRef<BatchCardModel | null>(null);
const menuEl = ref<HTMLElement | null>(null);

/** 本次开菜单的估算高度（按当前 items 条数现算：open 之后调用方改 items 时，
 *  下一次 open 自然是新的条数）。 */
const menuHeight = computed<number>(
  () => props.items.length * MENU_ITEM_H + MENU_PADDING_H,
);

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
  y.value = Math.max(0, Math.min(cy, window.innerHeight - menuHeight.value));
  visible.value = true;
  attachListeners();
}

/** `el-menu @select(index, indexPath, item)` —— 只取 index（= 调用方给的 key），
 *  另两参用不到。
 *
 *  顺序：先取目标卡 → 关闭 → 清 target → 派发。**取卡必须在清 target 之前**：
 *  emit 出去的是「谁被点了 + 对应哪张卡」，先清就只剩 key 没有卡可发，调用方只能靠
 *  自己去别处反查 batch_id（而卡片可能已经从渲染源里卸载）。 */
function onSelect(index: string): void {
  const batch = target.value;
  close();
  target.value = null;
  if (batch) emit('select', index, batch);
}

/** 点菜单外部关闭：命中菜单自身（含其子节点）时不关，否则在 pointerdown 阶段
 * （早于 click）先关掉菜单，随后的 click 就落不到菜单项上。 */
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
/* destructive 项标红（el-menu-item 没有 danger prop，只能自己上色）。走 :deep 是因为
   .el-menu-item 是 el-menu 的内部元素、拿不到本组件的作用域属性。 */
.batch-context-menu :deep(.el-menu-item.is-danger) {
  color: var(--el-color-danger);
}
</style>
