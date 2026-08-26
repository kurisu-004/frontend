// Element Plus el-table DOM 工具。
//
// 2026-08-27 新增：vue-draggable-plus 的 useDraggable composable 在 setup 阶段
// 绑定一次目标 tbody；EP 重建 tbody 后必须手动 start() 重绑，因此 usePartBatchPdf
// 把 el-table 组件实例 ref 通过 provide 传出去，watch tableRef 变化重新 query tbody。
//
// 集中 selector 在这里：避免 spread 到各 composable 内部；改 EP 版本时只动一处。

/** el-table 实际渲染出的 tbody selector（EP 内部结构约定）。 */
const EL_TABLE_TBODY_SELECTOR = '.el-table__body-wrapper .el-table__body > tbody'

/** 从 el-table 组件实例（或其 $el 容器）解析出 EP 渲染的 tbody DOM 节点。
 *  找不到返回 null（表格未挂载 / 容器已卸载）。 */
export function findElTableTbody(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  return el.querySelector(EL_TABLE_TBODY_SELECTOR) as HTMLElement | null
}
