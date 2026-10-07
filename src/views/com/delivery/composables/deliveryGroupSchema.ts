// src/views/com/delivery/composables/deliveryGroupSchema.ts
//
// 2026-10-08 新增：送货分组域的 Zod 守门 schema（后端 `DeliveryGroup*Dto` 的前端镜像）。
// 与 query hook（useDeliveryGroupsQuery）同居 composables/ 目录；api 层
// `src/api/com/deliveryGroup.ts` 只 `import type` 派生类型标注返回值。
//
// ⚠️ 所有字段显式声明（Zod 默认 strip 会静默丢键，见 deliveryNoteSchema 文件头）。
// 雪花 id 一律 `z.string()`；`version` 是 JSON integer。

import { z } from 'zod';

/** 分组成员：L2 客户引用（雪花 id + 名称）。 */
export const deliveryGroupMemberSchema = z.object({
  customer_id: z.string(),
  customer_name: z.string(),
});

export type DeliveryGroupMemberData = z.infer<typeof deliveryGroupMemberSchema>;

/** 单条分组实体。 */
export const deliveryGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(deliveryGroupMemberSchema),
  /** 乐观锁 version；update / soft-delete 必带，服务端校验。 */
  version: z.number(),
});

export type DeliveryGroupData = z.infer<typeof deliveryGroupSchema>;

/** 未被任何分组覆盖的 L2 客户。 */
export const ungroupedCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type UngroupedCustomerData = z.infer<typeof ungroupedCustomerSchema>;

/** `GET /com/delivery/group?customer_id=` 响应：`groups` + 未分组 L2 列表。 */
export const deliveryGroupListResultSchema = z.object({
  groups: z.array(deliveryGroupSchema),
  ungrouped_customers: z.array(ungroupedCustomerSchema),
});

export type DeliveryGroupListResultData = z.infer<typeof deliveryGroupListResultSchema>;