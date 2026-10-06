/**
 * 命名约定（2026-09-25 同步）：
 * - `PartItem` ≡ 后端 `PartDetailOut`（单件详情完整字段，含 customer_name / l1_customer_name / current_batch_id 等）
 * - `PartListItem` ≡ 后端 `PartListItem`（列表条目，字段较 PartItem 少）
 * - `PartCreatePayload` ≡ 后端 `PartCreateRequest`
 * - `PartUpdatePayload` ≡ 后端 `PartUpdateRequest`
 * 命名不一致是有意的历史选择；不要混用。
 *
 * 注意：本文件下方另有一个早期的 `PartItem` interface（id / drawingNo 等 camelCase 旧形态），
 * 那是入库表单用的本地视图类型，与上方注释描述的"PartItem ≡ PartDetailOut"是两套类型，
 * 不冲突（前端在 PartBatchManualTab 等录入表单场景消费旧 PartItem，详情 / 列表消费 PartDetailOut
 * 等价的 PartItem）。新代码请按上下文选用，跨场景不要混用。
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
   *  **填充端点只有 `GET /com/union-list` 与 `GET /parts`**；复用同一 VO 的其余 5 个
   *  端点（`GET /parts/pending-programming` / `GET /parts/by-work-type/{id}` /
   *  `GET /parts/by-worker/{id}` / `GET /parts/pickable-by-work-type/{id}` /
   *  `POST /assemblies/{id}/children`）恒 null。故本字段必须 optional + 可空。 */
  delivered_quantity?: number | null;
  note: string | null;
  customer_name: string | null;
  /** 2026-09-27 前后端字段对齐：原 parent_customer_name rename 为 l1_customer_name
   *  （与后端 Rust PartListOut 字段一致）。customer_path 派生路径 = l1 + name，
   *  前端不消费该字段（cellRender 内自行拼接）。 */
  l1_customer_name: string | null;
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
   *  2026-10-03 订正：原注释写的 `/outsource-quotes/quotable-parts` 在 Rust 后端**根本
   *  不存在**。当前真实情况：**报工台两个列表端点都填** ——
   *  `GET /parts/pickable-by-work-type/{work_type_id}`（扫码台 PICK_UP 列表）与
   *  `GET /parts/by-worker/{worker_id}`（放回 / 送检 / HeldPartsBadge）；这两个端点的
   *  行本来就是批次行，后端取行 SQL 投影 `b.id` / `b.version` 并覆写 `PartListItem` 的
   *  两个字段。`/com/union-list`、`GET /parts` 及其余复用该 VO 的端点**键在但恒为 null**
   *  （无 `skip_serializing_if`，故不是 undefined）—— 后端刻意不填：part 级行的单位是
   *  part，一个 part 的活跃批次可能不止一个，填任一都是错锚点。
   *  故零件一览 / 工单合列表的批次锚点缺失是**后端有意决策**导致的既有状态，
   *  调用方须显式报错，不可用 part_id 顶替。
   *
   *  ⚠️ 本接口**不含**工序链派生四件套（`chain_state` 等）：那是报工台两页的行 VO 独有
   *  字段，消费方走 `@/composables/queries/schemas.ts::ScanPartRowSchema`（本类型的
   *  生产消费方 `/com/union-list`、`GET /parts` 用不到链字段）。 */
  batch_id?: string | null;
  /** 2026-10-03 后端新增：批次 OCC 版本（t_part_batch.version），与 batch_id 同源，
   *  填充端点同上（报工台两个列表端点）。 */
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

/** 后端 PartEventType 枚举 */
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
  | 'RECEIVED_TO_INSPECTION'
  | 'QUOTE_CREATED'
  | 'QUOTE_APPROVED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'SPLIT'
  | 'RECALLED'; // 2026-08-05 召回：ON_SHELF/PROGRAMMING → PENDING/PROGRAMMING

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
};

/** 扫码台允许的 event_type 子集 */
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
