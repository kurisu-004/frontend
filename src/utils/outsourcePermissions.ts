// src/utils/outsourcePermissions.ts
//
// 外协域权限点常量（2026-10-15 新增，RBAC 面板第二批闸门）。
//
// 形态对齐 `src/utils/productionPermissions.ts`：纯常量表、不 import auth store，判定由
// 消费侧调 `auth.hasPermission(常量)` 完成（ADMIN 元角色在 `stores/auth.ts` 通配短路）。
//
// ⚠️ 每个 code 必须与后端 seeds 逐字一致，由同目录 spec 逐字锁定。
// ⚠️ 部署顺序：后端必须先上（旧 `/iam/me` 不返这些权限点，非 ADMIN 账号闸门恒 false），
// 存量会话需刷新 / 重登才会拿到新权限点。

/** 外协域查看（页面 / 菜单级读点，前端无按钮闸）。 */
export const OUTSOURCE_VIEW_PERMISSION = 'outsource.view';

/** 外协报价新建 / 编辑 / 提交审核。 */
export const OUTSOURCE_QUOTE_EDIT_PERMISSION = 'outsource.quote.edit';

/** 外协报价审批（通过 / 拒绝）。 */
export const OUTSOURCE_QUOTE_APPROVE_PERMISSION = 'outsource.quote.approve';

/** 外协收发流转（发送到公司 / 回收到生产）。 */
export const OUTSOURCE_MOVE_PERMISSION = 'outsource.move';

/** 外协公司管理（新增 / 编辑 / 删除）。 */
export const OUTSOURCE_COMPANY_MANAGE_PERMISSION = 'outsource.company.manage';
