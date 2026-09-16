// 大屏 WebSocket 数据类型。snapshot（周期/状态变更）和 event（单条业务事件）两类。

export interface DashboardPartItem {
  id: string;
  /** 2026-07-29 批次化：卡片行=批次；quantity 为批次量 */
  batch_id: string | null;
  batch_no: number | null;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  quantity: number;
  is_urgent: boolean;
  planned_delivery_date: string | null;
  picked_up_at: string | null;
  // 2026-09-16 PR-2 暂存：以下 3 字段（current_holder_id / current_holder_kind /
  // shelf_code）值来自 rust 后端 dashboard/service.rs（已核实只读
  // t_part_batch，未依赖已删 t_part 列），类型对齐在后续 PR 同步。
  // 2026-09-16 PR-3：删 `placed_at` —— t_part_batch 列下线（PR-3 后端）；
  // dashboard WS 投影自 service.rs 也同步清理（前端类型同步对齐）。
  current_holder_id: string | null;
  current_holder_kind: 'shelf' | 'worker' | null;
  shelf_code: string | null;
  worker_name?: string | null;
  customer_name: string | null;
  customer_path: string | null;
  // Dashboard 大屏「下一工序」直接展示，省一次前端 /processes 请求
  // 2026-09-16 PR-3：next_process_id 保留（仍是 t_part rollup 列，PR-3 后端未删）；
  // PR-3 后端派生语义改为 min-progress 活跃批次的 step.process_id，对应 UI 展示不变。
  next_process_id: string | null;
  next_process_name: string | null;
}

export interface DashboardShelfGroup {
  shelf_id: string;
  shelf_code: string;
  shelf_name: string;
  total_count: number;
  items: DashboardPartItem[];
}

export interface UpcomingDeliveryEntry {
  date: string;
  count: number;
}

export interface DashboardSnapshotData {
  on_production_shelves: DashboardShelfGroup[];
  on_inspection_shelves: DashboardPartItem[];
  in_process: DashboardPartItem[];
  upcoming_delivery: UpcomingDeliveryEntry[];
  ts: string;
}

export interface DashboardSnapshot {
  type: 'snapshot';
  data: DashboardSnapshotData;
  ts: string;
}

// ============================================================
// 业务事件消息（横幅通知消费）
// ============================================================

export type DashboardEventType =
  | 'PICKED_UP'
  | 'RELEASED'
  | 'PLACED_ON_SHELF'
  | 'RETURNED'
  | 'INSPECTED'
  | 'ASSEMBLY_CANCELLED'
  | 'ASSEMBLY_DELETED'
  | 'RECALLED'; // 2026-08-05 召回：ON_SHELF/PROGRAMMING → PENDING/PROGRAMMING

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

export type DashboardServerMessage = DashboardSnapshot | DashboardEvent;
export type ConnectionStatus = 'connecting' | 'open' | 'closed';
