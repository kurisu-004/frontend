// 送货单权限 helper（`src/utils/deliveryNotePermissions.ts`）。
//
// 形态对齐 `src/utils/outsourceQuotePermissions.ts`：多数函数收一个角色矩阵
// （RoleMapLike）+ 状态字符串做纯判定，角色矩阵由消费方（`auth.hasRole`）构造。
// 消费方共 5 处，全在 `views/com/delivery/` 域内（列表 store / 详情 / 扫码台 / 行项表 /
// 派发控件）。
//
// ⚠️ **`canPrint` 是例外**：它不再按角色判，改为在函数内部访问 auth store 读权限点
// `delivery_note.print`（理由见下）。因此本文件不是「零依赖纯函数」集合 ——
// 单测必须注入 pinia 与 VueQueryPlugin（auth store setup 首行要 QueryClient）。
//
// 角色矩阵（与后端 rust 送货单白名单一致）：CLERK + MANAGER + INSPECTOR 覆盖全部端点。
//
// ⚠️ **只有 `canPrint` 改了判据（2026-10-14，RBAC 控制面板）**：它从「管理角色」改成
// 权限点 `delivery_note.print`。其余 helper（canSubmit / canRecall / canSoftDelete …）
// **仍按角色判** —— 本轮只迁打印这一个入口，扩到其余入口是另一次改动，不要顺手带上。
//
// 为什么只迁打印：这个权限点是**前端-only** —— 后端的
// `POST /com/delivery/note/{id}/print` 与 `/print-labels` 已于 2026-10-08 下线（打印改成
// 前端本地生成 hucre），后端对这页的写入路径零改动。所以它现在纯粹由 RBAC 面板控制，
// 前端读同一个码是最短路径，也不会有「前端比后端宽/窄」的偏差可发生。

import { useAuthStore } from '@/stores/auth';
import type { DeliveryNoteStatus } from '@/types/deliveryNote';

/** 放行送货单打印的权限点（与 RBAC 面板里的 `delivery_note.print` 逐字一致）。 */
export const DELIVERY_NOTE_PRINT_PERMISSION = 'delivery_note.print';

/** 送货单查看的权限点（与 RBAC 面板里的 `delivery_note.view` 逐字一致）。
 *
 *  ⚠️ 前端当前**零消费方**（读点由后端权限与菜单共同决定，前端不加按钮闸）；在此登记是
 *  为了让常量表与后端 seeds 的 20 码全集对齐 —— 不要按「无人 import」删除。 */
export const DELIVERY_NOTE_VIEW_PERMISSION = 'delivery_note.view';

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

/** 打印送货单：持有 `delivery_note.print` 权限点 + 至少 1 个行项。
 *
 *  **status 不设闸门**：已送货（PICKED_UP / ARCHIVED）的单允许补打 —— 收货方丢了这张单子
 *  时补打是真实场景，把它挡在门外没有收益。
 *
 *  ⚠️ **司机不是入口判据**（2026-10-08 修死锁）：唯一能指定司机的地方是打印对话框内的
 *  下拉，而进那个对话框的唯一入口就是被 `canPrint` 挡住的按钮 ⇒ 把「已指定司机」写进
 *  本函数等于让按钮与下拉互相等待，谁也进不去。司机闸门只保留在**对话框内部**的
 *  「导出」按钮上（送货单页脚「送货人：{{driver_name}}」必须有值，`POST /{id}/pickup`
 *  也要从单据上读 `driver_worker_id`），那里能看到用户在选什么。
 *
 *  ⚠️ 形参 `role` **保留但不再参与判定**（2026-10-14）：三个消费方
 *  `DeliveryNoteLineItemsTable.vue` / `DeliveryNoteScan.vue` /
 *  `DeliveryNoteDispatchControls.vue` 的 `canPrint` 调用形态未变；
 *  `DeliveryNoteScan.vue` 的 `roleMap` 另有 ADMIN 通配适配（经 `auth.hasRole`
 *  构造而不是直读 `roles` 枚举）。权限点取代角色成为判据，理由见文件头。 */
export function canPrint(note: PrintableNoteLike, role: RoleMapLike): boolean {
  void role;
  if (!useAuthStore().hasPermission(DELIVERY_NOTE_PRINT_PERMISSION)) return false;
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
