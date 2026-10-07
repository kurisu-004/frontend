// 送货单权限 helper（`src/utils/deliveryNotePermissions.ts`）。
//
// 形态对齐 `src/utils/outsourceQuotePermissions.ts`。这里只放「状态 / 角色矩阵」的纯函数；
// 视图层把 user.roles 传进来即可。**零域内依赖**（只 type-import `@/types/deliveryNote`
// 的枚举）+ 多域复用（views/inspection、views/scan 也读 canView / hasManageNoteRole）。
//
// 角色矩阵（与后端 rust 送货单白名单一致）：CLERK + MANAGER + INSPECTOR 覆盖全部端点。

import type { DeliveryNoteStatus } from '@/types/deliveryNote';

export interface RoleMapLike {
  MANAGER?: boolean;
  CLERK?: boolean;
  INSPECTOR?: boolean;
}

/** 最小形态：打印判据只读状态 / 件数 / 司机名，不需要整个单据对象。 */
export interface PrintableNoteLike {
  status: string;
  /** 行项条数；0 = 空单，打不出东西。 */
  part_count: number;
  /** 司机名；null / 空串 = 还没指定司机。 */
  driver_worker_name: string | null;
}

/** ⚠️ 各 helper 的 `status` 形参一律收 `string` 而不是 `DeliveryNoteStatus`：
 *  守门 schema 不锁 status 字面量（见 composables/deliveryNoteSchema.ts 文件头），
 *  收窄点放在这里 —— 判据只做「等于某个已知字面量」的比对，后端新增枚举时自然落到
 *  「不满足任一分支」的保守结果，不会因为类型不兼容而编译不过。 */

export function hasManageNoteRole(role: RoleMapLike): boolean {
  return Boolean(role.MANAGER || role.CLERK || role.INSPECTOR);
}

export function canAddRemoveParts(status: string, role: RoleMapLike): boolean {
  if (!hasManageNoteRole(role)) return false;
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function canSubmit(status: string, role: RoleMapLike): boolean {
  return hasManageNoteRole(role) && status === 'DRAFT';
}

export function canRecall(status: string, role: RoleMapLike): boolean {
  return hasManageNoteRole(role) && status === 'SUBMITTED';
}

export function canSoftDelete(status: string, role: RoleMapLike): boolean {
  return hasManageNoteRole(role) && status === 'DRAFT';
}

/** 打印送货单：管理角色 + `DRAFT` / `SUBMITTED` + 至少 1 个行项 + **已指定司机**。
 *
 * 司机这条是硬闸门而不只是 UX：页脚「送货人：{{driver_name}}」必须有值，且
 * `POST /{id}/pickup` 要从单据上读 `driver_worker_id`（没指定直接 21409）⇒ 不指定司机
 * 打出来的单子没法闭环。后端不再发 `driver_worker_id`，用 `driver_worker_name` 判空即可。 */
export function canPrint(note: PrintableNoteLike, role: RoleMapLike): boolean {
  if (!hasManageNoteRole(role)) return false;
  if (note.status !== 'DRAFT' && note.status !== 'SUBMITTED') return false;
  if (note.part_count <= 0) return false;
  return Boolean(note.driver_worker_name);
}

/** 一键送货：`SUBMITTED` + 至少 1 个行项 + 管理角色。
 *  司机由 `POST /{id}/driver` 预先指定，本入口只带 version —— 服务端重跑
 *  `validate_driver`，司机被停用 / 改工种时返 21409。 */
export function canDeliver(status: string, role: RoleMapLike, partCount: number): boolean {
  return hasManageNoteRole(role) && status === 'SUBMITTED' && partCount > 0;
}

/** 详情页允许进入：所有合法状态皆可；非法 status 直接不显示页面。 */
export function canView(status: string): boolean {
  return (
    status === 'DRAFT' || status === 'SUBMITTED' || status === 'PICKED_UP' || status === 'ARCHIVED'
  );
}

/** 一览默认 statuses by role（与 outsource_quote 对齐）。 */
export function defaultStatusesForRole(role: RoleMapLike): DeliveryNoteStatus[] {
  if (role.MANAGER) return ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED'];
  if (role.CLERK) return ['DRAFT', 'SUBMITTED'];
  if (role.INSPECTOR) return ['DRAFT', 'SUBMITTED', 'PICKED_UP', 'ARCHIVED'];
  return ['SUBMITTED', 'PICKED_UP'];
}