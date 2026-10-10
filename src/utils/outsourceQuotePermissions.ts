/** 外协报价页面权限工具（2026-07-16，纯函数供 vitest 单测）。

不依赖 auth session；调用方传入 RoleLike 角色矩阵（`useOutsourceQuoteListStore`
用 `auth.hasRole` 构造 —— 含 ADMIN 的账号在 hasRole 内通配短路，纯 ADMIN 也能通过）。
CLERK / MANAGER 通过 manage_quotes 菜单即视为可读写；
MANAGER 还有审批权（approve / reject）；
CLERK 只能编辑 DRAFT 自己的；超界一律禁用。
*/

import type { OutsourceQuoteStatus } from '@/types/outsource';

export interface RoleLike {
  MANAGER?: boolean;
  CLERK?: boolean;
}

/** 由 `auth.hasRole` 构造角色矩阵。
 *
 *  ⚠️ 必须走 hasRole 而不是直读 `auth.user.roles`：`hasRole` 对含 ADMIN 的账号**通配
 *  短路**（`stores/auth.ts`），纯 ADMIN 账号在这里拿到的每个键才是 true —— 直读枚举
 *  会让它的提交 / 审批按钮全部消失，且没有任何报错。 */
export function roleMapFromHasRole(hasRole: (role: string) => boolean): RoleLike {
  return {
    MANAGER: hasRole('MANAGER'),
    CLERK: hasRole('CLERK'),
  };
}

/** 当前角色是否拥有任意外协报价菜单权限 */
export function hasManageQuotesRole(role: RoleLike): boolean {
  return !!(role.MANAGER || role.CLERK);
}

/** 是否能新建报价 */
export function canCreate(role: RoleLike): boolean {
  return hasManageQuotesRole(role);
}

/** 是否能编辑 / 提交审核（DRAFT 状态 + 有管理权限） */
export function canEdit(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  if (!hasManageQuotesRole(role)) return false;
  return quote.status === 'DRAFT';
}

/** 是否能审批通过（仅 MANAGER + SUBMITTED） */
export function canApprove(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  if (!role.MANAGER) return false;
  return quote.status === 'SUBMITTED';
}

/** 是否能拒绝（仅 MANAGER + SUBMITTED） */
export function canReject(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  if (!role.MANAGER) return false;
  return quote.status === 'SUBMITTED';
}

/** 是否能撤回（CLERK 把 SUBMITTED 退回 DRAFT） */
export function canWithdraw(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  if (!hasManageQuotesRole(role)) return false;
  return quote.status === 'SUBMITTED';
}

/** 是否能软删（DRAFT / REJECTED 状态） */
export function canSoftDelete(quote: { status: OutsourceQuoteStatus }, role: RoleLike): boolean {
  if (!hasManageQuotesRole(role)) return false;
  return quote.status === 'DRAFT' || quote.status === 'REJECTED';
}
