// 2026-08-27 新增：包装 vue-draggable-plus 的 useDraggable，把首次绑定延后到 el ref 解析之后。
//
// 背景：useDraggable 的 immediate 选项默认 true（dist/vue-draggable-plus.js:1383），
// 内部注册 onMounted(() => start())（:1506-1508）。start() 解析 el ref，若为 null
// 会先 console.error("Root element not found")（:1470），随后**仍然**执行
// new Sortable(null, opts)（:1486）→ 抛 "el must be an HTMLElement, not [object Null]"。
//
// 本 composable 强制 immediate: false 跳过挂载期自动绑定，改由 watch 在 elRef
// 转为非 null 时调 start(el)、转回 null 时调 destroy()。
// elRef 换成新节点时同样会重绑（start 内部先 destroy 再 new）。
//
// 适用：容器在 v-if 内（PoolDrawer 的 v-if="pool"）、el-dialog destroy-on-close 后
//      重建的 tbody（PrintPreviewDialog）、EP 表格 tbody 需查询才拿得到
//      （usePartBatchPdf / ProcessStepCardList）。
// 2026-10-03：新增二参重载（不传 list），语义与实现见下方 useLazyDraggable 前的注释。

import { toValue, watch, type Ref } from 'vue';
import {
  useDraggable,
  type UseDraggableOptions,
  type UseDraggableReturn,
} from 'vue-draggable-plus';

/** 2026-10-03 新增二参重载（不传 list）。**传 list 与不传 list 是两种语义，
 *  不是写法差异**：
 *   - 传 list：vue-draggable-plus 判定 `Array.isArray(toValue(list))` 为真后，
 *     在本实例挂上内建 `onStart` / `onAdd` / `onRemove` / `onUpdate` / `onEnd`
 *     （dist/vue-draggable-plus.js 的 G 对象），其中：
 *       · onAdd    → `_t(toValue(list), evt.newDraggableIndex, item[cloneKey])`
 *                     即 `list.splice(newDraggableIndex, 0, item)`；
 *       · onRemove → `Dt(toValue(list), evt.oldDraggableIndex)`
 *                     即 `list.splice(oldDraggableIndex, 1)`。
 *     两个下标都是 Sortable 报的**可拖项下标**（`J(el, options.draggable)` 数出来的，
 *     与 DOM 下标 oldIndex / newIndex 是两套计数，容器混入 header / 空态这类非可拖
 *     子元素时二者不相等）。拿可拖项下标去索引 list，只有在「list 与可拖子元素一一
 *     对应且同序」时才成立 —— 即这套 handler 隐含的前提是 **list 就是渲染源**。
 *   - 不传 list：库把内建 handler 整个省掉（`r === null ? {} : G`），本实例只
 *     跑调用方自己挂的回调。
 *     ⚠️ 传了 list 又自己挂同名 onAdd / onRemove **挡不住内建那份** —— 库用
 *     `_n(内置G, 用户options)` 合并同名键，语义是组合（`Dn(t,e) => 先 t 再 e`：
 *     内建先跑、用户回调后跑）。这正是「传 list 有害」的关键证据：内建 splice
 *     一定会执行，用户回调只能追加动作。
 *
 *  生产队列域的投放类容器（WorkerColumn / PoolDrawer）走二参形态：Sortable 在
 *  本项目退化为**纯投放信号源** —— 被拖节点由 DOM 直接搬进目标容器，DOM 一律
 *  由 query refetch 之后的 Vue 渲染覆盖回来。挂内建 handler 只会把 Vue 不管理的
 *  数据塞进一个与渲染源不同源的数组。
 *
 *  代价：容器内**不再支持拖拽重排**（内建 onUpdate 是重排的落点，本项目 UI 本就
 *  无重排语义 —— 每次落位都是「一次写操作 + 一次失效」）。两个投放容器改用 onMove
 *  守卫直接拒掉原地重排，不留「DOM 顺序被改了却无人回滚」的幽灵状态。
 *
 *  真正的行重排场景（usePartBatchPdf / PrintPreviewDialog / ProcessStepCardList /
 *  PendingBatchesPanel）继续走三参形态。 */

/** 判别二参调用点给的是 list 还是 options：与 vue-draggable-plus 内部同一条规则
 *  （`Array.isArray(toValue(r))`）。本 wrapper 的两个重载只收**这两种形态**：
 *  二参形态的 `options` 是 plain 对象（不是 MaybeRef —— 实现里是直接展开它的，
 *  传 ref 会展开成 ref 自身的内部字段），三参形态的 `listRef` 必须是 ref。
 *  toValue 兼容「数组本体 / ref」两种写法，所以判别式不会把 options 对象误判成
 *  list（普通对象 toValue 后仍不是数组）。 */
function isListArg<T>(v: Ref<T[] | undefined> | UseDraggableOptions<T>): boolean {
  return Array.isArray(toValue(v as Ref<T[] | undefined>));
}

export function useLazyDraggable<T>(
  elRef: Ref<HTMLElement | null>,
  options?: UseDraggableOptions<T>,
): UseDraggableReturn;
export function useLazyDraggable<T>(
  elRef: Ref<HTMLElement | null>,
  listRef: Ref<T[] | undefined>,
  options?: UseDraggableOptions<T>,
): UseDraggableReturn;
export function useLazyDraggable<T>(
  elRef: Ref<HTMLElement | null>,
  listOrOptions?: Ref<T[] | undefined> | UseDraggableOptions<T>,
  maybeOptions: UseDraggableOptions<T> = {},
): UseDraggableReturn {
  // 覆写放在展开之后：即使调用方显式传了 immediate: true 也会被强制关掉。
  const inner = isListArg<T>(listOrOptions as Ref<T[] | undefined>)
    ? useDraggable(elRef, listOrOptions as Ref<T[] | undefined>, {
        ...maybeOptions,
        immediate: false,
      })
    : useDraggable(elRef, {
        ...(listOrOptions as UseDraggableOptions<T>),
        immediate: false,
      });
  // flush: 'post' 保证 DOM 已 patch 完再绑定。
  watch(
    elRef,
    (el) => {
      // 2026-10-02 补 else 分支：el 变 null = 容器已卸载（v-if 分支切走 / el-dialog
      // destroy-on-close 重建），必须 destroy。组件本身没卸载时 useDraggable 内部挂在
      // 组件上的 onBeforeUnmount(destroy) 不会跑，旧 Sortable 实例 + 已脱离文档的节点
      // 会被组件闭包一直持有到组件卸载为止。
      // elRef 换成新节点时 watch 再走非 null 分支，start() 内部本来就先 destroy 再 new，
      // 故重绑语义不变。
      if (el) inner.start(el);
      else inner.destroy();
    },
    { flush: 'post' },
  );
  return inner;
}
