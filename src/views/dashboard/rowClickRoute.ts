// dashboard 交期面板「点行去哪」的分流判据（2026-10-10 抽出）。
//
// 为什么抽成纯函数：交期面板的行是**工单级**的（装配件替换其子件行出现），一行
// 该开零件预览弹窗还是子件列表弹窗、以及角色能不能点开，都由这一处决定。放在
// DashboardView 的模板期逻辑里时它只能靠「手点 dashboard」验证 —— 抽成纯函数后
// 三条分支（零件行 / 装配件行且有权 / 装配件行且无权）各有一条断言。
//
// 两个分支的权限口径**刻意不对称**，理由记在这里而不是散落在调用点：
//   - 装配件行要开子件列表弹窗，列表内容是零件明细（图纸 / 批次 / 交期），故要过
//     `canOpenPartDetail` 这道角色闸门 —— 与 `GET /assemblies/{id}` 的后端闸门
//     （Manager / Clerk / Inspector / CncProgrammer）同集合，前端先挡一层是为了不
//     让无权用户点出「点了没反应」的错觉体验。
//   - 零件行进 PartPreviewDialog 是**既有行为**（该弹窗的数据读取端点自己管权限，
//     且历史上前面板行点击就没设门）。本函数保持原样，不借这次改动扩大或收窄它。
//     ⇒ 两侧不对称是被记录的取舍，不是漏写。

import type { SystemDeliveryOrderData } from './composables/dashboardSnapshotSchema';

/** 交期面板行的点击去向。`blocked` = 无权点开，调用方应静默忽略（不弹任何东西）。 */
export type RowClickRoute = 'preview' | 'children' | 'blocked';

/**
 * 2026-10-10：交期面板行点击分流。
 *
 * @param item 服务端分桶后的行（`row_type` 判定零件行 / 装配件行）
 * @param canOpenPartDetail 调用方的角色闸门（SHELF_ACCOUNT 为 false）
 * @returns `'preview'` 进零件预览弹窗 / `'children'` 进子件列表弹窗 / `'blocked'` 不可点
 */
export function routeRowClick(
  item: Pick<SystemDeliveryOrderData, 'row_type'>,
  canOpenPartDetail: boolean,
): RowClickRoute {
  if (item.row_type !== 'ASSEMBLY') return 'preview';
  return canOpenPartDetail ? 'children' : 'blocked';
}
