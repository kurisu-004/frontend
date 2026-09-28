// 大屏 WebSocket 数据类型（2026-09-28 精简）。
//
// 历史：
//   - 原 96 行包含 DashboardSnapshot / DashboardSnapshotData / DashboardShelfGroup /
//     DashboardPartItem / UpcomingDeliveryEntry 共 5 个 VO interface；
//   - 2026-09-28 改造后这 5 个 interface 全部由 Zod schema 派生（views/dashboard/
//     composables/dashboardSnapshotSchema.ts），手写 interface 已无消费者，删除；
//   - DashboardEvent / DashboardEventType / DashboardEventPayload /
//     DashboardServerMessage / ConnectionStatus 仍保留 —— 它们描述 WS 协议层
//     消息壳（消息形态而非业务 VO），且被 api/dashboard.ts（onMessage 分发）
//     + NotificationBanner.vue（event 消费） + useDashboardSnapshot.ts
//     （AFFECTS_DASHBOARD 类型签名）继续引用。

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

// 2026-09-28 review 第 2 轮修复（N3）：补 WS 协议层三种消息壳 interface，
// 让 DashboardServerMessage union 是真正的判别联合（discriminated union）。
//   - WsSnapshotMsg：后端首帧 snapshot，新架构（HTTP 全量首取 + WS 事件 invalidate）
//     下仅作「连接就绪信号」，不再消费 data 业务字段。
//   - WsHeartbeatMsg：后端 30s 保活 text 帧，前端无消费者。
// 原 main `DashboardServerMessage = DashboardSnapshot | DashboardEvent` 在本次
// 重构后塌缩为单一变体 `DashboardEvent`，dispatch 函数里 `msg.type === 'snapshot'`
// 与 `msg.type === 'heartbeat'` 分支在 TS narrowing 后是死代码。
// 补 union 后这三个分支能被 TS 正确 narrow，dispatch 类型谎言解除。
// 字段对齐 backend-rust `src/modules/ws/hub.rs`（具体字段待后端契约确认；
// 当前 shell 形态足够支撑 onMessage 三分支 narrow + future schema 校验）。

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
