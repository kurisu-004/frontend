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

/** 后端订单状态枚举（数据大屏用） */
export type OrderStatus =
  | 'PENDING'
  | 'PROGRAMMING'
  | 'IN_PROCESS'
  | 'INSPECTION'
  | 'READY_TO_SHIP'
  | 'DELIVERED'
  | 'REPAIRING'
  | 'OUTSOURCE'
  | 'COMPLETED'
  | 'CANCELLED';

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
 * 2026-08-31 保留：ScanBatchPickerDialog.vue 仍引用此类型作 dead-code 保留备查，
 * inspection 页本身已切回 v1 + BatchPickerDialog，零运行时调用。 */
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

/** 2026-08-31 新增：扫码 v2 端点响应——批次列表。
 * 2026-08-31 保留：ScanBatchPickerDialog.vue 仍引用此类型作 dead-code 保留备查。 */
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
  /** 单价 */
  unit_price: number;
  /** 总价 = quantity * unit_price（2026-07-24 新增；后端落库字段，UI 直接展示） */
  total_price: number;
  /** 请购日期 */
  request_date: string;
  planned_delivery_date: string;
  is_urgent: boolean;
  status: OrderStatus;
  /** PR-F 2026-07-17：送货单字段 */
  order_no: string | null;
  system_delivery_date: string | null;
  /** 已送数量：未软删批次中 status ∈ (DELIVERED, COMPLETED) 的 quantity 之和；装配件行恒为 null */
  delivered_quantity?: number | null;
  note: string | null;
  customer_name: string | null;
  parent_customer_name: string | null;
  customer_path: string | null;
  /** 2026-09-16 起为后端派生（min-progress 活跃批次的 location：
   *  OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY），无活跃批次为 null。
   *  t_part 瘦身（PR-2 2026-09-16）：原 delivery_note_id / shelf_code / worker_name /
   *  outsource_company_name / current_holder_display / actual_delivery_date /
   *  has_been_repaired 等 part 级字段随列下线一并删除，位置展示统一由
   *  location + holder_name 承接。 */
  location: string | null;
  /** 2026-09-16 新增：min-progress 活跃批次 holder 解析名
   *  （货架 code / 工人姓名 / 外协公司名；OFFICE 或无活跃批次为 null）。 */
  holder_name?: string | null;
  /** PR-H 2026-07-28：下一工序 id（NULL = 未设置；新建外协报价 picker 自动填工序用） */
  next_process_id: string | null;
  /** PR-H 2026-07-28：下一工序名 */
  next_process_name: string | null;
  /** 2026-09-16 新增：工艺链 id（雪花 ID 字符串；null = 未制定工序）。
   *  后端 2026-09-16 起在 GET /parts 列表项与 GET /parts/{id} 详情出参新增；
   *  工序制定页「待制定 / 已制定」分组改由本字段驱动（替代原 step_count 懒加载派生）。 */
  process_chain_id?: string | null;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：仅 /outsource-quotes/quotable-parts 走批次时填充 */
  batch_id?: string | null;
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
  /** 2026-07-30：创建时间（装配件行带出） */
  created_at?: string | null;
  /** C2 2026-08-05：装配件携带的「命中子件」；仅当 next_process_ids / locations /
   *  holder_ids 筛选激活时填充。其余情况为 null。前端 loadChildren 优先消费。 */
  matched_children?: PartListItem[] | null;
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
