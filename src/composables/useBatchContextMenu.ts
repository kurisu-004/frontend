// 2026-10-09 新建：批次卡片的右键操作菜单 —— 跨看板共享（生产队列三区 + 外协两区），
// 走 `@imengyu/vue3-context-menu` 的**函数模式**（`ContextMenu.showContextMenu`）。
//
// 为什么是「一个函数 + 板级 provide」而不是板级挂一个菜单组件：
//   - 库在函数模式下把菜单挂到 body 上一个**模块级单例容器**（id
//     `mx-menu-default-container`、class `mx-menu-ghost-host`），每次 show 都往里 render
//     一棵新 vnode。不存在「板级模板里挂一个组件实例、卡片侧拿 ref 调 open()」这条路径，
//     也不需要维护「当前被右键的是哪张卡」的组件内状态 —— 菜单项由板级在**右键那一刻**
//     派生，闭包里直接带着那张卡的全部锚。
//   - 派生函数（`buildQueueBatchMenuItems` / `buildOutsourceBatchMenuItems`）是纯函数，
//     与权限、目标集、批次状态解耦，可直接单测派生矩阵。
//
// 本文件**保持 dumb**：不认识任何动作、不 import api / store / router。区域枚举
// `BatchArea` 与 opener 签名 `BatchMenuOpener` 是这里唯一的公共契约；菜单项由各板级
// 的派生函数给出。
//
// ⚠️ 为什么**绝对不能**用任何组件去「包裹」BatchCard：
//   BatchCard 是 Sortable 的可拖项，硬不变式是「可拖元素 == vnode 的 DOM footprint」
//   （见 CLAUDE.md「拖拽投放（Sortable）」，守卫 src/components/__tests__/
//   BatchCardDndFootprint.spec.ts）。Sortable 搬的是 `evt.item` 这一个节点、Vue 卸载
//   时只认 `vnode.el`：
//     - `<el-dropdown trigger="contextmenu">` 包住 BatchCard ⇒ 根变成
//       `createElementBlock('div', { class: 'el-dropdown' })` 这个硬包裹 div，Sortable
//       的 evt.item 变成它，而 `evt.item.dataset.batchId` 恒 undefined
//       ⇒ PoolDrawer.onDragStart / WorkerColumn.onDragStart 断链，整条 POOL↔WORKER
//       拖拽直接失效；
//     - `el-tooltip` / `el-popover` 包根 ⇒ 同类事故（teleport 占位注释混进 Sortable
//       容器 + Fragment 锚点残留），BatchCard 自身也是因此才把 tooltip 缩到根内部的
//       .card-body 上。
//   结论：右键能力只能挂在**卡片根部**上（BatchCard 是 inheritAttrs:false +
//   v-bind="$attrs"，onContextmenu 原样落在根 div，零新增 DOM 节点），菜单本体必须
//   待在 Sortable 容器之外 —— 即库那个 body 级容器，它与任何 Sortable 容器的
//   overflow / z-index 层级零关系。
//
// 外观：库**原生**主题（`theme: 'default'`），零 CSS 覆盖 —— 不传 `customClass`、
// 不写 `--mx-menu-*` 变量。亮色主题就叫 `default`（库里没有 `light` 这个名字）。
// 库样式必须单独 import（见 main.ts），它不随组件按需注入。

import { nextTick } from 'vue';
import ContextMenu from '@imengyu/vue3-context-menu';
import type { MenuItem } from '@imengyu/vue3-context-menu';
import type { BatchCardModel } from '@/types/batchCard';

/** 卡片所在的看板区域 —— 菜单项矩阵的唯一分组键。
 *
 *  区域由**容器**决定（每个投放 / 卡片容器把自己的区域常量硬编码在右键回调里），不是
 *  从卡片数据反推的：同一张卡在「工序候选池」与「工人列」上可执行的动作集合不同，
 *  而这两种场景的批次数据字段集完全一样，数据侧无从分辨。 */
export type BatchArea =
  /** 生产队列「待下发」池 */
  | 'pending'
  /** 生产队列工序候选池 */
  | 'pool'
  /** 生产队列工人列 */
  | 'worker'
  /** 外协可发送候选池 */
  | 'outsource-candidate'
  /** 外协公司列（在途） */
  | 'outsource-company';

/** 板级 provide 的右键 opener 签名。
 *
 *  消费方（五个容器）一律带 **noop 缺省** inject：拿不到 provider 时右键无反应，
 *  绝不炸事件回调。 */
export type BatchMenuOpener = (evt: MouseEvent, batch: BatchCardModel, area: BatchArea) => void;

/** 在光标处打开右键菜单。
 *
 *  返回 Promise 是因为**打开动作必须串行化**（见下面 `closeContextMenu()` 那三行），
 * 调用方无需 await（本仓两个板级都当 fire-and-forget 用），但签名保留 Promise 以便
 * 未来在开菜单前后挂动作、以及测试里 `await` 它断言时序。 */
export async function showBatchContextMenu(evt: MouseEvent, items: MenuItem[]): Promise<void> {
  // ★ 必须先关：库复用同一个 body 级容器（id `mx-menu-default-container`、class
  //   `mx-menu-ghost-host`），上一个菜单的收尾会 `render(null, container)` 把**紧接着
  //   打开的新菜单一起抹掉**（库 issue #123 未修）。看板是逐卡右键的高频场景，不串行化
  //   就会稳定复现「右键 A 再右键 B，第二次菜单根本不出现」。
  //
  //   2026-10-09 校准机制（此前那段注释把因果写反了，勿照它去「加固」）：`closeContextMenu()`
  //   里的 `closeAnimFinished` 在**未设 `menuTransitionProps`** 时**同步** emit，处理函数就是
  //   `render(null, container)` ⇒ 这行返回时容器已被同步清空、旧子树已 unmount，那条
  //   `Transition onAfterLeave` 根本不会跑到。所以 `closeContextMenu()` **本身就是**修复，
  //   下面那个 `nextTick()` 只是无害双保险 —— 不要拿 `setTimeout` 之类去「等更久」，那是在
  //   修一个不存在的竞态。残余竞态不存在：微任务窗口内两次右键无法交错。
  ContextMenu.closeContextMenu();
  // 无害双保险：与上面的同步清空重叠，不引入额外时序假设。
  await nextTick();
  ContextMenu.showContextMenu({
    x: evt.clientX,
    y: evt.clientY,
    theme: 'default',
    // 库默认 100；Element Plus 弹层（dialog / message-box / popper）从 2000 起，
    // 不抬高一级菜单会被这些浮层盖住。
    zIndex: 3000,
    // 宽度下限对齐自研旧菜单的量级；maxHeight 给「发送到」的长二级菜单（工序 / 工人 /
    // 外协公司都可能几十项）一个滚动上限，目标过多时靠它滚动而不是自己截断列表。
    minWidth: 180,
    maxHeight: 420,
    // 默认 false ⇒ 滚轮滚的是底下的看板（连带触发菜单关闭）而不是二级菜单。
    // ⚠️ 不要开 `mouseScroll`：它只在 `ContextMenuDefine.d.ts` 里有声明，两个产物
    //   （lib/vue3-context-menu.es.js / .umd.js）里都搜不到实现，传了是幽灵参数。
    //   二级菜单靠上面那个 maxHeight 滚动。
    // 默认 true ⇒ 任何滚动都关菜单；看板上 Sortable 拖到边缘会自动滚动，会误关菜单。
    closeWhenScroll: false,
    // 默认 true ⇒ 库在 document 上 capture 方向键 / Home / End / Enter 并 preventDefault，
    // 会吃掉看板自己的快捷键。⚠️ 代价：库的 **Escape 处理整体挂在那个 keydown 监听里**，
    // 关掉它就没有任何 Escape 关闭路径了 —— 关闭只剩「点菜单项」与「点菜单外部」两条。
    // 取舍：看板的键盘操作比 Escape 关闭更重要（右键是偶发动作、方向键是日常），故保留关。
    keyboardControl: false,
    // 默认 200ms（仅「切换到另一个已开二级」时才等，首个二级其实瞬开）。看板的操作员
    // 是「扫一眼 → 选目标 → 提交」，二级菜单的等待只会被读成卡顿。
    subMenuOpenDelay: 0,
    items,
  });
}
