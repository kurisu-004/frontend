// 2026-08-27 新增：包装 vue-draggable-plus 的 useDraggable，把首次绑定延后到 el ref 解析之后。
//
// 背景：useDraggable 的 immediate 选项默认 true（dist/vue-draggable-plus.js:1383），
// 内部注册 onMounted(() => start())（:1506-1508）。start() 解析 el ref，若为 null
// 会先 console.error("Root element not found")（:1470），随后**仍然**执行
// new Sortable(null, opts)（:1486）→ 抛 "el must be an HTMLElement, not [object Null]"。
//
// 本 composable 强制 immediate: false 跳过挂载期自动绑定，改由 watch 在 elRef
// 转为非 null 时调 start(el)。elRef 换成新节点时同样会重绑（start 内部先 destroy 再 new）。
//
// 适用：容器在 v-if 内（PoolDrawer）、el-dialog destroy-on-close 后重建的 tbody
//      （PrintPreviewDialog）、EP 表格 tbody 需查询才拿得到（usePartBatchPdf）。
// 不适用：容器在挂载时已存在的场景（WorkerColumn、useColumnDrag.applyDrag），直接用 useDraggable 即可。

import { watch, type Ref } from 'vue'
import {
  useDraggable,
  type UseDraggableOptions,
  type UseDraggableReturn,
} from 'vue-draggable-plus'

export function useLazyDraggable<T>(
  elRef: Ref<HTMLElement | null>,
  listRef: Ref<T[] | undefined>,
  options: UseDraggableOptions<T> = {},
): UseDraggableReturn {
  // 覆写放在展开之后：即使调用方显式传了 immediate: true 也会被强制关掉。
  const inner = useDraggable(elRef, listRef, { ...options, immediate: false })
  // flush: 'post' 保证 DOM 已 patch 完再绑定。
  watch(elRef, (el) => { if (el) inner.start(el) }, { flush: 'post' })
  return inner
}
