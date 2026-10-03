// 零件域权限 helper（2026-10-03 新增）。
//
// 形态对齐 src/utils/deliveryNotePermissions.ts：只放纯函数，视图层把角色 map 传进来。
// 角色取值来源统一是 `usePermissions()`（内部读 auth store 的 hasRole），本文件不做
// 任何 store 访问，便于直接单测。
//
// 图纸打印（单件 + 批量）放行集合：MANAGER / CLERK / INSPECTOR / CNC_PROGRAMMER，
// **不含 SHELF_ACCOUNT**——与后端 rust v2 转发端点的 require_any_role 白名单一致。
// 前端闸门必须与后端同集合，否则两类不一致同时出现：
// - 闸门比后端宽 → 按钮可见但点下去 403；
// - 闸门比后端窄 → 后端允许的角色在前端看不到入口。
//
// 批量打印入口（零件一览页）的闸门是 MANAGER || CLERK，是本集合的子集，不会 403。

export interface PartRoleMapLike {
  MANAGER?: boolean;
  CLERK?: boolean;
  INSPECTOR?: boolean;
  CNC_PROGRAMMER?: boolean;
  /** 不在放行集合内；显式列出来是为了让调用方能直接把整份角色 map 传进来，
   *  而不必为了「多一个键」去断言类型。 */
  SHELF_ACCOUNT?: boolean;
}

/** 单件图纸打印入口是否可见（后端放行 4 角色，排除 SHELF_ACCOUNT）。 */
export function canPrintPartDrawing(role: PartRoleMapLike): boolean {
  return Boolean(role.MANAGER || role.CLERK || role.INSPECTOR || role.CNC_PROGRAMMER);
}
