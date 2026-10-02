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
// 适用：容器在 v-if 内（PoolDrawer）、el-dialog destroy-on-close 后重建的 tbody
//      （PrintPreviewDialog）、EP 表格 tbody 需查询才拿得到（usePartBatchPdf）。
// 不适用：容器在挂载时已存在的场景（WorkerColumn、useColumnDrag.applyDrag），直接用 useDraggable 即可。

import { watch, type Ref } from 'vue';
import {
  useDraggable,
  type UseDraggableOptions,
  type UseDraggableReturn,
} from 'vue-draggable-plus';

export function useLazyDraggable<T>(
  elRef: Ref<HTMLElement | null>,
  listRef: Ref<T[] | undefined>,
  options: UseDraggableOptions<T> = {},
): UseDraggableReturn {
  // 覆写放在展开之后：即使调用方显式传了 immediate: true 也会被强制关掉。
  const inner = useDraggable(elRef, listRef, { ...options, immediate: false });
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
