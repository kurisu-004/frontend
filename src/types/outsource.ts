/** 外协公司 (OutsourceCompany) — 工序能力清单 / CRUD */

/** 单条外协公司（无映射）—— 后端 `OutsourceCompanyOut`，**7 字段**。
 *
 *  2026-10-09 契约对齐删 `created_at` / `updated_at`：公司一览是外协看板 / 报价 /
 *  对账三处的公司下拉数据源，页面只渲染「名称 + 联系人 + 启停用」，两列时间戳零消费方，
 *  而每次写端点都会让它们变化 ⇒ 纯粹的缓存抖动。 */
export interface OutsourceCompany {
  id: string;
  /** 乐观锁版本号；`POST /{id}/update` 与 `POST /{id}/soft-delete` **必传**。
   *  每次 UPDATE / SOFT-DELETE 自增。 */
  version: number;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  address: string | null;
  is_active: boolean;
}

/** 单条映射条目 —— 后端 `OutsourceCompanyProcessLinkOut`，**3 字段**。
 *
 *  2026-10-09 契约对齐删 `category` / `sort_order`：
 *  - `category` 与勾选框候选集（`GET /proc/processes?category=OUTSOURCE`）恒等，冗余；
 *  - `sort_order` 从不由 VO 消费（只被写侧赋值、被看板 SQL 的 ORDER BY 读）。 */
export interface OutsourceCompanyProcessLink {
  process_id: string;
  process_code: string;
  process_name: string;
}

/** 公司 + 映射的全部工序 —— 后端 `OutsourceCompanyWithProcessesOut`，**8 字段**
 *  （`OutsourceCompany` 七项 + `processes[]`）。 */
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
  /** 创建时可一并提交 OUTSOURCE 工序 id 列表（雪花 ID 字符串，提交顺序即映射展示顺序） */
  process_ids?: string[];
}

/** `POST /outsource-companies/{id}/update` 入参。
 *
 *  2026-10-09 契约对齐：新增**必填** `version`（OCC 锚）与 `process_ids`（三态：
 *  `undefined`/缺省 = 不动工序映射、`[]` = 清空、`[a,b]` = 整体替换）。`process_ids`
 *  吸收了同轮硬切删除的 `POST /{id}/processes` 端点。 */
export interface OutsourceCompanyUpdatePayload {
  version: number;
  name?: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  address?: string | null;
  is_active?: boolean;
  /** 缺省 / `undefined` = 不动；`[]` = 清空；非空 = 整体替换。 */
  process_ids?: string[];
}

/** `POST /outsource-companies/{id}/soft-delete` 入参。
 *
 *  2026-10-09 契约对齐：新增**必填** `version`。此前该端点无 body，service 内部自读
 *  version 守乐观锁，等于用自己读到的值守自己的锁、`UPDATE … WHERE version = <刚读的>`
 *  恒成立。缺 version 是 axum 的 HTTP 422 **纯文本**响应，不是业务信封。 */
export interface OutsourceCompanySoftDeletePayload {
  version: number;
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

export interface OutsourceQuoteApprovePayload {
  version: number;
  review_note?: string | null;
}

export interface OutsourceQuoteRejectPayload {
  version: number;
  review_note: string;
}

/** `POST /outsource-quotes/{id}/submit` 入参 —— 2026-10-09 新增**必填** `version`。
 *  此前该端点无 body（service 自读 version 守乐观锁，形同虚设）；缺 version 是
 *  axum 的 HTTP 422 纯文本响应，不是业务信封。 */
export interface OutsourceQuoteSubmitPayload {
  version: number;
}

/** `POST /outsource-quotes/{id}/soft-delete` 入参 —— 2026-10-09 新增**必填**
 *  `version`（理由同 submit）。 */
export interface OutsourceQuoteSoftDeletePayload {
  version: number;
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

/** `GET /outsource-companies/{id}/sent-parts` 单行 —— 后端 `OutsourceSentPartOut`，
 *  **16 字段**。
 *
 *  2026-10-09 契约对齐删 `quote_id` / `part_id`：行编辑端点按 `shipment_id` 取锚，
 *  页面列展示的是 `part_drawing_no` / `part_name` 两个可读字段，留着等于把同一份
 *  零件标识序列化两次且分叉。 */
export interface OutsourceSentPartItem {
  /** t_outsource_shipment.id（行编辑端点入参） */
  shipment_id: string;
  /** OCC 乐观锁（shipment.version） */
  version: number;
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
  /** 后端 SQL 硬编码只返 `OUTSOURCING` / `RECEIVED` 两值（DB CHECK 里的 `CANCELLED`
   *  无任何代码路径写入），故收成两值枚举 —— 第三个枚举值是死代码。 */
  status: OutsourceSentPartStatus;
  is_billed: boolean;
  /** 2026-08-04 新增：所属零件加急标记（前端加急红底用） */
  is_urgent: boolean;
}

/** 对账行的状态枚举（后端 SQL 硬编码两值，契约收口）。 */
export type OutsourceSentPartStatus = 'OUTSOURCING' | 'RECEIVED';

/** `GET /outsource-companies/{id}/sent-parts` 分页信封 —— 2026-10-09 加两个公司字段。
 *
 *  `outsource_company_id` 是请求 id 的回显；`outsource_company_name` **公司不存在 /
 *  已软删时为 `null`**（端点本身不因公司缺失而 404，页头要能显示「未知公司」）。 */
export interface OutsourceSentPartListResult {
  outsource_company_id: string;
  outsource_company_name: string | null;
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
