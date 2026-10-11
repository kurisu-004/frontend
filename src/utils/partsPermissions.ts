// src/utils/partsPermissions.ts
//
// 零件域权限 helper（2026-10-03 新增，2026-10-14 改判据）。
//
// 形态对齐 src/utils/deliveryNotePermissions.ts：函数签名收一个角色 map，视图层把角色
// 判定结果传进来。跨域复用（报工台图纸预览 / 零件详情文件页 / 零件一览打印）。
//
// ⚠️ **判据已从「角色枚举」迁到「权限点」（2026-10-14，RBAC 控制面板）**：本文件现在
// 直接读 auth store 的 `hasPermission('part.drawing.print')`。
//
// 为什么迁：角色与「能不能做这件事」从此**不再一一对应**。管理员可以在 RBAC 面板给
// 自建角色（`QC_LEAD` 之类）单独授予「零件图纸打印」，也可以从 MANAGER 手里收回它。
// 继续按角色判 ⇒ 前端显示的入口与后端实际放行的集合必然分叉，而**分叉的两个方向都很贵**：
//   - 闸门比后端宽 → 按钮可见，点下去吃 403；
//   - 闸门比后端窄 → 后端允许的角色在前端看不到入口（管理员明明配了却用不了，且无报错）。
// 后端把「谁能打印图纸」收敛成权限点 `part.drawing.print` 之后，前端跟着读同一个码，
// 两边才是同一份数据。
//
// ⚠️ **签名一字不改**（消费方 `PartDrawingPreviewDialog.vue` / `PartFilesTabsCard.vue`
// 仍按原样传角色 map，调用形态未变、只有注释订正）：形参保留是为了不改调用方，而它已经
// **不再参与判定**。⚠️ 部署顺序：后端必须先上 —— 旧后端的 `/iam/me` 不返 `permissions`，
// 闸门恒为 false ⇒ 图纸下载/打印入口全员消失。
//
// ADMIN 元角色在 `hasPermission` 里有通配短路（见 stores/auth.ts），故纯 ADMIN 账号
// 不受本文件影响。

import { useAuthStore } from '@/stores/auth';

/** 放行图纸打印 / 下载的权限点（与后端 RBAC 面板里的 `part.drawing.print` 逐字一致）。 */
export const PART_DRAWING_PRINT_PERMISSION = 'part.drawing.print';

export interface PartRoleMapLike {
  MANAGER?: boolean;
  CLERK?: boolean;
  INSPECTOR?: boolean;
  CNC_PROGRAMMER?: boolean;
}

/** 单件图纸打印入口是否可见（后端放行「持有 `part.drawing.print` 权限点」的角色）。
 *
 *  ⚠️ 形参 `role` **保留但不再参与判定**（签名不改，消费方零改动）：角色只是权限点的
 *  来源之一，`hasPermission` 已经把「谁拥有这个权限点」算完了。 */
export function canPrintPartDrawing(role: PartRoleMapLike): boolean {
  void role;
  return useAuthStore().hasPermission(PART_DRAWING_PRINT_PERMISSION);
}

/**
 * 图纸文件下载入口是否可见（`GET /files/objects/{id}/url` 的前端闸门）。
 *
 * 与 `canPrintPartDrawing` **共用同一个权限点**（逐字相同）：后端
 * `PartFileService::get_file_with_url` 与零件图纸打印端点共用同一个
 * `require_permission("part.drawing.print")` 闸门（默认授权矩阵与打印矩阵逐格相同，
 * 由管理员在 RBAC 面板维护）。
 * ⚠️ 这个权限点的**默认矩阵不含**报工台 HMI（SHELF_ACCOUNT）：后端 part_file 的列表 /
 * content 对它放开了（工控机预览图纸打的就是这两条），而 `/files/objects/{id}/url`
 * 没跟着放开 —— 它回的是 COS 预签直链（1 小时有效），拿到即可脱离本后端直接访问、
 * 直链可外发；工控机看图纸走 content（后端代理、逐次过 RBAC）就够了。所以前端三页图纸
 * 预览弹窗的「下载文件」按钮必须对未授予该权限点的账号隐藏，否则就是「可见但必 403」。
 *
 * ⚠️ 已知代价（产品已拍板的取舍，不是 bug）：非 PDF 图纸（HEIC / STEP / DWG 等）在
 * 预览弹窗里**只有下载这一条路**，工控机上将完全看不到这类图纸 —— PDF / 图片仍走
 * content 正常预览。不要为了补这个死角而偷偷放开 `/url`，那等于把 1 小时的 COS 读
 * 权限发给车间工位。
 *
 * ⚠️ 形参 `role` 保留但不再参与判定（同 `canPrintPartDrawing` 的说明）。
 */
export function canDownloadPartFile(role: PartRoleMapLike): boolean {
  void role;
  return useAuthStore().hasPermission(PART_DRAWING_PRINT_PERMISSION);
}
