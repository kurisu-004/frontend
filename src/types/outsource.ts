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

/** 外协候选行的公司下拉项（DIRECT 路径由用户在拖拽落点上选的那家公司）。
 *  2026-10-09：`/outsource-sendable` 的列表类型随外协看板取代双表格页删除后，本条是
 *  外协域**唯一**还在消费的公司选项类型 —— `api/outsource.contract.ts` 的候选 DTO
 *  `company_options` 用它（与 Zod 侧的 `outsourceCompanyOptionSchema` 一一对应）。 */
export interface OutsourceCompanyOption {
  id: string;
  name: string;
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
// 可报价零件 picker（2026-10-03 契约对齐）
// ============================================================

/** `GET /outsource-quotes/quotable-parts` 单行 —— 10 字段。
 *
 *  2026-10-03 契约对齐：行粒度是「**一个零件一行**」，筛选条件是「有活跃
 *  `status='PENDING'` 批次的零件」（报价是给还没下发的在制件提前锁价），不再按
 *  OUTSOURCE 工序货架展开。故 VO 删掉 `shelf_id` / `shelf_code` / `next_process_id` /
 *  `next_process_name` 四个与「货架上的某道工序」绑定的字段。
 *  代价：picker 不再能推断报价工序，新建报价的工序由操作员在独立的工序下拉里选
 *  （数据源是全部外协工序）。 */
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
}

export interface QuotablePartListResult {
  items: QuotablePart[];
  total: number;
  limit: number;
  offset: number;
}
