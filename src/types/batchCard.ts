// src/types/batchCard.ts
//
// 2026-10-03 新增：`BatchCard.vue`（现 `src/components/BatchCard.vue`，全仓共享组件）
// 的 props 类型，及其领域扩展槽 `BatchCardExtra`。原先随 workerPool 域类型同文件
// 声明，卡片升级为共享组件后独立成文件：卡片现在被生产队列（工序池 / 工人列 /
// 待下发池）与外协看板两套域消费，view-model 不应挂在 workerPool 这个域的名字下。
//
// 拆分理由（与 `src/types/workerPool.ts` 的分工）：
//   - `workerPool.ts` 留 `Worker` / `ProcessPoolView` —— 生产队列域自有的看板结构；
//   - 本文件只描述「一张批次卡片长什么样」，与看板、工人、货架都无关。
//
// 字段来源：三个 wire DTO（`PoolBatchItemDto` / `HeldBatchItemDto` /
// `PendingBatchItemDto`）字段集各不相同，统一经各域自持的适配层
// （`views/production/composables/poolItemToCard.ts`）转换成本类型，组件零 DTO 依赖。

/** 2026-10-03 新增：批次卡片的**领域扩展槽**，只进 tooltip，不占 body 的 4 行预算。
 *
 *  字段全部可选且 nullable：任何域不填就当没这行（tooltip 逐行 `v-if` 挡掉），
 *  组件不因此感知「这是哪个域的卡片」。
 *
 *  与顶层可选字段 `version` 的性质**不同**，不要混淆：
 *   - `version` 是 `t_part_batch` 的一列、跨域通用（任何写操作都要带它做 OCC 乐观锁），
 *     故直接作为顶层字段；
 *   - `extra` 是**单域语义**的容器（外协公司 / 外协工序 / 单价 / 在途时间），换个域
 *     就没有这些概念，故留槽而不是继续往顶层堆。 */
export interface BatchCardExtra {
  /** 外协公司名（外协看板的「送到哪家 / 收回自哪家」） */
  outsource_company_name?: string | null;
  /** 外协工序名 */
  outsource_process_name?: string | null;
  /** 单价（Decimal 字符串，如 "12.50"） */
  price?: string | null;
  /** 发出时间（外协在途批次） */
  sent_at?: string | null;
  /** 接收能否免填工序 / 货架：false = 工序链缺失或指针漂移，前端必须让用户手填 */
  can_auto_receive?: boolean | null;
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
  /**
   * t_part_batch.version —— OCC 乐观锁锚，**不是任何领域的概念**，故作为顶层字段
   * （对比下方 `extra` 是单域扩展槽）。
   *
   * 用途：外协看板的「送到外协 / 从外协收回」两个写端点都**必传** version
   * （缺失或过期 → 40901 BIZ_VERSION_CONFLICT）。卡片是这两个操作拿 version 的载体，
   * 适配层从 DTO 直填（三个源 DTO 均已带该字段）。生产队列域当前不消费它，
   * 故为可选。
   */
  version?: number;
  /** 领域扩展槽（外协看板在用）—— 只进 tooltip，见 `BatchCardExtra`。 */
  extra?: BatchCardExtra;
}
