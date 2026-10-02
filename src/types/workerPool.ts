// 2026-08-26 新增：工人队列调度看板的领域类型定义。
// 雪花 ID 全部 string（CLAUDE.md #3）；字段命名对齐 Rust 后端 WorkerPoolState / TakenItem。
//
// 2026-09-30：删 `AssignRequest` / `ReturnRequest` —— 它们描述的是后端
// `POST /admin/worker-pool/{assign,remove}` 的旧请求体，已被
// `POST /prod/pool/move` 的 `MoveRequest`（tagged enum from/to）取代；
// 类型本体见 src/api/workerPool.contract.ts，无消费者故直接删除。
//
// 2026-10-02 新增 `BatchCardModel`：生产队列看板唯一批次卡片 view-model
// （BatchCard.vue 的 props 类型）。工序池 / 工人列 / 待下发池三处 wire DTO
// （PoolBatchItemDto / HeldBatchItemDto / PendingBatchItemDto）字段集各不相同，
// 统一经 views/workers/composables/poolItemToCard.ts 适配成本类型，
// 组件层不再感知 DTO 差异。

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

export interface BatchCardModel {
  /** t_part_batch.id，雪花 ID，string */
  batch_id: string;
  /** t_part.id，雪花 ID，string */
  part_id: string;
  /** 展示串，已带 B 前缀（如 'B1024'）——适配层拼，组件直接渲染 */
  batch_no: string;
  /** t_part.name（零件 / 工单名称）—— 卡片 header 展示的就是它 */
  part_name: string;
  /** t_part.drawing_no 图号 */
  drawing_no: string;
  /** t_part.serial_no，可空 */
  serial_no: string | null;
  /** t_part_batch.quantity 批次数量 */
  quantity: number;
  /** t_part.system_delivery_date，ISO 'YYYY-MM-DD' —— 卡片 body 唯一交期字段 */
  system_delivery_date: string | null;
  /** t_part.planned_delivery_date，ISO 'YYYY-MM-DD' —— 只进 tooltip（候选池 DTO 不带该字段，恒 null） */
  planned_delivery_date: string | null;
  /** 加急标记：决定左侧竖条默认色 + body「加急」tag */
  is_urgent: boolean;
  /** 该批次对应 part 是否已上传 CNC 程序（G 代码，后端 EXISTS 派生）—— body「已编程」tag */
  has_cnc_program: boolean;
  /** L1 客户名（一级集团，t_customer L1.name） */
  customer_l1: string | null;
  /** L2 客户名（叶子，t_customer L2.name） */
  customer_l2: string | null;
  /** t_applicant.name 申请人 */
  applicant_name: string | null;
  /** t_part.note 业务备注 */
  note: string | null;
  /** 所在位置：工序池 = 货架 code；工人持有 = location enum；待下发 = null（尚未落位） */
  location: string | null;
  /**
   * 该 batch **当前所在货架 ID**（t_part_batch.current_holder_id）。
   *
   * 仅工序池侧（`poolItemToCard` 从 `PoolBatchItemDto.shelf_id`）填充；工人持有侧
   * 与待下发侧恒为 null —— batch 在 worker 手里、或尚未下发，没有"货架位置"。
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
  batches: BatchCardModel[];
}
