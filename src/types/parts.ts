/**
 * 命名约定（2026-09-25 同步）：
 * - `PartDetailDto` ≡ 后端 `PartDetailOut`（单件详情完整字段，含 customer_name / l1_customer_name / current_batch_id 等；
 *   定义在 `@/api/parts`，字段集由 `views/parts/detail/composables/partDetailSchema.ts` 守门）
 * - `PartListItem` ≡ 后端 `PartListItem`（列表条目，字段较 PartDetailDto 少）
 * - `PartCreatePayload` ≡ 后端 `PartCreateRequest`
 * - `PartUpdatePayload` ≡ 后端 `PartUpdateRequest`
 * 命名不一致是有意的历史选择；不要混用。
 *
 * 注意：本文件下方另有一个早期的 `PartItem` interface（id / drawingNo 等 camelCase 旧形态），
 * 那是入库表单用的本地视图类型，与上面的 `PartDetailDto`（在 `@/api/parts`）是两套类型，
 * 不冲突（前端在 PartBatchManualTab 等录入表单场景消费本文件的旧 PartItem，详情 / 列表消费
 * `PartDetailDto`）。新代码请按上下文选用，跨场景不要混用。
 */
export type PartCategory = '紧固件' | '轴承' | '传动件' | '电气件' | '油液' | '其他';
export type PartStatus = '启用' | '停用';
export type WarehouseStatus = '未入库' | '部分入库' | '已入库';

/** 后端订单状态枚举（数据大屏用）的**唯一字面量清单**。
 *
 *  2026-10-03 取舍登记：`REPAIRING` 成员保留，尽管后端 2026-10-01 起不再产生该状态
 *  （返修语义由 `t_part_batch.is_repairing` 布尔列承载，返修批次的 status 恒为
 *  IN_PROCESS）。未 apply 存量洗数据 migration 的环境仍可能返出 REPAIRING 行，
 *  删掉成员会让类型层与 Zod 枚举一起收窄、老环境直接解析失败。
 *
 *  2026-10-07：提到这里成为单一来源，`OrderStatus` 由它派生，dashboard 域 VO 的
 *  status 字段（Zod `z.enum`）也直接引用 —— 新增 VO 时不会漏加一处。 */
export const ORDER_STATUSES = [
  'PENDING',
  'PROGRAMMING',
  'IN_PROCESS',
  'INSPECTION',
  'READY_TO_SHIP',
  'DELIVERED',
  'REPAIRING',
  'OUTSOURCE',
  'COMPLETED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: '待生产',
  PROGRAMMING: '编程中',
  IN_PROCESS: '生产中',
  INSPECTION: '待品检',
  READY_TO_SHIP: '待送货',
  DELIVERED: '已送货',
  REPAIRING: '返修中',
  OUTSOURCE: '外协中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

export const ORDER_STATUS_TAG_TYPE: Record<
  OrderStatus,
  'info' | 'warning' | 'success' | 'danger' | 'primary'
> = {
  PENDING: 'info',
  PROGRAMMING: 'warning',
  IN_PROCESS: 'primary',
  INSPECTION: 'warning',
  READY_TO_SHIP: 'primary',
  DELIVERED: 'success',
  REPAIRING: 'danger',
  OUTSOURCE: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'info',
};

/** 2026-08-31 新增：扫码 v2 端点响应（GET /api/v2/parts/by-serial/{serial_no}/part-batches）。
 *  inspection 页已切回 v1 + BatchPickerDialog，本类型零运行时调用。 */
export interface PartScanInfoOut {
  id: string;
  drawing_no: string;
  name: string;
  quantity: number;
  customer_id: string | null;
  /** 形如 "2026-09-15"；null = 未设置。 */
  system_delivery_date: string | null;
  is_urgent: boolean;
  order_no: string | null;
  note: string | null;
}

/** 2026-08-31 新增：扫码 v2 端点响应——批次列表。本类型零运行时调用。 */
export interface PartBatchScanOut {
  id: string;
  quantity: number;
  /** 复用 OrderStatus 枚举；文案映射走 ORDER_STATUS_LABEL。 */
  status: OrderStatus;
  /**
   * 当前持有人显示名（后端 LEFT JOIN t_worker / t_shelf 输出）。
   * 可能语义：工人真名 / 货架 code / 公司名 / null。
   */
  holder_name: string | null;
  /** 批次乐观锁版本号（t_part_batch.version，非 part.version）。 */
  version: number;
}

export type PartSortKey =
  | 'PLANNED_DELIVERY_DATE'
  | 'REQUEST_DATE'
  | 'SYSTEM_DELIVERY_DATE'
  | 'CREATED_AT'
  | 'SERIAL_NO'
  | 'DRAWING_NO'
  | 'NAME'
  | 'ORDER_NO'
  | 'QUANTITY'
  | 'UNIT_PRICE'
  | 'TOTAL_PRICE';

export type SortDir = 'ASC' | 'DESC';

/**
 * `el-table` 列 `prop` → 后端 `PartSortKey` 映射。
 * PartsList / DeliveryNoteNew 共用；列头点击 → onSortChange → 触发服务端排序。
 * 命名对应 `model/enums.py::PartSortKey`。
 */
export const PART_SORT_PROP_MAP: Record<string, PartSortKey> = {
  serial_no: 'SERIAL_NO',
  drawing_no: 'DRAWING_NO',
  name: 'NAME',
  planned_delivery_date: 'PLANNED_DELIVERY_DATE',
  request_date: 'REQUEST_DATE',
  system_delivery_date: 'SYSTEM_DELIVERY_DATE',
  order_no: 'ORDER_NO',
  quantity: 'QUANTITY',
  unit_price: 'UNIT_PRICE',
  total_price: 'TOTAL_PRICE',
};

/** PartSortKey 合法值集合（用于持久化恢复时收敛到合法值）。 */
export const PART_SORT_KEY_SET: ReadonlySet<PartSortKey> = new Set(
  Object.values(PART_SORT_PROP_MAP),
);
/** PartSortKey → 列 prop 名（用于 default-sort / elTableRef.sort()）。 */
export const PART_SORT_KEY_TO_PROP: Record<PartSortKey, string> = Object.fromEntries(
  Object.entries(PART_SORT_PROP_MAP).map(([prop, key]) => [key, prop]),
) as Record<PartSortKey, string>;

/** 列表展示用窄出参（与 PartItem 不同，无 holder/next_process/assembly_id）。 */
export interface PartListItem {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增（后端 SQLAlchemy version_id_col）；
   *  当前端暂不消费，后续可用于冲突检测。 */
  version: number;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  /** 申请人姓名快照 */
  applicant_name: string | null;
  quantity: number;
  /** 单价（2026-09-27 前后端字段对齐：后端 rust_decimal::Decimal + serde-with-str
   *  序列化为 string，前端透传展示；行内编辑缓冲亦为 string）。 */
  unit_price: string;
  /** 总价 = quantity * unit_price（2026-09-27：与 unit_price 同形态，string）。 */
  total_price: string;
  /** 请购日期 */
  request_date: string;
  planned_delivery_date: string;
  is_urgent: boolean;
  status: OrderStatus;
  /** PR-F 2026-07-17：送货单字段 */
  order_no: string | null;
  system_delivery_date: string | null;
  /** 2026-10-03 订正：已送数量（语义以后端 VO 注释为准）。零件行 = 未软删批次中
   *  status ∈ (DELIVERED, COMPLETED) 的 quantity 之和，按「件」计；装配件行**也填**，
   *  语义是已送「套数」= MIN(子件已送件数 × 装配件套数 / 子件总量) —— PG 整数除法
   *  截断，子件总量为 0 者不参与，无子件为 0。
   *
   *  **填充端点只有 `GET /com/union-list` 与 `GET /parts`**；其余复用同一 VO 的端点
   *  恒 null —— `POST /assemblies/{id}/children` 仍成立，`GET /parts/by-work-type/{id}`
   *  已于 2026-10-13 在后端下线、无 alias，故当前只剩前者一个来源。
   *  报工台两条 list（`GET /prod/scan/pickable?work_type_id={id}` /
   *  `GET /prod/scan/held`）**不返本 VO** —— 出参是 `ScanListItem`
   *  （`@/api/productionScan.contract.ts`），故不在此列。本字段因此必须 optional + 可空。 */
  delivered_quantity?: number | null;
  note: string | null;
  customer_name: string | null;
  /** 2026-09-27 前后端字段对齐：原 parent_customer_name rename 为 l1_customer_name
   *  （与后端 Rust PartListOut 字段一致）。
   *  ⚠️ 2026-10-17 客户无限层级：**语义已从「直接父名」改成「根（L1）客户名」**（破坏性
   *  变更），配套新增本字段 `customer_path`（第 2 层到叶子的 ` / ` 拼接，不含 L1）。
   *  零件一览客户单元格主行读 `customer_path`、次行读 `l1_customer_name`。 */
  l1_customer_name: string | null;
  /** 2026-10-17 新增（客户无限层级改造）：第 2 层到叶子的名称用 ` / ` 拼接，**不含 L1**；
   *  零件自身即 L1 时等于它自己的名字。后端 `PartListItem.customer_path` 是**必填键、
   *  值非 null**（客户软删 / 父链成环时落**空串**），`composables/queries/schemas.ts`
   * 的 `partSchema` 已按必填声明。
   *  ⚠️ 本类型仍写成**可选**（`?`）：它同时是若干**非 `GET /com/union-list`** 出参的
   * 公共行形状（union-list 之外的复用 VO 在后端走 `From<TPart>` 投影，`customer_path`
   * 恒空串），以及大批跨 spec 共享 fixture —— 收紧成必填会让这些 fixture 与本 VO 的
   * 其它非 union-list 消费点一起变红。展示侧（`utils/elTableCell.ts::renderCustomerCell`）
   * 本来就按「空串 / 缺字段退回 `customer_name`」兜底，两种形态都接得住。 */
  customer_path?: string | null;
  /** 2026-09-16 起为后端派生（min-progress 活跃批次的 location：
   *  OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY），无活跃批次为 null。
   *  t_part 瘦身（PR-2 2026-09-16）：原 delivery_note_id / shelf_code / worker_name /
   *  outsource_company_name / current_holder_display / actual_delivery_date /
   *  has_been_repaired 等 part 级字段随列下线一并删除，位置展示统一由
   *  location + holder_name 承接。 */
  location: string | null;
  /** 2026-09-29 新增：是否已上传 CNC 程序（true=已编程 / false=未编程）。
   *  仅 chain 含 CNC 工序的 part 才有非 false 值；其它 part 恒为 false。
   *  本字段**保留**（part 域契约仍在返）：`GET /api/v2/parts/pending-programming`
   *  与 `GET /api/v2/com/union-list` 的 PartListItem 都带此字段（沿 backend-rust
   *  `t_part_cnc_program` 表 EXISTS 判定派生）。
   *  2026-10-01 备注：「待编程一览」页（cnc/PendingProgrammingList）已改读 prod 域
   *  `GET /api/v2/prod/programming/pending`（恒返空的老端点已弃用），其出参是
   *  ProgrammingItem（见
   *  views/cnc/composables/pendingProgrammingSchema.ts::pendingProgrammingItemSchema），
   *  字段同名 has_cnc_program 但**客户字段名不同**（parent_customer_name vs
   *  l1_customer_name），两者不可互相 cast。 */
  has_cnc_program: boolean;
  /** 2026-09-16 新增：min-progress 活跃批次 holder 解析名
   *  （货架 code / 工人姓名 / 外协公司名；OFFICE 或无活跃批次为 null）。 */
  holder_name?: string | null;
  /** 2026-09-16 新增：工艺链 id（雪花 ID 字符串；null = 未制定工序）。
   *  后端 2026-09-16 起在 GET /parts 列表项与 GET /parts/{id} 详情出参新增；
   *  工序制定页「待制定 / 已制定」分组改由本字段驱动（替代原 step_count 懒加载派生）。 */
  process_chain_id?: string | null;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：活跃批次 id（雪花 ID 字符串）。
   *  **2026-10-10 起本 VO 恒为 null**：唯一填充路径（报工台两条 list 端点）已迁往
   *  `prod::scan` 域、用独立 VO `ScanListItem`（`@/api/productionScan.contract.ts`），
   *  那边的 `batch_id` 必填非空。字段保留 —— 其余复用本 VO 的端点响应形状不变，
   *  删字段是破坏性 wire 变更。
   *  恒 null 的理由：这些路径的行语义单位是 part，一个 part 的活跃批次可能不止一个，
   *  填任一活跃批次都是错锚点。故零件一览 / 工单合列表的批次锚缺失是**后端有意决策**
   *  导致的既有状态，调用方须显式报错，不可用 part_id 顶替。
   *
   *  ⚠️ 本 VO **不含**工序链派生四件套（`chain_state` 等）：那是 `ScanListItem` 独有
   *  字段，消费方走 `@/views/production/scan/composables/scanSchema.ts` 的
   *  `scanPartRowSchema`（本类型的生产消费方 `/com/union-list`、`GET /parts` 用不到链字段）。 */
  batch_id?: string | null;
  /** 2026-10-03 后端新增：批次 OCC 版本（t_part_batch.version），与 batch_id 同源，
   *  填充口径同上（2026-10-10 起恒 null；报工台的批次 OCC 读 `ScanListItem.batch_version`）。 */
  batch_version?: number | null;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：批次号（per-part 递增） */
  batch_no?: number | null;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：批次数量（picker 选中后可挂在报价上） */
  batch_quantity?: number | null;
  /** 2026-07-30：列表行类型（零件一览合并装配件） */
  row_type?: 'PART' | 'ASSEMBLY';
  /** 2026-07-30：树表用，是否有子件（仅装配件行） */
  has_children?: boolean;
  /** 2026-07-30：子件数量（仅装配件行） */
  child_count?: number | null;
  /** 2026-10-05 新增：所属装配件 id（雪花 ID 字符串）；独立零件行为 null。
   *  `GET /com/union-list` 的 PART / PART_FLAT 段恒返该键，t_part 行的值 = 父装
   *  配件 id；复用同一 VO 的 `GET /parts` 家族不填 ⇒ 必须 optional + 可空。 */
  assembly_id?: string | null;
  /** 2026-07-30：创建时间（装配件行带出） */
  created_at?: string | null;
}

/** 零件一览「所在位置」树节点（GET /parts/location-tree）。 */
export interface LocationTreeNode {
  id: string; // 父节点=PartLocation 值；叶子=holder 雪花 ID 字符串
  name: string;
  location: string | null;
  children: LocationTreeNode[];
}
/** 行类型筛选：全部 / 仅零件 / 仅装配件 */
export type PartRowTypeFilter = 'ALL' | 'PART' | 'ASSEMBLY';

/**
 * `t_part_event.event_type` 的前端注册表。
 *
 * ⚠️ **三处副本，人工同步**（本 union / `PART_EVENT_LABEL` / `PART_EVENT_TAG_TYPE`）：
 * 后端 `t_part_event.event_type` 是 `varchar(30)`、**无 CHECK 约束、无 DB ENUM、
 * 无 Rust enum** ⇒ 本表是事实上的注册表，漏一个成员 = 时间线直接显示英文原文
 * （`usePartDetail.ts::eventLabel` 的兜底是 `PART_EVENT_LABEL[t] ?? t`，
 * 而 `partDetailSchema` 的 `event_type` 是 `z.string()` 不是 `z.enum`，
 * 未知值**静默**渲染、不会报错）。
 *
 * 后端侧的权威清单是 `backend-rust/src/shared/part_event/mod.rs` 的模块 doc
 * 事件 × 写侧域对照表 —— **加 / 删事件类型必须同时改那一侧**（纪律同
 * `DELIVERY_STATUSES` 三副本：后端常量 / 后端域常量 / 前端常量）。
 * ⚠️ **不要**让前端在构建期读后端源码文件（Docker 构建上下文里只有 frontend 仓，
 * 任何跨仓文件引用都会直接断构建）。同步只能靠人。
 *
 * 下方 12 个成员是 2026-10-17 补齐的：后端早就在写、前端一直没登记 ⇒ 零件详情
 * 时间线对它们一律显示原文。
 */
export type PartEventType =
  | 'CREATED'
  | 'RELEASED'
  | 'SENT_TO_PROGRAMMING'
  | 'CNC_RELEASED'
  | 'PLACED_ON_SHELF'
  | 'PICKED_UP'
  | 'RETURNED'
  | 'INSPECTED'
  | 'INSPECTION_FAILED'
  | 'STATUS_CHANGED'
  | 'REPAIR_STARTED'
  | 'REPAIR_COMPLETED'
  | 'SENT_TO_OUTSOURCE'
  | 'RECEIVED_FROM_OUTSOURCE'
  // 2026-10-03 新增：外协直送品检。外协件不走普通送检、直接进品检架时落这条事件。
  // ⚠️ 2026-10-10 起后端**已停写**（外协回收统一改写 RECEIVED_FROM_OUTSOURCE），
  // 保留仅为读存量历史行 —— **不要**因为「没人写了」就删，删了老工单时间线变原文。
  | 'RECEIVED_TO_INSPECTION'
  | 'QUOTE_CREATED'
  | 'QUOTE_APPROVED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'SPLIT'
  | 'RECALLED' // 2026-08-05 召回：ON_SHELF/PROGRAMMING → PENDING/PROGRAMMING
  // ==========================================================================
  // 2026-10-17 补齐：以下 12 个字面量后端一直在写（见
  // backend-rust/src/shared/part_event/mod.rs 模块 doc 的「写侧域对照表」），
  // 本注册表此前一个都没有 ⇒ 零件详情时间线直接显示 `RETURNED_TO_SHELF` 原文。
  // 逐条写侧：RETURNED_TO_SHELF / SENT_TO_INSPECTION / TRANSFERRED = prod::scan；
  // TAKEN_FROM_POOL / MOVED = prod::queue；BATCH_PASSED / BATCH_CANCELLED /
  // DELIVERED = prod::batch；FORCE_COMPLETED = prod::batch + assembly + part；
  // SERIAL_RELEASED = shared::batch（终态序列号归档）；SOFT_DELETED = part。
  // ==========================================================================
  /**
   * ⚠️ 易混①：`RETURNED` 与 `RETURNED_TO_SHELF` **语义相同**（放回货架），两者都保留：
   * - `RETURNED` 是 **Python 时代**写进 `t_part_event.event_type` 的历史字面量，
   *   生产库仍有存量行，删 alias 老工单时间线立刻变原文；
   * - `RETURNED_TO_SHELF` 是 **Rust 侧现行**写侧（`prod::scan::service::worker_scan`
   *   的 `event_type: "RETURNED_TO_SHELF"`）。
   * 同一个词今天还有第三重身份：**扫码台的 action 字面量**仍是 `RETURNED`
   *  （`SCAN_EVENT_TYPE_OPTIONS` 与后端 `scan_out.action` 都用它），action 层
   *  与 event_type 层刻意不同名，不要「统一」成同一个。
   *
   *  ⚠️ 仓内中文「归还」= 报工台语境下的「放回」，与后端口径一致：后端 `RETURNED_TO_SHELF`
   *  指的是**工人把批次放回生产架**（顺链推进 / 送检都走它），不是「归还给谁」的语义。
   *  中文与既有 `RETURNED: '归还'` 逐字一致即属刻意（Python 时代的老文案不能改），
   *  不是漏译。
   */
  | 'RETURNED_TO_SHELF'
  /**
   * ⚠️ 易混③：`SENT_TO_INSPECTION` 与 `INSPECTED` **是两条不同的事件**，必须靠
   * label 里的主语区分（`PART_EVENT_LABEL` 上有逐条说明），**不能靠 tag**。
   */
  | 'SENT_TO_INSPECTION'
  | 'TAKEN_FROM_POOL'
  | 'MOVED'
  | 'BATCH_PASSED'
  | 'BATCH_CANCELLED'
  /**
   * ⚠️ 易混②：这是 `t_part_event.event_type` 的**事件类型**，
   * 与 `ORDER_STATUS_LABEL.DELIVERED`（`t_part.status` 的订单状态）**同名但不同语义、
   * 不同表、不同取值域**。两者都在本文件里，改状态表时不要顺手动这里。
   */
  | 'DELIVERED'
  | 'FORCE_COMPLETED'
  | 'SERIAL_RELEASED'
  | 'SOFT_DELETED'
  | 'TRANSFERRED'
  // 2026-10-17 新增事件类型（后端同批上线）：强制送检。与 `SENT_TO_INSPECTION`
  //（工人主动送检）tag 不同（那条 primary、这条 warning）、中文也不同（「工人送检」/
  // 「强制送检」），两处差异都刻意保留。
  | 'FORCED_SENT_TO_INSPECTION';

export const PART_EVENT_LABEL: Record<PartEventType, string> = {
  CREATED: '创建',
  RELEASED: '开始生产',
  SENT_TO_PROGRAMMING: '发送至CNC编程',
  CNC_RELEASED: 'CNC下发生产',
  PLACED_ON_SHELF: '放置到货架',
  PICKED_UP: '领取',
  RETURNED: '归还',
  INSPECTED: '送检',
  INSPECTION_FAILED: '品检打回',
  STATUS_CHANGED: '状态变更',
  REPAIR_STARTED: '开始返修',
  REPAIR_COMPLETED: '返修完成',
  SENT_TO_OUTSOURCE: '发送至外协',
  RECEIVED_FROM_OUTSOURCE: '外协回收',
  RECEIVED_TO_INSPECTION: '外协回收送检',
  QUOTE_CREATED: '创建外协报价',
  QUOTE_APPROVED: '报价审核通过',
  CANCELLED: '取消',
  COMPLETED: '完成',
  SPLIT: '批次拆分',
  RECALLED: '召回',
  // ===== 2026-10-17 补齐的 12 条（见 PartEventType 上的同批注释）=====
  // ⚠️「归还」= 报工台语境下的「放回」（工人把批次放回生产架），后端口径如此；
  // 与 Python 时代那条 `RETURNED: '归还'` 逐字相同属刻意，不是漏译。
  RETURNED_TO_SHELF: '归还',
  /**
   * ⚠️ **为什么这条带主语、上面那条 `INSPECTED` 不带**（review 第 1 轮 MINOR-1）：
   * 三条「送检」是**三个不同的后端写侧**，其中两条会同框出现在同一条时间线上：
   *   · `SENT_TO_INSPECTION` —— 工人自己在**报工台**主动送检（`prod::scan::worker_scan`），
   *     **只有这一支计工人工时**（事件带 `worker_id`）；
   *   · `INSPECTED` —— 品检员 / 管理员在**待品检页**点送检（`prod::batch::to_inspection_core`），
   *     `worker_id` 为空、不计工时；
   *   · `FORCED_SENT_TO_INSPECTION` —— 品检员代工人在同一端点传 `force=true`，也不计工时。
   * 典型路径：工人报工台送检 → 品检打回（`INSPECTION_FAILED`）→ 回生产 → 品检页再送检，
   * 于是 `SENT_TO_INSPECTION` 与 `INSPECTED` 在同一条时间线上并排出现。
   *
   * 只改 **tag** 错不开：两条都取 `primary`；换成 `warning` 又会与
   * `FORCED_SENT_TO_INSPECTION` 撞色，等于把问题挪位置。**给中文加主语是唯一能同时
   * 解掉文案与配色的改法** —— `INSPECTED: '送检'` / `FORCED_SENT_TO_INSPECTION: '强制送检'`
   * 是既有文案，一个字都不动。
   */
  SENT_TO_INSPECTION: '工人送检',
  TAKEN_FROM_POOL: '队列取件',
  MOVED: '队列移动',
  BATCH_PASSED: '品检通过',
  BATCH_CANCELLED: '批次取消',
  DELIVERED: '已送货',
  FORCE_COMPLETED: '强制完成',
  SERIAL_RELEASED: '序列号释放',
  SOFT_DELETED: '工单删除',
  TRANSFERRED: '扫码接管',
  FORCED_SENT_TO_INSPECTION: '强制送检',
};

export const PART_EVENT_TAG_TYPE: Record<
  PartEventType,
  'primary' | 'success' | 'warning' | 'info' | 'danger'
> = {
  CREATED: 'primary',
  RELEASED: 'success',
  SENT_TO_PROGRAMMING: 'warning',
  CNC_RELEASED: 'success',
  PLACED_ON_SHELF: 'success',
  PICKED_UP: 'warning',
  RETURNED: 'info',
  INSPECTED: 'primary',
  INSPECTION_FAILED: 'danger',
  STATUS_CHANGED: 'info',
  REPAIR_STARTED: 'danger',
  REPAIR_COMPLETED: 'success',
  SENT_TO_OUTSOURCE: 'warning',
  RECEIVED_FROM_OUTSOURCE: 'success',
  // 与 RECEIVED_FROM_OUTSOURCE 同为外协回收后的正向流转，用 success 区分于
  // INSPECTION（primary，普通送检）。
  RECEIVED_TO_INSPECTION: 'success',
  QUOTE_CREATED: 'info',
  QUOTE_APPROVED: 'success',
  CANCELLED: 'danger',
  COMPLETED: 'success',
  SPLIT: 'info',
  RECALLED: 'warning',
  // ===== 2026-10-17 补齐的 12 条（与 PART_EVENT_LABEL 同批，键集必须逐字相同）=====
  // tag 取色口径：正向推进 = success、主流程动作 = primary / info、
  // 需要人介入的强推 / 接管 = warning、不可逆的负面终态 = danger。
  RETURNED_TO_SHELF: 'info',
  // ⚠️ 与 `INSPECTED` **同为 primary 是刻意的**：两条靠中文主语区分（「工人送检」vs
  // 「送检」），不是靠配色。理由见 PART_EVENT_LABEL.SENT_TO_INSPECTION 上的说明。
  SENT_TO_INSPECTION: 'primary',
  TAKEN_FROM_POOL: 'warning',
  MOVED: 'info',
  BATCH_PASSED: 'success',
  BATCH_CANCELLED: 'danger',
  DELIVERED: 'success',
  FORCE_COMPLETED: 'warning',
  SERIAL_RELEASED: 'info',
  SOFT_DELETED: 'danger',
  TRANSFERRED: 'warning',
  FORCED_SENT_TO_INSPECTION: 'warning',
};

/**
 * 扫码台（`scan_out.action`）允许的 event_type 子集 —— ⚠️ **刻意不含**上面
 * 2026-10-17 补齐的 12 条：它们是服务端**派生**出来的事件类型（工人放回、
 * 队列取件、品检通过……），不是用户能在扫码台手动选的 action。
 * action 侧至今只有 `PICKED_UP` / `RETURNED` / `INSPECTED` 三选一。
 * ⚠️ 别把本表与 `PartEventType` 当成同一维度：一个是**可选项**，一个是**全集**。
 */
export const SCAN_EVENT_TYPE_OPTIONS: PartEventType[] = ['PICKED_UP', 'RETURNED', 'INSPECTED'];

export interface PartItem {
  id: number;
  /** 内部编号（HSH+年月日+类型） */
  internalNo: string;
  /** 订单编号（外部单据号） */
  orderNo: string;
  /** 申请部门 */
  department: string;
  /** 图号 */
  drawingNo: string;
  /** 品名 / 零件名称 */
  partName: string;
  /** 分类 */
  category: PartCategory;
  /** 规格 */
  spec: string;
  /** 单位 */
  unit: string;
  /** 数量 */
  qty: number;
  /** 单价 */
  unitPrice: number;
  /** 加工单价（慢丝/线切割等） */
  processPrice: number;
  /** 总价 = 数量 * 单价 */
  totalPrice: number;
  /** 供应商 */
  supplier: string;
  /** 请购日期 YYYY-MM-DD */
  requestDate: string;
  /** 计划交期 YYYY-MM-DD */
  planDate: string;
  /** 送检日期 YYYY-MM-DD */
  inspectDate: string;
  /** 入库情况 */
  warehouseStatus: WarehouseStatus;
  /** 返修日期 / 备注 */
  reworkDate: string;
  /** 启用 / 停用 */
  status: PartStatus;
  /** 更新时间 YYYY-MM-DD HH:mm */
  updatedAt: string;
}

export interface PartSearchForm {
  internalNo: string;
  orderNo: string;
  drawingNo: string;
  partName: string;
  category: PartCategory | '';
  warehouseStatus: WarehouseStatus | '';
  status: PartStatus | '';
}

export interface OptionItem<T = string> {
  value: T;
  label: string;
}
