// 2026-09-14 新增：pool 域前端契约（types only，无 runtime）。
//
// 端点（与 backend-rust/src/modules/prod/worker_pool 对齐，baseURL `/api/v2`）：
//   GET  /api/v2/prod/pool/state?worker_id=           ← getWorkerState
//   GET  /api/v2/prod/pool/counts                     ← getWorkerPoolCounts
//   GET  /api/v2/prod/pool/{process_id}               ← getWorkerPoolByProcess
//   POST /api/v2/prod/pool/refill                     ← refillWorkerPool
//   POST /api/v2/prod/pool/move                       ← moveBatch
//   POST /api/v2/prod/pool/auto-allocate              ← autoAllocate
//
// 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛，本文件同步重写）：
//   - 删 AdminAssignRequest / AssignResultDto / WorkerRemoveRequest / WorkerTakenItemDto：
//     旧 assign（POOL→WORKER 单边）+ remove（WORKER→POOL 单边）已合并为
//     MoveRequest / MoveResultDto 通用移动端点。
//   - 新增 MoveLocationDto（tagged enum）/ MoveRequest / MoveResultDto / TakenItemDto。
//   - 删 WorkerPoolCountsDto.shelf_id：后端 WorkerPoolCountsOut
//     （src/modules/prod/worker_pool/dto.rs）只有 counts + total 两字段。
//   - 删 PoolBatchItemDto.current_process_step_id：后端 PoolBatchItem
//     （src/modules/prod/worker_pool/vo/worker_pool.rs:14-50）无此字段。
//   - WorkerStateDto.work_type_code 收紧为 string：后端 WorkerPoolState
//     （model.rs:122）是 `String` 而非 `Option<String>`，无工种时为空串。
//
// 端点形状以 rust 实际为准：
// - i64 主键 → JSON 字符串（雪花 ID 防 JS 精度截断，CLAUDE.md #3）
// - role 守卫下沉到 service（manager / manager+clerk+inspector），前端靠 token 拦截
// - `Option<T>` 字段在 rust 侧未加 skip_serializing_if 时序列化为 `null`；加了则
//   **整个字段从 JSON 中省略** —— 前端契约按「可能缺省」标注（`?` / `| undefined`）。

/** `GET /api/v2/prod/pool/state` 出参（rust WorkerPoolState，model.rs:118-133）。
 *  pool_count_by_process 仅含该 worker 工种映射到的工序；空工种时退化为 []。 */
export interface WorkerStateDto {
  worker_id: string;
  worker_name: string;
  /** 后端为非 Option String（model.rs:122）—— 无工种时为空串，不返 null。 */
  work_type_code: string;
  /** work_type.max_held_batches；未设置时 0 */
  max_held: number;
  /** worker 当前持有批次数（IN_PROCESS + WORKER + current_holder_id = worker_id） */
  current_held: number;
  /** max(0, max_held - current_held) */
  capacity_remaining: number;
  /** 2026-10-04：shelf_id 已是可选 query（前端不传）—— 此时该字段为空数组。
   *  该字段是后端唯一消费 shelf_id 的出参，前端零消费。 */
  pool_count_by_process: PoolCountDto[];
  /** 2026-09-14 新增；2026-09-14 follow-up round-2 升级为 HeldBatchItemDto
   *  （展示字段全字段，对应 rust 端 JOIN t_part / t_customer / t_applicant / t_shelf
   *   后的 HeldBatchItem，model.rs:62-98）。 */
  held_batches: HeldBatchItemDto[];
}

/** WorkerStateDto.pool_count_by_process 的元素类型（rust ProcessPoolCount）。 */
export interface PoolCountDto {
  process_id: string;
  pool_count: number;
}

/** 2026-09-14 follow-up round-2 新增：`WorkerStateDto.held_batches` 元素类型
 *  （rust `HeldBatchItem`，model.rs:62-98）。包含前端 heldToCard 渲染所需的全部
 *  展示字段，消除之前 WorkerTakenItemDto 字段过窄导致的「name / customer_name /
 *  applicant_name / location / shelf_code 等核心展示字段被降级为 null / 空串」的
 *  UX 退化问题。
 *
 *  字段命名 / 类型与 Rust `HeldBatchItem` 严格一一对应（本文件是权威）：
 *  - 雪花 ID 全 string；
 *  - 日期 ISO `"YYYY-MM-DD"` 字符串；
 *  - `location` 是 t_part_batch.location enum string
 *    （'OFFICE' / 'PRODUCTION_SHELF' / 'WORKER' / 'INSPECTION_SHELF' / 'OUTSOURCE_COMPANY'）；
 *  - `customer_name` = L2 客户名（叶子），`parent_customer_name` = L1 客户名（一级集团）。
 *
 *  2026-09-29：`has_cnc_program: boolean`（与 PoolBatchItemDto 同源语义 —— 该 batch
 *  对应 part 是否已上传 CNC 程序；后端 `t_part_file` EXISTS 派生）。WorkerQueueBoard
 *  的 held 列复用 BatchCard 渲染「已编程」tag，故需透传。
 */
export interface HeldBatchItemDto {
  /** t_part_batch.id，雪花 ID */
  batch_id: string;
  /** t_part.id，雪花 ID */
  part_id: string;
  batch_no: number;
  quantity: number;
  /** t_part.serial_no */
  serial_no: string | null;
  /** t_part.drawing_no */
  drawing_no: string;
  /** t_part.name（零件 / 工单名称） */
  name: string;
  /** t_part.system_delivery_date */
  system_delivery_date: string | null;
  /** t_part.planned_delivery_date */
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** L2 客户名（来自 t_customer L2.name） */
  customer_name: string | null;
  /** L1 客户名（一级集团，t_customer L1.name） */
  parent_customer_name: string | null;
  /** t_applicant.name */
  applicant_name: string | null;
  /** t_part_batch.location enum string（'OFFICE' / 'PRODUCTION_SHELF' / 'WORKER' /
   *  'INSPECTION_SHELF' / 'OUTSOURCE_COMPANY'） */
  location: string;
  /** t_shelf.code（批次当前 / 历史所在货架 code；held 状态下可为 null） */
  shelf_code: string | null;
  /** t_part.note */
  note: string | null;
  /** 是否已上传 G 代码（t_part_file.kind='G_CODE' EXISTS 派生）。UI 在卡片 header
   *  渲染「已编程」绿色 tag —— 仅当 true 时显示。 */
  has_cnc_program: boolean;
  /** OCC 乐观锁 version */
  version: number;
}

/** `GET /api/v2/prod/pool/{process_id}` 内嵌的工人简短记录（rust WorkerBrief）。 */
export interface WorkerBriefDto {
  worker_id: string;
  name: string;
  work_type_id: string;
  work_type_code: string;
}

/** `GET /api/v2/prod/pool/{process_id}` 内嵌的工种 + max_held（rust WorkTypeMaxHeld）。 */
export interface WorkTypeMaxHeldDto {
  work_type_id: string;
  work_type_code: string;
  work_type_name: string;
  /** None = 未设置；前端渲染「工种 max_held 未设置」占位 */
  max_held_batches: number | null;
}

/** `GET /api/v2/prod/pool/{process_id}` 内嵌的候选批次（rust PoolBatchItem）。
 *  候选 = IN_PROCESS + PRODUCTION_SHELF + deleted_at IS NULL，按 next_process_id
 *  （PR-3 step 化后走 t_process_chain_step.process_id）维度匹配。
 *
 *  2026-09-16 PR-3：删 `placed_at`（t_part_batch 列下线）；候选池「积压多久」
 *  改由前端按事件 `created_at` 自派生或后端后续补字段。
 *
 *  2026-09-30：删 `current_process_step_id` —— 后端 VO
 *  （src/modules/prod/worker_pool/vo/worker_pool.rs:14-50）根本没有这个字段。
 *  此前前端 contract + Zod schema 都声明了它，导致 `workerPoolByProcessSchema.parse`
 *  **永远失败** → WorkerPoolTab 永久「加载失败」。 */
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
  /** 当前货架 id（t_part_batch.current_holder_id）。
   *  **POOL → WORKER move 的 `from.shelf_id` 必须取这个值**（不是用户当前激活货架）——
   *  `GET /pool/{process_id}` 跨所有货架返回，两者可能不同，填错后端返 20122。 */
  shelf_id: string;
  shelf_code: string;
  shelf_name: string;
  is_urgent: boolean;
  note: string | null;
  /** 是否已上传 CNC 程序（G 代码，`t_part_file` EXISTS 派生）。UI 据此在 pool 卡片
   *  渲染「已编程」绿色 tag —— 无条件渲染，无副作用。 */
  has_cnc_program: boolean;
  version: number;
}

/** `GET /api/v2/prod/pool/{process_id}` 顶层出参（rust ProcessPoolDetail）。 */
export interface WorkerPoolDto {
  process_id: string;
  process_code: string;
  process_name: string;
  workers: WorkerBriefDto[];
  work_types: WorkTypeMaxHeldDto[];
  total: number;
  items: PoolBatchItemDto[];
}

/** `POST /api/v2/prod/pool/refill` 请求（rust AdminRefillRequest）。
 *  rust 端 deserialize_i64 反序列化；前端发 string 雪花 ID 由 service 端 parse。 */
export interface WorkerRefillRequest {
  worker_id: string;
  shelf_id: string;
}

/** 2026-09-30：`POST /api/v2/prod/pool/move` 的 `from` / `to` tagged enum
 *  （rust MoveLocation，dto.rs，`#[serde(tag = "kind", rename_all = "UPPERCASE")]`）。
 *  序列化形态：
 *    {"kind":"POOL",   "shelf_id":"100"}
 *    {"kind":"WORKER", "worker_id":"50"} */
export type MoveLocationDto =
  | { kind: 'POOL'; shelf_id: string }
  | { kind: 'WORKER'; worker_id: string };

/** 2026-09-30：`POST /api/v2/prod/pool/move` 请求（rust MoveRequest）。
 *  取代旧 `AdminAssignRequest`（POOL→WORKER 单边）与 `AdminRemoveRequest`
 *  （WORKER→POOL 单边）。字段顺序：batch_id → from → to → note?。
 *
 *  三个移动方向：
 *  | from     | to       | 说明                          |
 *  |----------|----------|-------------------------------|
 *  | POOL     | WORKER   | 旧 admin/worker-pool/assign   |
 *  | WORKER  | POOL     | 旧 admin/worker-pool/remove   |
 *  | WORKER  | WORKER   | 2026-09-30 新增（不写 step）  |
 *  | POOL     | POOL     | 非法 → 40001 VALIDATION_ERROR | */
export interface MoveRequest {
  batch_id: string;
  /** 当前位置（必须与 batch 实际状态一致，否则 20122） */
  from: MoveLocationDto;
  /** 目标位置 */
  to: MoveLocationDto;
  /** 可选，写入 t_part_event.note */
  note?: string;
}

/** 2026-09-30：`TakenItem`（rust worker_pool/model.rs:13-30）。
 *  既是 `RefillResult.taken[]` 的元素类型，也是 `MoveResult.taken`（仅 POOL→WORKER
 *  时填）的元素类型。 */
export interface TakenItemDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  quantity: number;
  serial_no: string | null;
  drawing_no: string;
  system_delivery_date: string | null;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** 移动 / 抢批后 batch.version + 1 */
  version: number;
  /** 是否已上传 G 代码（与候选池视图 / take_one_from_pool 同源 EXISTS 判定）。
   *  2026-09-29 后端新增（model.rs:26-29，serde default 兜底 false）。 */
  has_cnc_program: boolean;
}

/** `POST /api/v2/prod/pool/refill` 出参（rust RefillResult，model.rs:101-107）。 */
export interface WorkerRefillResultDto {
  worker_id: string;
  shelf_id: string;
  /** 本次抢到的批次 */
  taken: TakenItemDto[];
  /** 是否池空；前端按 `pool_empty + taken.length` 综合判断 */
  pool_empty: boolean;
}

/** 2026-09-30：`POST /api/v2/prod/pool/move` 出参（rust MoveResult，
 *  vo/worker_pool.rs）。取代旧 `AssignResult`。
 *
 *  `current_held` / `max_held` / `shelf_id` / `taken` 四个字段在 rust 侧都带
 *  `#[serde(skip_serializing_if = "Option::is_none")]` ⇒ 不满足条件时**整个字段
 *  从 JSON 中省略**（不是 null）。契约按 `?: T | null` 标注（undefined 或 null 都可能）。 */
export interface MoveResultDto {
  batch_id: string;
  /** 入参 `from.kind` 的字面（"POOL" / "WORKER"） */
  from_kind: 'POOL' | 'WORKER';
  /** 入参 `to.kind` 的字面（"POOL" / "WORKER"） */
  to_kind: 'POOL' | 'WORKER';
  /** 移动后 batch.current_holder_id（POOL 时=shelf_id；WORKER 时=worker_id） */
  new_holder_id: string;
  /** 移动后 batch.location（"PRODUCTION_SHELF" / "WORKER"） */
  new_location: string;
  /** batch.version + 1 */
  version: number;
  /** 仅 to_kind=WORKER 时填：目标 worker 移动后持有数（含本批次） */
  current_held?: number | null;
  /** 仅 to_kind=WORKER 时填：目标 worker 工种的 max_held_batches */
  max_held?: number | null;
  /** 货架雪花 ID（禁 number，走字符串序列化器）：POOL→WORKER 填 `from.shelf_id`、
   *  WORKER→POOL 填 `to.shelf_id`、WORKER→WORKER 不填（字段整体省略）。 */
  shelf_id?: string | null;
  /** 仅 POOL→WORKER 移动时填：从 pool 取出的 batch 详情 */
  taken?: TakenItemDto | null;
}

/** 2026-09-29 新增：待下发批次项（rust PendingBatchItem，
 *  `src/modules/prod/batch/vo.rs`）。17 字段：batch_id / part_id / batch_no /
 *  quantity / serial_no / name / drawing_no / planned_delivery_date /
 *  system_delivery_date / customer_name / parent_customer_name / applicant_name /
 *  is_urgent / note / version / current_process_step_id / process_chain_id。
 *
 *  字段语义：
 *  - `current_process_step_id` / `process_chain_id`：后端是 `i64` + `serialize_i64`
 *    （NULL 走 `.unwrap_or(0)` 兜底），故**非 nullable** —— "0" 语义为「未设」。
 *  - `parent_customer_name`：L1 客户名（一级集团），与 HeldBatchItemDto /
 *    PoolBatchItemDto 同源。
 *  - `note`：t_part.note，可能含业务备注（如「加急」）。
 *  - `version`：OCC 乐观锁 i32，每次写操作 +1。
 *
 *  数据流：本 DTO 是「每个批次一行」的扁平形态（不嵌套 part），与 HeldBatchItemDto
 *  同源但字段更全（含 planned_delivery_date 必有）；前端 PendingBatchesPanel
 *  直接消费。 */
export interface PendingBatchItemDto {
  /** t_part_batch.id，雪花 ID */
  batch_id: string;
  /** t_part.id，雪花 ID */
  part_id: string;
  /** t_part_batch.batch_no（后端 i32，前端 schema 归一成 string 展示） */
  batch_no: number;
  quantity: number;
  /** t_part.serial_no */
  serial_no: string | null;
  /** t_part.name（零件 / 工单名称） */
  name: string;
  /** t_part.drawing_no */
  drawing_no: string;
  /** t_part.planned_delivery_date（计划交付日，nullable） */
  planned_delivery_date: string | null;
  /** t_part.system_delivery_date（系统推算交付日，nullable） */
  system_delivery_date: string | null;
  /** L2 客户名（叶子，t_customer L2.name） */
  customer_name: string | null;
  /** L1 客户名（一级集团，t_customer L1.name） */
  parent_customer_name: string | null;
  /** t_applicant.name */
  applicant_name: string | null;
  is_urgent: boolean;
  /** t_part.note */
  note: string | null;
  /** OCC 乐观锁 version */
  version: number;
  /** 当前所在工艺链步骤 ID；"0" = 未设 step（PENDING 常态） */
  current_process_step_id: string;
  /** 所属工艺链 ID；"0" = 工单未挂工艺链 */
  process_chain_id: string;
}

/** `GET /api/v2/prod/pool/counts` 顶层出参（rust WorkerPoolCountsOut，
 *  `src/modules/prod/worker_pool/dto.rs`）。前端 `useWorkerPoolCountsQuery` 共享
 *  query 消费（30s staleTime 去重缓存，eager 拉取）。tab 标题 (N) 徽标 + 「待下发」
 *  Tab 工序卡 badge 的唯一数据源。
 *
 *  2026-09-30 契约漂移修复：**删 `shelf_id`**。后端 `WorkerPoolCountsOut` 只有
 *  `counts` + `total` 两字段；此前前端 schema 声明了 `shelf_id: string | null`，
 *  `workerPoolCountsSchema.parse` **永远失败** → tab 徽标恒 0 + 「待下发」工序卡
 *  badge 恒空。 */
export interface WorkerPoolCountsDto {
  /** 各工序候选批次数（仅含 count > 0 的工序；按 process_id ASC 稳定排序） */
  counts: ProcessBatchCountDto[];
  /** counts 求和（= 候选批次总数） */
  total: number;
}

/** `WorkerPoolCountsDto.counts` 元素类型（rust ProcessBatchCount）。 */
export interface ProcessBatchCountDto {
  process_id: string;
  process_code: string;
  process_name: string;
  /** 该工序候选批次数（cross-shelf 聚合） */
  count: number;
}

/** 自动分配模式：`COUNT` 按批次数填满；`TIME` 按累计预估工时填满。 */
export type AutoAllocateMode = 'COUNT' | 'TIME';

/** `POST /api/v2/prod/pool/auto-allocate` 请求（rust AutoAllocateRequest）。 */
export interface AutoAllocateRequest {
  process_id: string;
  shelf_id: string;
  mode: AutoAllocateMode;
  /** 填充比例 ∈ [0.0, 1.0]；out-of-range → 20704 BIZ_AUTO_ALLOCATE_INVALID_RATIO */
  fill_ratio: number;
}

/** `POST /api/v2/prod/pool/auto-allocate` 出参（rust AutoAllocateResult，
 *  vo/worker_pool.rs:96-118）。 */
export interface AutoAllocateResultDto {
  process_id: string;
  shelf_id: string;
  mode: AutoAllocateMode;
  fill_ratio: number;
  filled: WorkerFillItemDto[];
  /** 任一 worker 中途遇 None（池空 / 容量触顶） */
  pool_empty: boolean;
}

/** `AutoAllocateResultDto.filled[]` 元素（rust WorkerFillItem）。 */
export interface WorkerFillItemDto {
  worker_id: string;
  /** 目标：COUNT=批次数；TIME=累计分钟数 */
  target: number;
  /** 实际抢到的批次/工时（同 target 单位） */
  filled_count: number;
  /** 跳过原因（如「工种 max_held 未设置」）；存在 ⇒ 跳过该 worker。
   *  rust 侧 skip_serializing_if ⇒ 可能整个字段缺失。 */
  skipped_reason?: string | null;
}
