// 2026-09-14 新增：worker_pool 域前端契约（types only，无 runtime）。
//
// 端点（与 backend-rust/src/modules/worker_pool/handler.rs 对齐）：
//   GET  /api/v2/worker-pool/state?worker_id=&shelf_id=    ← getWorkerState
//   GET  /api/v2/worker-pool/{process_id}                 ← getWorkerPoolByProcess
//   POST /api/v2/admin/worker-pool/refill                 ← refillWorkerPool
//   POST /api/v2/admin/worker-pool/assign                 ← assignWorkerPool（2026-09-14 新增）
//   POST /api/v2/admin/worker-pool/remove                 ← removeFromWorkerPool
//   POST /api/v2/admin/worker-pool/auto-allocate          ← autoAllocate
//
// 端点形状以 rust 实际为准（worker-pool.md）：
// - i64 主键 → JSON 字符串（雪花 ID 防 JS 精度截断，CLAUDE.md #3）
// - role 守卫下沉到 service（manager / manager+clerk+inspector），前端靠 token 拦截
// - 2026-09-14：WorkerPoolState 新增 held_batches 字段（worker 持有 batch 列表）；
//   之前版本无此字段，前端 workerHeld 恒为空（UX 退化），文档记录已废。

/** `GET /api/v2/worker-pool/state` 出参（rust WorkerPoolState）。
 *  pool_count_by_process 仅含该 worker 工种映射到的工序；空工种时退化为 []。 */
export interface WorkerStateDto {
  worker_id: string;
  worker_name: string;
  work_type_code: string | null;
  /** work_type.max_held_batches；未设置时 0（rust 端 20904 错误） */
  max_held: number;
  /** worker 当前持有批次数（IN_PROCESS + WORKER + current_holder_id = worker_id） */
  current_held: number;
  /** max(0, max_held - current_held) */
  capacity_remaining: number;
  pool_count_by_process: PoolCountDto[];
  /** 2026-09-14 新增：worker 当前持有的 batch 列表（WorkOrderCard 必备字段子集）。
   *  与 PoolBatchItemDto 不同：taken 由 service 序列化时已是「持有批次」语义。 */
  held_batches: WorkerTakenItemDto[];
}

/** WorkerStateDto.pool_count_by_process 的元素类型（rust PoolCount）。 */
export interface PoolCountDto {
  process_id: string;
  pool_count: number;
}

/** `GET /api/v2/worker-pool/{process_id}` 内嵌的工人简短记录（rust WorkerBrief）。 */
export interface WorkerBriefDto {
  worker_id: string;
  name: string;
  work_type_id: string;
  work_type_code: string;
}

/** `GET /api/v2/worker-pool/{process_id}` 内嵌的工种 + max_held（rust WorkTypeMaxHeld）。 */
export interface WorkTypeMaxHeldDto {
  work_type_id: string;
  work_type_code: string;
  work_type_name: string;
  /** None = 未设置；前端渲染「工种 max_held 未设置」占位 */
  max_held_batches: number | null;
}

/** `GET /api/v2/worker-pool/{process_id}` 内嵌的候选批次（rust PoolBatchItem）。
 *  候选 = IN_PROCESS + PRODUCTION_SHELF + holder=shelf_id + next_process_id=process_id。 */
export interface PoolBatchItemDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  quantity: number;
  serial_no: string | null;
  /** 工单 / 零件名称（源自 t_part） */
  name: string;
  drawing_no: string;
  system_delivery_date: string | null;
  /** L2 客户名（叶子） */
  customer_name: string | null;
  /** L1 客户名（一级集团） */
  parent_customer_name: string | null;
  /** "L1 / L2" 路径 */
  customer_path: string | null;
  applicant_name: string | null;
  /** 候选池当前货架 raw enum（如 "PRODUCTION_SHELF"） */
  location: string;
  shelf_id: string;
  shelf_code: string;
  shelf_name: string;
  is_urgent: boolean;
  note: string | null;
  /** 批次上架时间（用于「积压多久」展示） */
  placed_at: string;
  version: number;
}

/** `GET /api/v2/worker-pool/{process_id}` 顶层出参（rust ProcessPoolDetail）。 */
export interface WorkerPoolDto {
  process_id: string;
  process_code: string;
  process_name: string;
  workers: WorkerBriefDto[];
  work_types: WorkTypeMaxHeldDto[];
  total: number;
  items: PoolBatchItemDto[];
}

/** `POST /api/v2/admin/worker-pool/refill` 请求（rust AdminRefillRequest）。
 *  rust 端 deserialize_i64 反序列化；前端发 string 雪花 ID 由 service 端 parse。 */
export interface WorkerRefillRequest {
  worker_id: string;
  shelf_id: string;
}

/** `POST /api/v2/admin/worker-pool/remove` 请求（rust AdminRemoveRequest）。 */
export interface WorkerRemoveRequest {
  worker_id: string;
  batch_id: string;
  shelf_id: string;
  /** 撤回后落入的下一道工序 ID */
  next_process_id: string;
}

/** `POST /api/v2/admin/worker-pool/assign` 请求（rust AdminAssignRequest，2026-09-14 新增）。
 *  单 batch 分配（替代之前的批量 refill）：把候选池某个 batch 直接塞给 worker。
 *  业务错：20204 WORKER_CAPACITY_EXCEEDED / 20114 BIZ_PART_BATCH_NOT_HELD_BY_WORKER /
 *         20801 NOT_FOUND / 20706 BIZ_BATCH_NOT_IN_POOL。 */
export interface AdminAssignRequest {
  worker_id: string;
  batch_id: string;
  shelf_id: string;
  /** 选填：明确分配到哪道工序；缺省由 service 端从 batch.next_process_id 推导。 */
  process_id?: string;
}

/** `POST /api/v2/admin/worker-pool/assign` 出参（rust AssignResult，2026-09-14 新增）。 */
export interface AssignResultDto {
  worker_id: string;
  batch_id: string;
  shelf_id: string;
  taken: WorkerTakenItemDto;
  /** 分配后 worker 当前持有数（= current_held + 1） */
  current_held: number;
  /** 分配后 worker max_held（不变） */
  max_held: number;
}

/** `POST /api/v2/admin/worker-pool/refill` 出参（rust RefillResult）。 */
export interface WorkerRefillResultDto {
  worker_id: string;
  shelf_id: string;
  /** 本次抢到的批次 */
  taken: Array<{
    batch_id: string;
    part_id: string;
    batch_no: number;
    quantity: number;
    serial_no: string | null;
    drawing_no: string;
    system_delivery_date: string | null;
    planned_delivery_date: string | null;
    is_urgent: boolean;
    version: number;
  }>;
  /** 是否池空；前端按 `pool_empty + taken.len()` 综合判断 */
  pool_empty: boolean;
}

/** `POST /api/v2/admin/worker-pool/remove` 出参（rust TakenItem）。 */
export interface WorkerTakenItemDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  quantity: number;
  serial_no: string | null;
  drawing_no: string;
  system_delivery_date: string | null;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** admin_remove 返回 `batch.version + 1` */
  version: number;
}

/** 自动分配模式：`COUNT` 按批次数填满；`TIME` 按累计预估工时填满。 */
export type AutoAllocateMode = 'COUNT' | 'TIME';

/** `POST /api/v2/admin/worker-pool/auto-allocate` 请求（rust AutoAllocateRequest）。 */
export interface AutoAllocateRequest {
  process_id: string;
  shelf_id: string;
  mode: AutoAllocateMode;
  /** 填充比例 ∈ [0.0, 1.0]；out-of-range → 20704 BIZ_AUTO_ALLOCATE_INVALID_RATIO */
  fill_ratio: number;
}

/** `POST /api/v2/admin/worker-pool/auto-allocate` 出参（rust AutoAllocateResult）。 */
export interface AutoAllocateResultDto {
  process_id: string;
  shelf_id: string;
  mode: AutoAllocateMode;
  fill_ratio: number;
  filled: Array<{
    worker_id: string;
    /** 目标：COUNT=批次数；TIME=累计分钟数 */
    target: number;
    /** 实际抢到的批次/工时（同 target 单位） */
    filled_count: number;
    /** 跳过原因（如「工种 max_held 未设置」）；存在 ⇒ 跳过该 worker */
    skipped_reason: string | null;
  }>;
  /** 任一 worker 中途遇 None（池空 / 容量触顶） */
  pool_empty: boolean;
}
