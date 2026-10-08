// 送货单权限 helper（`src/utils/deliveryNotePermissions.ts`）。
//
// 形态对齐 `src/utils/outsourceQuotePermissions.ts`。这里只放「状态 / 角色矩阵」的纯函数；
// 视图层把 user.roles 传进来即可。**零域内依赖**（只 type-import `@/types/deliveryNote`
// 的枚举）+ 多域复用（views/inspection、views/production/scan 也读 canView / hasManageNoteRole）。
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
  /**
   * 司机名；null / 空串 = 还没指定司机。
   *
   * ⚠️ **只**用于打印对话框内「导出」按钮的闸门，不参与入口可见性判据（见 `canPrint`）。
   */
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

/** 打印送货单：管理角色 + 至少 1 个行项。
 *
 *  **status 不设闸门**：已送货（PICKED_UP / ARCHIVED）的单允许补打 —— 收货方丢了这张单子
 *  时补打是真实场景，把它挡在门外没有收益。
 *
 *  ⚠️ **司机不是入口判据**（2026-10-08 修死锁）：唯一能指定司机的地方是打印对话框内的
 *  下拉，而进那个对话框的唯一入口就是被 `canPrint` 挡住的按钮 ⇒ 把「已指定司机」写进
 *  本函数等于让按钮与下拉互相等待，谁也进不去。司机闸门只保留在**对话框内部**的
 *  「导出」按钮上（送货单页脚「送货人：{{driver_name}}」必须有值，`POST /{id}/pickup`
 * 也要从单据上读 `driver_worker_id`），那里能看到用户在选什么。 */
export function canPrint(note: PrintableNoteLike, role: RoleMapLike): boolean {
  if (!hasManageNoteRole(role)) return false;
  return note.part_count > 0;
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
