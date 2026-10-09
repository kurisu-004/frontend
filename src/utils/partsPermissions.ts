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
//
// 图纸**下载**入口（`canDownloadPartFile`）的前端放行集合与打印**相同**（同 4 角色）——
// 两者都只对应「回 COS 预签直链」那一条端点。不同的是**后端** part_file 的另外两条：
// 列表 `GET /part-files` 与内容 `GET /part-files/{id}/content` 对 SHELF_ACCOUNT 放开了
// （报工台工控机的图纸预览打的就是这两条），而 `/part-files/{id}/url` **刻意没放开**
// —— 它回的是 COS 预签直链（1 小时有效），拿到即可脱离本后端直接访问、直链可外发；
// 工控机看图纸走 content（后端代理、逐次过 RBAC）就够了。所以前端三页图纸预览弹窗的
// 「下载文件」按钮必须对 SHELF_ACCOUNT 隐藏，否则就是「可见但必 403」。

export interface PartRoleMapLike {
  MANAGER?: boolean;
  CLERK?: boolean;
  INSPECTOR?: boolean;
  CNC_PROGRAMMER?: boolean;
}

/** 单件图纸打印入口是否可见（后端放行 4 角色）。
 *
 *  SHELF_ACCOUNT 不在放行集合内——这个接口只认上面 4 个键，所以「排除 SHELF_ACCOUNT」
 *  的负向保障就是它压根不是一个键：纯货架账号传进来只会得到全 undefined / 全 false，
 *  自然落到 false 分支。 */
export function canPrintPartDrawing(role: PartRoleMapLike): boolean {
  return Boolean(role.MANAGER || role.CLERK || role.INSPECTOR || role.CNC_PROGRAMMER);
}

/**
 * 图纸文件下载入口是否可见（`GET /part-files/{id}/url` 的前端闸门，2026-10-11 新增）。
 *
 * 放行集合与 `canPrintPartDrawing` **逐字相同**（Manager / Clerk / Inspector /
 * CncProgrammer），与后端 `PartFileService::get_file_with_url` 的
 * `require_any_role` 白名单一一对应。**刻意不含 SHELF_ACCOUNT**：后端这一条没跟着
 * 列表 / content 一起放开（直链可外传，工控机不需要）。
 *
 * ⚠️ 已知代价（产品已拍板的取舍，不是 bug）：非 PDF 图纸（HEIC / STEP / DWG 等）在
 * 预览弹窗里**只有下载这一条路**，工控机上将完全看不到这类图纸 —— PDF / 图片仍走
 * content 正常预览。不要为了补这个死角而偷偷放开 `/url`，那等于把 1 小时的 COS 读
 * 权限发给车间工位。
 */
export function canDownloadPartFile(role: PartRoleMapLike): boolean {
  return Boolean(role.MANAGER || role.CLERK || role.INSPECTOR || role.CNC_PROGRAMMER);
}
