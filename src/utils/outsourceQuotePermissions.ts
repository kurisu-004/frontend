/** 外协报价页面权限工具（2026-07-16，纯函数供 vitest 单测）。
 *
 *  ⚠️ **判据已从「角色枚举」迁到「权限点」（2026-10-15，RBAC 面板第二批）**：本文件五个
 *  判定函数现在直接读 auth store 的 `hasPermission(...)`（形态对齐
 *  `src/utils/partsPermissions.ts` 的 `void role` 写法）。角色与「能不能做这件事」不再
 *  一一对应：管理员可以在 RBAC 面板给自建角色（`QC_LEAD` 之类）单独授予「报价编辑 /
 *  审批」，也可以从 MANAGER 手里收回它；继续按角色判 ⇒ 前端入口与后端实际放行集合必然
 *  分叉，且**分叉的两个方向都很贵**（闸门比后端宽 → 可见却 403；闸门比后端窄 → 管理员
 *  配了却看不到入口，且无报错）。
 *
 *  ⚠️ **形参 `role` 保留但不再参与判定**（签名不改，消费方 `OutsourceQuoteTable.vue` /
 *  `OutsourceQuoteList.vue` 零改动）。它已经不再参与判定。
 *
 *  ⚠️ **ADMIN 元角色在 `hasPermission` 里有通配短路**（`stores/auth.ts`），故纯 ADMIN
 *  账号不受迁移影响 —— 与迁移前 `roleMapFromHasRole` 走 `hasRole` 通配等价。
 *
 *  ⚠️ **部署顺序：后端必须先上** —— 旧后端的 `/iam/me` 不返这些权限点，闸门对非 ADMIN
 *  账号恒 false ⇒ 外协报价的提交 / 审批 / 删除入口集体消失（软失败，无报错）。
 *
 *  ⚠️ **`canWithdraw` 已删（2026-10-15）**：报价撤回打的是 update / withdraw 端点，而该
 *  端点已下线、全仓零调用（前端所有入口都走 `OutsourceQuoteTable.vue` 的 action 通道，
 *  没有 withdraw 这一类）。**无该端点 = 不可实现**，留着就是一个永远点不动的入口。
 *
 *  `roleMapFromHasRole` / `defaultStatusesForRole` 的保留是**另一件事**：角色仍决定
 *  报价一览默认筛哪一档状态（MANAGER 看 SUBMITTED、CLERK 看 DRAFT），那是「先看什么」
 *  不是「能不能写」，故不走权限点。
 */

import { useAuthStore } from '@/stores/auth';
import {
  OUTSOURCE_QUOTE_APPROVE_PERMISSION,
  OUTSOURCE_QUOTE_EDIT_PERMISSION,
} from '@/utils/outsourcePermissions';
import type { OutsourceQuoteStatus } from '@/types/outsource';

export interface RoleLike {
  MANAGER?: boolean;
  CLERK?: boolean;
}

/** 由 `auth.hasRole` 构造角色矩阵（只服务列表默认筛选，不再是写权限判据）。
 *
 *  ⚠️ 必须走 hasRole 而不是直读 `auth.user.roles`：`hasRole` 对含 ADMIN 的账号**通配
 *  短路**（`stores/auth.ts`），纯 ADMIN 账号在这里拿到的每个键才是 true —— 直读枚举
 *  会让它的默认筛选落空，且没有任何报错。 */
export function roleMapFromHasRole(hasRole: (role: string) => boolean): RoleLike {
  return {
    MANAGER: hasRole('MANAGER'),
    CLERK: hasRole('CLERK'),
  };
}

/** 是否能新建报价（`outsource.quote.edit` 权限点；形参不再参与判定）。 */
export function canCreate(role: RoleLike): boolean {
  void role;
  return useAuthStore().hasPermission(OUTSOURCE_QUOTE_EDIT_PERMISSION);
}

/** 是否能编辑 / 提交审核（DRAFT 状态 + `outsource.quote.edit` 权限点）。 */
export function canEdit(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  void role;
  if (!useAuthStore().hasPermission(OUTSOURCE_QUOTE_EDIT_PERMISSION)) return false;
  return quote.status === 'DRAFT';
}

/** 是否能审批通过（`outsource.quote.approve` 权限点 + SUBMITTED 状态）。 */
export function canApprove(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  void role;
  if (!useAuthStore().hasPermission(OUTSOURCE_QUOTE_APPROVE_PERMISSION)) return false;
  return quote.status === 'SUBMITTED';
}

/** 是否能拒绝（与审批共用 `outsource.quote.approve` 权限点 + SUBMITTED 状态）。 */
export function canReject(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  void role;
  if (!useAuthStore().hasPermission(OUTSOURCE_QUOTE_APPROVE_PERMISSION)) return false;
  return quote.status === 'SUBMITTED';
}

/** 是否能软删（DRAFT / REJECTED 状态 + `outsource.quote.edit` 权限点）。 */
export function canSoftDelete(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  void role;
  if (!useAuthStore().hasPermission(OUTSOURCE_QUOTE_EDIT_PERMISSION)) return false;
  return quote.status === 'DRAFT' || quote.status === 'REJECTED';
}
