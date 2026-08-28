// Element Plus el-table DOM 工具。
//
// 2026-08-27 修订：列顺序拖动从「绑 <thead>」改为「绑表头 <tr>」（vue-draggable-plus
// 官方 demo 的写法：sortablejs 的可排序子元素得是 <th>，绑 <thead> 会变成「整行
// 可拖」）。新增 findElTableHeaderRow 返回 <tr>。
//
// 集中 selector 在这里：避免 spread 到各 composable 内部；改 EP 版本时只动一处。

/** el-table 实际渲染出的 tbody selector（EP 内部结构约定）。 */
const EL_TABLE_TBODY_SELECTOR = '.el-table__body-wrapper .el-table__body > tbody'

/** el-table 实际渲染出的 thead selector（EP 内部结构约定）。
 *  2026-08-27 修订：仅作为「表头行容器」解析的入口；列拖动绑 tr，不再绑 thead。 */
const EL_TABLE_THEAD_SELECTOR = '.el-table__header-wrapper table thead'

/** 2026-08-28 新增：表头区域外层 div。useColumnDrag 在它身上挂 MutationObserver，
 *  监听数据从「空数组」变为「有数据」时 EP 重建表头 DOM 的瞬间，避免一次性绑定失效。 */
const EL_TABLE_HEADER_WRAPPER_SELECTOR = '.el-table__header-wrapper'

/** 消费方在表头叶子列 <th> 上挂的拖拽手柄类名（与 useColumnDrag.handle 默认值一致）。 */
const EL_TABLE_DRAG_HANDLE_CLASS = '.col-drag-handle'

/** 从 el-table 组件实例（或其 $el 容器）解析出 EP 渲染的 tbody DOM 节点。
 *  找不到返回 null（表格未挂载 / 容器已卸载）。 */
export function findElTableTbody(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  return el.querySelector(EL_TABLE_TBODY_SELECTOR) as HTMLElement | null
}

/** 从 el-table 组件实例（或其 $el 容器）解析出 EP 渲染的「表头外层 wrapper」DOM 节点。
 *
 *  2026-08-28 新增：useColumnDrag 自愈重绑用 — 在 wrapper 上挂 MutationObserver
 *  监听 EP 重建表头 DOM 的瞬间。找不到返回 null（表格未挂载 / 容器已卸载）。 */
export function findElTableHeaderWrapper(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  return el.querySelector(EL_TABLE_HEADER_WRAPPER_SELECTOR) as HTMLElement | null
}

/** 从 el-table 组件实例（或其 $el 容器）解析出 EP 渲染的「表头行」<tr> DOM 节点。
 *
 *  2026-08-27 修订：列拖动需要 sortablejs 的可排序子元素是 <th>，因此返回的是
 *  <thead> 里的 <tr>（vue-draggable-plus 官方 table-column demo 即此写法）。
 *
 *  解析策略（兼容单级 + 多级表头）：
 *  1. 取 `.el-table__header-wrapper table thead`；
 *  2. 优先返回**包含 `.col-drag-handle` 的那个 tr**（多级表头场景下，叶子列在第二行，
 *     handle 一定挂在叶子列 <th> 上 → 该 <th> 所在的 <tr> 才是真正可拖的行）；
 *  3. 找不到 handle 时回退到 thead 里的**第一个 tr**（单级表头 / handle 尚未挂上的
 *     中间状态，仍能保证 sortablejs 拿到一个 <tr> 容器）；
 *  4. 都找不到返回 null（表格未挂载 / 容器已卸载 / 列被全隐藏）。
 */
export function findElTableHeaderRow(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  const thead = el.querySelector(EL_TABLE_THEAD_SELECTOR) as HTMLElement | null
  if (!thead) return null
  const rows = thead.querySelectorAll('tr')
  for (const tr of Array.from(rows)) {
    if (tr.querySelector(EL_TABLE_DRAG_HANDLE_CLASS)) return tr as HTMLElement
  }
  return (rows[0] as HTMLElement | undefined) ?? null
}