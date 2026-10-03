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
// 适用：容器在 v-if 内（PoolDrawer / WorkerColumn）、el-dialog destroy-on-close 后
//      重建的 tbody（PrintPreviewDialog）、EP 表格 tbody 需查询才拿得到
//      （usePartBatchPdf / ProcessStepCardList）。

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
 *     （dist/vue-draggable-plus.js 的 G 对象），其中 onAdd / onRemove 的实现是
 *     `list.value.splice(newDraggableIndex, 0, item[cloneKey])` 之类 —— 它假定
 *     **list 就是渲染源**。
 *   - 不传 list：库把内建 handler 整个省掉（`r === null ? {} : G`），本实例只
 *     跑调用方自己挂的回调。
 *
 *  生产队列域的投放类容器（WorkerColumn / PoolDrawer）走二参形态：Sortable 在
 *  本项目退化为**纯投放信号源** —— 被拖节点由 DOM 直接搬进目标容器，DOM 一律
 *  由 query refetch 之后的 Vue 渲染覆盖回来。挂内建 handler 只会把 Vue 不管理的
 *  数据塞进一个与渲染源不同源的数组（且内建 onRemove 用 `from.children[oldIndex]`
 *  按 DOM 下标回插，容器里混入 header / 空态就永久错位）。
 *
 *  代价：容器内**不再支持拖拽重排**（内建 onUpdate 是重排的落点）。本项目 UI 本就
 *  无重排语义 —— 每次落位都是「一次写操作 + 一次失效」，零功能损失。
 *
 *  真正的行重排场景（usePartBatchPdf / PrintPreviewDialog / ProcessStepCardList /
 *  PendingBatchesPanel）继续走三参形态。 */

/** 判别二参调用点给的是 list 还是 options：与 vue-draggable-plus 内部同一条规则
 *  （`Array.isArray(toValue(r))`）—— options 传 MaybeRef 时也可能是 ref，但它的
 *  .value 是普通对象而非数组，不会被误判。 */
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
