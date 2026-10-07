// 送货分组 API 封装（`src/api/com/deliveryGroup.ts`，baseURL `/api/v2`）。
// 2026-10-08：随视图目录一并搬到 `api/com/`，URL 硬切到 `/api/v2/com/delivery/group/*`
// （**无 alias**，旧 `/delivery-groups/*` 404）。
//
// 端点清单：
//   GET    /com/delivery/group?customer_id=...   - listDeliveryGroups
//   POST   /com/delivery/group                   - createDeliveryGroup
//   POST   /com/delivery/group/{id}/update        - updateDeliveryGroup
//   POST   /com/delivery/group/{id}/soft-delete   - softDeleteDeliveryGroup
//
// 错误码在视图层（DeliveryNoteScan.vue）按 ApiError.code 分流：
//   21414 BIZ_DELIVERY_GROUP_NAME_DUPLICATE  409 — 同 L1 下重名
//   21415 BIZ_DELIVERY_GROUP_MEMBER_NOT_IN_L1 400 — 成员不属于该 L1
//   21413 BIZ_DELIVERY_GROUP_HAS_ACTIVE_DRAFT 400 — 还有 DRAFT 在用，禁止删
//   40901 BIZ_VERSION_CONFLICT                409 — version 不匹配
//   20104 BIZ_DELIVERY_NOT_FOUND              404 — 分组不存在（已并发删）

import { api } from '@/api/http';
import type {
  DeliveryGroupData,
  DeliveryGroupListResultData,
} from '@/views/com/delivery/composables/deliveryGroupSchema';

/** POST /com/delivery/group body —— 新建分组。 */
export interface DeliveryGroupCreateRequest {
  /** L1 root id（雪花字符串）。 */
  customer_id: string;
  name: string;
  /** L2 成员 id 列表（service 端会校验全部属于该 L1）。 */
  member_customer_ids: string[];
}

/** POST /com/delivery/group/{id}/update body —— 更新分组（部分字段可选）。
 *  `member_customer_ids` 的「存在即全量替换」语义由后端负责；前端回传最新列表。 */
export interface DeliveryGroupUpdateRequest {
  version: number;
  name?: string | null;
  member_customer_ids?: string[] | null;
}

/** 携带 version 的请求体（soft-delete）。 */
export interface DeliveryGroupVersionRequest {
  version: number;
}

/** 拉某个 L1 客户下的全部分组 + 未分组 L2 列表。
 *
 * ⚠️ `customer_id` 必须是单值 string：axios 的 params 会把它序列化成
 * `?customer_id=...`；传数组会被展成 `?customer_id=&customer_id=&...`。 */
export async function listDeliveryGroups(l1Id: string): Promise<DeliveryGroupListResultData> {
  const resp = await api.get<DeliveryGroupListResultData>('/com/delivery/group', {
    params: { customer_id: l1Id },
  });
  return resp.data;
}

/** 新建分组（service 端校验 name 不重复、member 全部属于 L1）。 */
export async function createDeliveryGroup(
  payload: DeliveryGroupCreateRequest,
): Promise<DeliveryGroupData> {
  const resp = await api.post<DeliveryGroupData>('/com/delivery/group', payload);
  return resp.data;
}

/** 更新分组。 */
export async function updateDeliveryGroup(
  id: string,
  payload: DeliveryGroupUpdateRequest,
): Promise<DeliveryGroupData> {
  const resp = await api.post<DeliveryGroupData>(
    `/com/delivery/group/${encodeURIComponent(id)}/update`,
    payload,
  );
  return resp.data;
}

/** 软删除（带 version 乐观锁；后端会在还有 DRAFT 在用时拒绝 21413）。 */
export async function softDeleteDeliveryGroup(
  id: string,
  payload: DeliveryGroupVersionRequest,
): Promise<void> {
  await api.post(`/com/delivery/group/${encodeURIComponent(id)}/soft-delete`, payload);
}

// wire 契约类型再导出（调用方统一从 api 层取类型）。
export type {
  DeliveryGroupData,
  DeliveryGroupListResultData,
  DeliveryGroupMemberData,
  UngroupedCustomerData,
} from '@/views/com/delivery/composables/deliveryGroupSchema';