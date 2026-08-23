// 后端 /api/v2/delivery-groups 端点的 TS 镜像（与 hsh-erp-rust 的
// `DeliveryGroup*Dto` 一一对应；雪花 ID 一律按 string 处理，避免 Number 丢精度）。
//
// 用途：品检员在扫码建单页给某个 L1 客户配置「分组」→ 决定扫码按哪个 L2 子集
// 落到哪张 DRAFT 草稿（GROUP / LEAF / L1_WIDE 三类 scope）。
//
// 接口稳定后才出现 recent_items 之类的扩展（见 src/types/deliveryNote.ts）。

/** 分组成员：L2 客户引用（雪花 ID + 名称）。 */
export interface DeliveryGroupMemberOut {
  customer_id: string
  customer_name: string
}

/** 单条分组实体（含成员列表与乐观锁 version）。 */
export interface DeliveryGroupOut {
  id: string
  /** L1 一级客户 id（分组必须挂在某个 L1 root 下）。 */
  customer_id: string
  name: string
  members: DeliveryGroupMemberOut[]
  /** 乐观锁 version；update / soft-delete 必须带，服务端校验。 */
  version: number
  created_at: string
  updated_at: string
}

/** 未被任何分组覆盖的 L2 客户（前端用于「未分组 L2」提示）。 */
export interface UngroupedCustomerOut {
  id: string
  name: string
}

/** 某个 L1 下分组列表 + 未分组 L2 列表的完整视图（GET /delivery-groups）。 */
export interface DeliveryGroupListOut {
  groups: DeliveryGroupOut[]
  ungrouped_customers: UngroupedCustomerOut[]
}

/** POST /delivery-groups body —— 新建分组。 */
export interface CreateDeliveryGroupRequest {
  /** L1 root id。 */
  customer_id: string
  name: string
  /** L2 成员 id 列表（service 端会校验全部属于该 L1）。 */
  member_customer_ids: string[]
}

/**
 * POST /delivery-groups/{id}/update body —— 更新分组（部分字段可选）。
 * `member_customer_ids` 字段「存在即全量替换」语义：传数组 = 覆盖，不传 = 不动。
 */
export interface UpdateDeliveryGroupRequest {
  version: number
  name?: string | null
  member_customer_ids?: string[] | null
}

/** 携带 version 的请求体（用于 soft-delete）。 */
export interface DeliveryGroupVersionRequest {
  version: number
}