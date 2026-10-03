/** 外协公司 (OutsourceCompany) — 工序能力清单 / CRUD */

import type { ProcessCategory } from './process';

/** 单条外协公司（无映射） */
export interface OutsourceCompany {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 单条映射条目 */
export interface OutsourceCompanyProcessLink {
  process_id: string;
  process_code: string;
  process_name: string;
  category: ProcessCategory;
  sort_order: number;
}

/** 公司 + 映射的全部工序 */
export interface OutsourceCompanyWithProcesses extends OutsourceCompany {
  processes: OutsourceCompanyProcessLink[];
}

export interface OutsourceCompanyListResult {
  items: OutsourceCompany[];
  total: number;
  limit: number;
  offset: number;
}

export interface OutsourceCompanyCreatePayload {
  name: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  address?: string | null;
  is_active?: boolean;
  /** 创建时可一并提交 OUTSOURCE 工序 id 列表（雪花 ID 字符串，提交顺序即 sort_order） */
  process_ids?: string[];
}

export interface OutsourceCompanyUpdatePayload {
  name?: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  address?: string | null;
  is_active?: boolean;
}

export interface SetOutsourceCompanyProcessesPayload {
  /** 雪花 ID 字符串（前端 Number() 会丢精度，必须 str） */
  process_ids: string[];
}

// ============================================================
// 外协报价 (OutsourceQuote) — 2026-07-16 新增
// ============================================================

/** 报价状态枚举（含 legacy 值，后端可能返回历史数据） */
export type OutsourceQuoteStatus =
  'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'OUTSOURCING' | 'RECEIVED' | 'BILLED' | 'USED';

export const OUTSOURCE_QUOTE_STATUS_LABEL: Record<OutsourceQuoteStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '待审核',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  OUTSOURCING: '外协中(legacy)',
  RECEIVED: '已回收(legacy)',
  BILLED: '已对账(legacy)',
  USED: '已使用',
};

export const OUTSOURCE_QUOTE_STATUS_TAG: Record<
  OutsourceQuoteStatus,
  'info' | 'warning' | 'success' | 'danger' | ''
> = {
  DRAFT: 'info',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  OUTSOURCING: 'warning',
  RECEIVED: 'info',
  BILLED: 'success',
  USED: '',
};

/** 单条外协报价（service 层已注入预解析字段） */
export interface OutsourceQuote {
  id: string;
  /** 乐观锁版本号；update / approve / reject 入参必填 */
  version: number;
  part_id: string;
  outsource_company_id: string;
  process_id: string;
  /** Decimal 后端序列化为字符串 */
  price: string;
  note: string | null;
  status: OutsourceQuoteStatus;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  // 预解析字段
  part_serial_no: string | null;
  part_drawing_no: string | null;
  part_name: string | null;
  outsource_company_name: string | null;
  process_code: string | null;
  process_name: string | null;
  customer_path: string | null;
  /** 2026-08-02 新增：所属零件的客户下单单价（CNY；与 price 对比谈判空间） */
  part_unit_price: string | null;
  /** 2026-08-04 新增：所属零件加急标记（前端加急红底用） */
  is_urgent: boolean;
}

export interface OutsourceQuoteListResult {
  items: OutsourceQuote[];
  total: number;
  limit: number;
  offset: number;
}

export interface OutsourceQuoteCreatePayload {
  part_id: string;
  outsource_company_id: string;
  process_id: string;
  price: string;
  note?: string | null;
}

export interface OutsourceQuoteUpdatePayload {
  version: number;
  price?: string;
  note?: string | null;
}

export interface OutsourceQuoteApprovePayload {
  version: number;
  review_note?: string | null;
}

export interface OutsourceQuoteRejectPayload {
  version: number;
  review_note: string;
}

// ============================================================
// 统一外协可发送一览（2026-07-28 新增）
// ============================================================

/** 发送模式：APPROVAL 需审批，DIRECT 无需审批可直发 */
export type OutsourceSendMode = 'APPROVAL' | 'DIRECT';

/** 来源状态：PENDING 起始外协（OFFICE），IN_PROCESS 中间外协（在生产架） */
export type OutsourceSourceStatus = 'PENDING' | 'IN_PROCESS';

/** 可发送候选公司选项（DIRECT 时由 UI 选择） */
export interface OutsourceCompanyOption {
  id: string;
  name: string;
}

/** 外协可发送一览的统一返回项 */
export interface OutsourceSendableItem {
  /** 乐观锁版本号（OCC；前端发送时回传）。
   *  2026-07-29 PR-fix-0.2.0：批次化后改为 TPartBatch.version（批次级 OCC） */
  version: number;
  send_mode: OutsourceSendMode;
  source_status: OutsourceSourceStatus;
  part_id: string;
  part_serial_no: string | null;
  part_drawing_no: string | null;
  part_name: string | null;
  /** 可发送数量（行=批次：等于 batch_quantity） */
  quantity: number | null;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：可发送批次 id */
  batch_id: string;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：批次号（per-part 递增） */
  batch_no: number;
  /** 2026-07-29 PR-fix-0.2.0 批次化字段：批次数量 */
  batch_quantity: number;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  customer_path: string | null;
  next_process_id: string;
  next_process_name: string | null;
  /** PR-H 2026-07-28：源货架 code（绑了外协工序的货架，如 C2） */
  shelf_code: string | null;
  /** APPROVAL 单值；DIRECT 为 null（用 company_options） */
  outsource_company_id: string | null;
  outsource_company_name: string | null;
  /** DIRECT 时为该 part 可用的全部公司；APPROVAL 时为空数组（用单值字段） */
  company_options: OutsourceCompanyOption[];
  /** APPROVAL 时为该报价的 Decimal 字符串；DIRECT 为 null（直发无报价） */
  price: string | null;
  /** 2026-10-03 新增：APPROVAL 模式回指的报价 id（雪花 ID 字符串）；DIRECT 为 null。
   *  发送端点要求 `quote_id` 与 `direct` 必传其一，两者都不传返 400 —— 前端由本字段
   *  判定模式并组装 payload，字段缺失会把每一行都打回 400。 */
  quote_id: string | null;
  status_label: 'sendable';
}

export interface OutsourceSendableListResult {
  items: OutsourceSendableItem[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================
// 外协对账（2026-07-28 新增；2026-07-29 基于 t_outsource_quote 重写）
// ============================================================

/** PR-H 2026-07-29：对账页排序字段（对应 GET /outsource-companies/{id}/sent-parts?sort_by=...） */
export type OutsourceSentPartSortKey = 'PRICE' | 'SENT_AT' | 'RECEIVED_AT';

export interface OutsourceSentPartItem {
  /** t_outsource_shipment.id（行编辑端点入参） */
  shipment_id: string;
  /** OCC 乐观锁（shipment.version） */
  version: number;
  quote_id: string;
  part_id: string;
  part_drawing_no: string | null;
  part_name: string | null;
  customer_path: string | null;
  /** 历史行可能为 null */
  batch_no: number | null;
  process_id: string;
  process_name: string | null;
  quantity: number;
  /** Decimal 字符串；DIRECT 直发自动创建的报价为 "0" */
  unit_price: string;
  /** Decimal 字符串；unit_price × quantity。
   *  2026-10-03 起后端直出，本字段是对账页「总价」列的**单一真源** —— 非编辑态
   *  直接展示；仅当行进入编辑态且单价/数量被改过时才由前端用编辑缓冲重算。 */
  total_price: string;
  sent_at: string;
  received_at: string | null;
  /** OUTSOURCING / RECEIVED */
  status: string;
  is_billed: boolean;
  /** 2026-08-04 新增：所属零件加急标记（前端加急红底用） */
  is_urgent: boolean;
}

export interface OutsourceSentPartListResult {
  items: OutsourceSentPartItem[];
  total: number;
  limit: number;
  offset: number;
}

/** PR-H 2026-07-30：对账页行编辑 payload（POST /outsource-shipments/{shipment_id}/reconcile-update） */
export interface OutsourceReconciliationUpdatePayload {
  version: number;
  /** 单价；null = 不更新 */
  unit_price?: number | null;
  /** 数量；null = 不更新 */
  quantity?: number | null;
  /** 对账标记；null = 不更新 */
  is_billed?: boolean | null;
}

// ============================================================
// 外协中批次列表（2026-07-30 新增）
// ============================================================

export interface OutsourceInFlightItem {
  part_id: string;
  batch_id: string;
  batch_no: number;
  /** 当前批次**剩余待收量**（部分接收后源批次留余量，本值随之变小），
   *  不是 shipment 的发出量。 */
  quantity: number;
  serial_no: string | null;
  drawing_no: string | null;
  name: string | null;
  is_urgent: boolean;
  customer_path: string | null;
  next_process_id: string | null;
  next_process_name: string | null;
  outsource_company_id: string;
  outsource_company_name: string | null;
  /** 开口 shipment 的发出时间（ISO datetime） */
  sent_at: string;
  /** t_part_batch.version —— `receive-from-outsource` 的 OCC 锚（**不是** shipment 的
   *  version；部分接收拆批后源批次 version 会自增，列表每次重取都要带最新值）。 */
  version: number;
}

export interface OutsourceInFlightListResult {
  items: OutsourceInFlightItem[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================
// 可报价零件 picker（2026-10-03 契约对齐）
// ============================================================

/** `GET /outsource-quotes/quotable-parts` 单行。
 *
 *  行粒度是「一个 (零件, OUTSOURCE 工序) 组合一行」—— 后端已 DISTINCT ON 去重，
 *  所以同一零件挂多个外协工序时会出多行，前端**不要**再做 part_id 级去重。
 *  与 `PartListItem` 的关键差异：显式带 `next_process_id` / `next_process_name`
 *  （自动填工序所依赖的字段），另有 picker 专用的 `shelf_id` / `shelf_code`。 */
export interface QuotablePart {
  id: string;
  serial_no: string | null;
  drawing_no: string;
  name: string;
  is_urgent: boolean;
  /** Decimal 字符串（客户下单单价，非外协报价单价） */
  unit_price: string;
  customer_id: string;
  /** L2 客户名 */
  customer_name: string | null;
  /** L1 客户名 */
  l1_customer_name: string | null;
  customer_path: string | null;
  shelf_id: string;
  shelf_code: string;
  /** 正式字段（后端 VO 显式声明），非必为 OUTSOURCE 类别之外的值 */
  next_process_id: string;
  next_process_name: string;
}

export interface QuotablePartListResult {
  items: QuotablePart[];
  total: number;
  limit: number;
  offset: number;
}
