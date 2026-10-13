// src/utils/printTemplatePermissions.ts
//
// 送货单打印模板域的按钮级闸门（2026-10-16 新增）。形态对齐
// `src/utils/deliveryNotePermissions.ts` 与 `src/utils/partsPermissions.ts`：函数内部读
// auth store 的 `hasRole` / `hasPermission`，视图层只拿布尔值。
//
// ⚠️ **本域的判据是「角色」而不是「权限点」，这是与上面两个文件刻意不同的地方**，不要
// 「顺手统一」：
//   - 后端 `/api/v2/print-templates` 的列表 / 上传 / 软删三条端点都是 handler 层
//     `require_role(Role::Manager)`，**RBAC 面板里没有任何 `print_template.*` 权限点**；
//   - 前端自造一个权限点（哪怕后端将来加种子）就会立刻造出「前端比后端宽 / 窄」的分叉，
//     而两个方向都贵：宽了就是「按钮可见、点下去吃 403」，窄了就是「管理员配了却用不了」。
//     本域既然**当前**与后端逐格一致（都认 MANAGER），照抄角色就是最短路径，也没有可分叉
//     的空间。将来后端真的加了权限点，这里再改判据、并同步改后端种子。
//
// ⚠️ **页面的入口可见性不在这里**：那由路由守卫的 `meta.menuCode = 'print_templates_designer'`
// 单查菜单树决定（见 `src/router/index.ts`），守卫与本文件是**两个不同的问题** ——
// 守卫管「能不能进这个页面」，本文件管「页面上哪些按钮可点」。两者都成立才有效。
//
// ADMIN 元角色在 `hasRole` 里有通配短路（见 `stores/auth.ts`），故纯 ADMIN 账号对本文件
// 的判定恒为 true，与后端 `require_role` 的 ADMIN 处理保持一致。

import { useAuthStore } from '@/stores/auth';

/** 本域三条 MANAGER 独占端点对应的角色（与后端 `require_role(Role::Manager)` 逐字一致）。 */
export const PRINT_TEMPLATE_MANAGE_ROLE = 'MANAGER';

/**
 * 模板管理页的写操作（上传 / 软删）是否可点。
 *
 * 下载不设闸：模板字节的取用走 `delivery_note.print` 权限点（与打印入口同一个码，后端
 * `GET /{id}/content` 的判据），而管理页本身已经被 `menuCode` 闸在 MANAGER 之外 ——
 * 能进本页的人本来就能下载，再加一道只会让同一个人被两个判据卡住。
 */
export function canManagePrintTemplates(): boolean {
  return useAuthStore().hasRole(PRINT_TEMPLATE_MANAGE_ROLE);
}
