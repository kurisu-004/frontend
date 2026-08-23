// 送货分组 API 封装（Rust v2 P1；baseURL /api/v2）。
// 端点清单（与 hsh-erp-rust 的 delivery_groups router 对应）：
//   GET    /delivery-groups?customer_id=...        - listDeliveryGroups
//   POST   /delivery-groups                        - createDeliveryGroup
//   POST   /delivery-groups/{id}/update            - updateDeliveryGroup
//   POST   /delivery-groups/{id}/soft-delete       - softDeleteDeliveryGroup
//
// 错误码在视图层（DeliveryNoteScan.vue）按 ApiError.code 分流：
//   21414 BIZ_DELIVERY_GROUP_NAME_DUPLICATE         409 — 同 L1 下重名
//   21415 BIZ_DELIVERY_GROUP_MEMBER_NOT_IN_L1       400 — 成员不属于该 L1
//   21413 BIZ_DELIVERY_GROUP_HAS_ACTIVE_DRAFT       400 — 还有 DRAFT 在用，禁止删
//   40901 BIZ_DELIVERY_VERSION_CONFLICT             409 — version 不匹配
//   20104 BIZ_DELIVERY_NOT_FOUND                    404 — 分组不存在（已并发删）
//
// 全部走 apiV2，token / refresh / 信封逻辑与 v1 共享。

import { apiV2 } from '@/api/http'
import type {
  CreateDeliveryGroupRequest,
  DeliveryGroupListOut,
  DeliveryGroupOut,
  DeliveryGroupVersionRequest,
  UpdateDeliveryGroupRequest,
} from '@/types/deliveryGroup'

/**
 * 拉某个 L1 客户下的全部分组 + 未分组 L2 列表。
 * 注意事项：`customer_id` 必须是单值 string，axios 的 paramsSerializer 会把它
 * 序列化为 `?customer_id=...`；绝不能传数组——会被展成 `?customer_id=&customer_id=&...`。
 */
export async function listDeliveryGroups(
  l1Id: string,
): Promise<DeliveryGroupListOut> {
  const resp = await apiV2.get<DeliveryGroupListOut>('/delivery-groups', {
    params: { customer_id: l1Id },
  })
  return resp.data
}

/** 新建分组（service 端校验 name 不重复、member 全部属于 L1）。 */
export async function createDeliveryGroup(
  payload: CreateDeliveryGroupRequest,
): Promise<DeliveryGroupOut> {
  const resp = await apiV2.post<DeliveryGroupOut>('/delivery-groups', payload)
  return resp.data
}

/**
 * 更新分组（部分字段可选）。
 * `member_customer_ids` 存在即全量替换语义由后端负责；前端直接回传最新列表。
 */
export async function updateDeliveryGroup(
  id: string,
  payload: UpdateDeliveryGroupRequest,
): Promise<DeliveryGroupOut> {
  const resp = await apiV2.post<DeliveryGroupOut>(
    `/delivery-groups/${encodeURIComponent(id)}/update`,
    payload,
  )
  return resp.data
}

/** 软删除（带 version 乐观锁；后端会在还有 DRAFT 在用时拒绝 21413）。 */
export async function softDeleteDeliveryGroup(
  id: string,
  payload: DeliveryGroupVersionRequest,
): Promise<void> {
  await apiV2.post(
    `/delivery-groups/${encodeURIComponent(id)}/soft-delete`,
    payload,
  )
}