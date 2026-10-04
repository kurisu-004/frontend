// 大屏域的类型定义。
//
// 收纳两类东西，两者的共同点是**都不是业务 VO**：
//   - WS 协议层类型：DashboardEvent / DashboardEventType / DashboardEventPayload /
//     WsSnapshotMsg / WsHeartbeatMsg / DashboardServerMessage / ConnectionStatus。
//     它们描述消息壳（消息形态而非业务 VO），被 api/dashboard.ts（onMessage 分发）
//     + NotificationBanner.vue（event 消费） + useDashboardInvalidation.ts
//     （AFFECTS_DASHBOARD 类型签名）引用。
//   - 请求参数类型：DeliveryBasis（见下）。2026-10-04 新增。
//
// 业务 VO 一律不在本文件：5 个大屏 VO（DashboardSnapshot / DashboardShelfGroup /
// DashboardPartItem / UpcomingDeliveryEntry 等）由 Zod schema 派生
// （views/dashboard/composables/dashboardSnapshotSchema.ts），既做 Zod 守门又是
// TS 类型来源，手写 interface 会与之双轨漂移。

export type DashboardEventType =
  // —— 前端 NotificationBanner 展示用（旧 v1 事件集）——
  | 'PICKED_UP'
  | 'RELEASED'
  | 'PLACED_ON_SHELF'
  | 'RETURNED'
  | 'INSPECTED'
  | 'ASSEMBLY_CANCELLED'
  | 'ASSEMBLY_DELETED'
  | 'RECALLED' // 2026-08-05 召回：ON_SHELF/PROGRAMMING → PENDING/PROGRAMMING
  // —— 后端 v2 ws_hub 实际下发的写入事件（2026-09-28 dashboard invalidate 用）——
  | 'PART_TO_SHIP'
  | 'PART_TO_INSPECTION'
  | 'PART_TO_PROCESS'
  | 'BATCH_TO_SHIP'
  | 'BATCH_TO_INSPECTION'
  | 'PART_SOFT_DELETED'
  | 'PART_DELIVERED'
  | 'PART_BATCH_SPLIT'
  | 'PART_BATCH_CANCELLED'
  | 'PART_SCAN_INSPECT_PASSED'
  | 'PART_SCAN_INSPECT_FAILED'
  | 'PART_BATCH_WITH_PDFS_CREATED'
  | 'PART_PICKED_UP'
  | 'WORKER_SCAN_RETURNED'
  | 'WORKER_SCAN_INSPECTED'
  | 'WORKER_POOL_REFILL_DONE'
  | 'WORKER_POOL_EMPTY'
  | 'WORKER_POOL_ADMIN_REMOVED'
  | 'WORKER_POOL_AUTO_ALLOCATE_DONE'
  | 'ASSEMBLY_CREATED'
  | 'ASSEMBLY_UPDATED';

export interface DashboardEventPayload {
  // 零件事件携带的字段（ASSEMBLY_* 不带这些）
  serial_no?: string | null;
  drawing_no?: string | null;
  name?: string | null;
  customer_path?: string | null;
  is_urgent?: boolean | null;
  planned_delivery_date?: string | null;
  worker_name?: string | null;
  shelf_code?: string | null;
  // 装配体事件携带的字段
  assembly_id?: string | null;
}

export interface DashboardEvent {
  type: 'event';
  event_type: DashboardEventType;
  data: DashboardEventPayload;
  ts: string;
}

// WS 协议层消息壳三件套，让 DashboardServerMessage union 是真正的判别联合
// （discriminated union）—— dispatch 函数里三个 type 分支靠 TS narrowing 收窄。
//   - WsSnapshotMsg：后端首帧 snapshot，本仓架构（HTTP 全量首取 + WS 事件 invalidate）
//     下仅作「连接就绪信号」，不再消费 data 业务字段。
//   - WsHeartbeatMsg：后端 30s 保活 text 帧，前端无消费者。
// 字段对齐 backend-rust `src/modules/ws/hub.rs`。

export interface WsSnapshotMsg {
  type: 'snapshot';
  data: unknown;
  ts: string;
}

export interface WsHeartbeatMsg {
  type: 'heartbeat';
  ts: string | number;
}

export type DashboardServerMessage = DashboardEvent | WsSnapshotMsg | WsHeartbeatMsg;
export type ConnectionStatus = 'connecting' | 'open' | 'closed';

// ============================================================
// 2026-10-04 新增：交期统计口径。
//
// dashboard 左栏「交期分桶」柱状图、派生它的「今日到期 / 两周到期」KPI、点柱后
// 的工单明细抽屉，三者共用同一个口径（同一份请求参数 → 同一份统计语义）。
//   - planned：按 planned_delivery_date（计划交期）分桶，缺省口径（= 无 basis
//     查询串时的后端缺省行为）；
//   - system：按 system_delivery_date（系统交期）分桶。
//
// 为什么放本文件而不是 dashboardSnapshotSchema.ts：口径是**请求参数**，不是响应
// VO 的一部分，wire 响应形态（{date, count, by_status}[]）与口径无关。schema 文件
// 的职责是对响应做 Zod 守门 + 派生响应类型，把请求参数塞进去会让「守卫响应」与
// 「描述请求」两件事混在一个文件里。
//
// 两种口径的**分桶结果必然不同**：system_delivery_date 可空，后端对 NULL 做范围比较
// 恒为 false ⇒ 该列为 NULL 的工单在系统口径下整件不计入；planned_delivery_date 是
// NOT NULL 列，计划口径无此缺失。两口径用的是**同一个日期窗口**、只是打在不同的列上，
// 桶总数恒为 N（缺失日期补 0），差异只体现在 count / by_status；合计**无可比大小
// 关系**（同一工单的两列可能分别落在窗口内外）。图卡上的口径开关旁挂了提示，避免用户
// 把差异误读成数据丢失。
export type DeliveryBasis = 'planned' | 'system';

/** 口径 → 中文名（图卡开关 / 抽屉 header 共用同一份文案）。 */
export const DELIVERY_BASIS_LABEL: Record<DeliveryBasis, string> = {
  planned: '计划交期',
  system: '系统交期',
};
