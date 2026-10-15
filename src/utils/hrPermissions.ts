// src/utils/hrPermissions.ts
//
// 人事排班日历页的**按钮级**闸门（2026-10-19 新增）。形态对齐
// `src/utils/printTemplatePermissions.ts`（最简范本）：函数内部读 auth store 的
// `hasPermission`，视图层只拿布尔值。
//
// ⚠️ **本域的判据是「权限点」而不是「角色」**：后端 `/api/v2/hr/*` 的读端点挂 `hr.view`、
// 写端点挂 `hr.schedule.manage`，RBAC 面板里有这两个码、也能按角色授予。业务口径是
// **MANAGER 写、CLERK 只读**（种子按角色授权时就按这条给），但**判据写权限点**：权限点能
// 被单独授予与回收，改判据的唯一场合是后端真的换掉了权限点。
//
// ⚠️ **页面入口的可见性不在这里**：那由路由守卫的 `meta.menuCode = 'hr_schedule_calendar'`
// 单查菜单树决定（见 `src/router/index.ts`）。守卫与本文件是**两个不同的问题**——守卫管
// 「能不能进这个页面」，本文件管「页面上哪些按钮可点」，两者都成立才有效。
//
// ⚠️ **ADMIN 元角色在 `hasPermission` 里有通配短路**（见 `stores/auth.ts`），故纯 ADMIN
// 账号对本文件的判定恒为 true，dummy 模式也因此天然可写。
//
// ⚠️ **部署顺序：后端必须先上**。存量会话的 `permissions` 要刷新 / 重登才会带上这两个码，
// 未刷新时闸门恒 false（按钮不可见），不会误放行。

import { useAuthStore } from '@/stores/auth';

/** 读端点（两条 list + 班次日历）用的查看权限点。 */
export const HR_VIEW_PERMISSION = 'hr.view';

/** 写端点（建 / 改 / 停用班次、写 / 删日历行）用的排班管理权限点。 */
export const HR_SCHEDULE_MANAGE_PERMISSION = 'hr.schedule.manage';

/**
 * 能否看排班日历（日历表 / 班次表 / 班次日历的只读面）。
 *
 * 与路由守卫的 `menuCode` 是两件事：本函数答「数据按钮可不可用」，守卫答「菜单点得进吗」。
 */
export function canViewSchedule(): boolean {
  return useAuthStore().hasPermission(HR_VIEW_PERMISSION);
}

/**
 * 能否改排班日历（建 / 改 / 停用班次、写 / 删全局日历行与班次日历覆盖行）。
 *
 * 口径：MANAGER 写、CLERK 只读——但判据是权限点 `hr.schedule.manage`，不是角色。
 */
export function canEditSchedule(): boolean {
  return useAuthStore().hasPermission(HR_SCHEDULE_MANAGE_PERMISSION);
}
