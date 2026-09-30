// 2026-08-26 新增：工人队列调度看板的领域类型定义。
// 雪花 ID 全部 string（CLAUDE.md #3）；字段命名对齐 Rust 后端 WorkerPoolState / TakenItem。
//
// 2026-09-30：删 `AssignRequest` / `ReturnRequest` —— 它们描述的是后端
// `POST /admin/worker-pool/{assign,remove}` 的旧请求体，已被
// `POST /prod/pool/move` 的 `MoveRequest`（tagged enum from/to）取代；
// 类型本体见 src/api/workerPool.contract.ts，无消费者故直接删除。

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
  /**
   * 2026-09-30 新增：该 batch **当前所在货架 ID**（t_part_batch.current_holder_id）。
   *
   * 仅 pool 侧（`poolItemToCard` 从 `PoolBatchItemDto.shelf_id`）填充；held 侧
   * （`heldToCard`）恒为 null —— batch 在 worker 手里，没有"货架位置"。
   *
   * 用途：`POST /api/v2/prod/pool/move` 的 `from: {kind:'POOL', shelf_id}` 必须等于
   * batch 真实所在货架，否则后端返 20122 BIZ_BATCH_LOCATION_MISMATCH（HTTP 409）。
   * 候选池是**跨所有货架**返回的（`list_candidates_by_process_all_shelves`），batch
   * 所在货架未必等于用户当前激活货架（`auth.activeShelfId`），所以必须在拖拽开始时
   * 从卡片 DOM dataset 读出真实值（见 utils/dndSourceTracker.ts::recordPoolSource）。
   */
  shelf_id: string | null;
}

export interface ProcessPoolView {
  process_id: string;
  process_code: string;
  process_name: string;
  batches: WorkOrderCard[];
}
