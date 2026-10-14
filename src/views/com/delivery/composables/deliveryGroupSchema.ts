// src/views/com/delivery/composables/deliveryGroupSchema.ts
//
// 2026-10-08 新增：送货分组域的 Zod 守门 schema（后端 `DeliveryGroup*Dto` 的前端镜像）。
// 与 query hook（useDeliveryGroupsQuery）同居 composables/ 目录；api 层
// `src/api/com/deliveryGroup.ts` 只 `import type` 派生类型标注返回值。
//
// ⚠️ 所有字段显式声明（Zod 默认 strip 会静默丢键，见 deliveryNoteSchema 文件头）。
// 雪花 id 一律 `z.string()`；`version` 是 JSON integer。

import { z } from 'zod';

/** 分组成员：客户引用（雪花 id + 名称）。
 *
 *  成员可以是该 L1 的**任意后代**（后端 `validate_group_members` 走 `subtree_ids`，
 *  而 `subtree_ids` 含自身故显式剔除 L1 —— 分组键就是它），不再限于「L1 的直接子」；
 *  `customer_name` 是后端 `paths_of` 给的单段名（不含根）。 */
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

/** 未被任何分组覆盖的客户（= 该 L1 的全部后代里没进任何分组的那些）。 */
export const ungroupedCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type UngroupedCustomerData = z.infer<typeof ungroupedCustomerSchema>;

/** `GET /com/delivery/group?customer_id=` 响应：`groups` + 未分组客户列表。 */
export const deliveryGroupListResultSchema = z.object({
  groups: z.array(deliveryGroupSchema),
  ungrouped_customers: z.array(ungroupedCustomerSchema),
});

export type DeliveryGroupListResultData = z.infer<typeof deliveryGroupListResultSchema>;
