// 2026-08-26 新增：工人队列调度看板的领域类型定义。
// 雪花 ID 全部 string（CLAUDE.md #3）；字段命名对齐 Rust 后端 WorkerPoolState / TakenItem。

export interface Worker {
  /** 雪花 ID，string */
  id: string;
  name: string;
  badge_code: string;
  /** 工种 code，决定可承接工序集合 */
  work_type_code: string;
  /** 最大持有批次数 */
  max_held: number;
  /** 当前持有批次数 */
  current_held: number;
  /** max_held - current_held */
  capacity_remaining: number;
  is_online: boolean;
  /** 该工人可加工工序 ID 列表（用于 tab 过滤）；
   *  后端尚未暴露 work_type.process_ids 映射，前端在 fixture 落地 */
  process_ids: string[];
}

export interface WorkOrderCard {
  /** 雪花 ID，string */
  batch_id: string;
  batch_no: string;
  part_id: string;
  drawing_no: string;
  part_name: string;
  quantity: number;
  serial_no: string | null;
  /** ISO date string, e.g. '2026-09-05' */
  system_delivery_date: string | null;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** OCC 乐观锁 version */
  version: number;
  /** 客户名称（前端扩展，后端待补） */
  customer: string | null;
  /** 申请人（前端扩展，后端待补） */
  applicant: string | null;
  /** 所在位置（前端扩展，后端待补） */
  location: string | null;
  /**
   * 2026-09-29 新增：该 batch 对应 part 是否已上传 CNC 程序。WorkOrderCard view-model
   * 透传自 PoolBatchItemDto.has_cnc_program / HeldBatchItemDto.has_cnc_program。
   * 仅 pool / held 透传 PoolBatchItemDto / HeldBatchItemDto 的对应字段；前端 UI
   * 在卡片 header 渲染「已编程」绿色 tag。无条件渲染：非 CNC 链 has_cnc_program=false
   * 也不渲染 tag（后端派生 = false 即跳过 UI）。
   */
  has_cnc_program?: boolean;
}

export interface ProcessPoolView {
  process_id: string;
  process_code: string;
  process_name: string;
  batches: WorkOrderCard[];
}

export interface AssignRequest {
  worker_id: string;
  batch_id: string;
  shelf_id: string;
  /** 目标工序 ID（用于调度决策） */
  process_id: string;
}

export interface ReturnRequest {
  worker_id: string;
  batch_id: string;
  shelf_id: string;
  /** 撤回后落入的下一道工序 ID（RETURNED 语义） */
  next_process_id: string;
}
