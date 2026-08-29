// 送货单管理（PR-G 2026-07-22 新增；2026-07-23 R2-C 扩字段 + status 收紧）.
// 形态对齐 frontend/src/types/parts.ts。

import type { OrderStatus } from './parts'

export type DeliveryNoteStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PICKED_UP'
  | 'ARCHIVED'

export const DELIVERY_NOTE_STATUS_LABEL: Record<DeliveryNoteStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '待送货',
  // 2026-07-23：司机扫码送货后单据停在 PICKED_UP（不再自动 archive），展示为「已送货」
  PICKED_UP: '已送货',
  ARCHIVED: '已归档',
}

// Element Plus el-tag type 映射：未配置则降级为 plain info。
export const DELIVERY_NOTE_STATUS_TAG: Record<
  DeliveryNoteStatus,
  'info' | 'warning' | 'success' | 'danger' | ''
> = {
  DRAFT: 'info',
  SUBMITTED: 'warning',
  PICKED_UP: 'success',
  ARCHIVED: '',
}

// 一览 sort key
export type DeliveryNoteSortKey =
  | 'CREATED_AT'
  | 'SUBMITTED_AT'
  | 'PICKED_UP_AT'
  | 'DELIVERY_NOTE_NO'
export type DeliveryNoteSortDir = 'ASC' | 'DESC'

export interface DeliveryNoteLineItem {
  /** 批次 id（行身份；2026-07-29 批次化） */
  id: string
  /** 2026-08-29：批次乐观锁版本；调用 batch-to-* 时必填。
   *  后端 DeliveryNoteDetailOut.line_items[].version = t_part_batch.version。
   *  不是 part.version！part.version 是该工单所有批次的聚合投影。 */
  version: number
  /** 工单 id */
  part_id: string
  batch_no: number | null
  batch_label: string | null
  serial_no: string
  drawing_no: string
  name: string
  quantity: number
  is_urgent: boolean
  /** 2026-07-23 R2-C：收紧为 OrderStatus 联合类型（与 PartsList 同源） */
  status: OrderStatus

  // 2026-07-23 R2-C：与 PartsList 列对齐，便于 XLSX 打印 / 详情可视
  applicant_name: string | null
  request_date: string | null
  planned_delivery_date: string | null
  system_delivery_date: string | null
  order_no: string | null
  note: string | null

  // 客户信息：part.customer_id 是 L2 叶子；与 note.customer_id=L1 root 不同
  customer_name: string | null
  parent_customer_name: string | null
  customer_path: string | null

  /** 已扫过 = true；前端两种命名都允许读。 */
  is_scanned: boolean
  scanned: boolean

  // 2026-08-04：装配件父行字段（仅子件行填；散件为 null）。前端详情页用它构造
  // 可折叠的装配件父行，打印预览用它做「合并为一套」分组。
  assembly_id: string | null
  assembly_serial_no: string | null
  assembly_drawing_no: string | null
  assembly_name: string | null
  assembly_order_no: string | null
}

export interface DeliveryNoteOut {
  id: string
  version: number
  delivery_note_no: string
  customer_id: string
  customer_name: string | null
  parent_customer_name: string | null
  customer_path: string | null
  status: DeliveryNoteStatus
  submitted_at: string | null
  picked_up_at: string | null
  submitted_by: string | null
  picked_up_by: string | null
  driver_worker_id: string | null
  driver_worker_name: string | null
  part_count: number
  note: string | null
  /** YYYY-MM-DD；创建时默认今天；DRAFT/SUBMITTED 可手动改 */
  delivery_date: string | null
  created_at: string
  updated_at: string
}

export interface DeliveryNoteDetailOut extends DeliveryNoteOut {
  line_items: DeliveryNoteLineItem[]
  scanned_serials: string[]
}

/**
 * 候选入单零件（同 L1 根、status ∈ {INSPECTION, READY_TO_SHIP}、
 * 不在 active 单上的件）。`PartPickerDialog` 用此类型勾选。
 */
export interface DeliveryNoteCandidatePart {
  /** 工单 id */
  id: string
  /** 批次 id（入单回传用；2026-07-29 批次化） */
  batch_id: string
  batch_no: number | null
  batch_label: string | null
  serial_no: string
  drawing_no: string
  name: string
  quantity: number
  applicant_name: string | null
  /** INSPECTION 待检 / READY_TO_SHIP 已通过品检 */
  status: 'INSPECTION' | 'READY_TO_SHIP' | string
  planned_delivery_date: string | null
  /** 2026-08-01：订单号（picker 新增列与排序） */
  order_no: string | null
  // —— 2026-08-07 picker 富化 ——
  /** 零件所属二级（L2）客户名 */
  customer_name: string | null
  /** 所属一级（L1 root）客户名 */
  parent_customer_name: string | null
  /** L1 / L2 路径（与 note.customer_path 同格式） */
  customer_path: string | null
}

// 2026-07-23 Bug 4：精简为 4 类事件 + RECALLED（历史只读）
// WITHDRAWN 替代 RECALLED 作为新写入值；RECALLED 仅出现在已部署库的旧行。
// 详情页时间线统一通过 DELIVERY_NOTE_EVENT_TYPE_LABEL 翻译为中文。
export type DeliveryNoteEventTypeName =
  | 'CREATED'
  | 'SUBMITTED'
  | 'WITHDRAWN'
  | 'RECALLED' // 历史只读
  | 'PICKED_UP'

export const DELIVERY_NOTE_EVENT_TYPE_LABEL: Record<string, string> = {
  CREATED: '创建',
  SUBMITTED: '提交',
  WITHDRAWN: '撤回',
  RECALLED: '撤回', // 历史事件兜底；新代码不会再写此值
  PICKED_UP: '领取',
}

/** 未命中 DELIVERY_NOTE_EVENT_TYPE_LABEL 的事件保留原始值便于排查。 */
export function formatNoteEventLabel(eventType: string): string {
  return DELIVERY_NOTE_EVENT_TYPE_LABEL[eventType] ?? `未知事件（${eventType}）`
}

export interface DeliveryNoteEventOut {
  id: string
  delivery_note_id: string
  event_type: DeliveryNoteEventTypeName | string
  from_status: string | null
  to_status: string | null
  note: string | null
  created_by: string | null
  created_at: string | null
}

export interface DeliveryNotePickupScanOut {
  delivery_note_id: string
  /** 2026-07-23 改：后端不再维护扫码进度；恒为 0。前端基于本地 Set 判 ready。 */
  scanned_count: number
  expected_count: number
  /** 2026-07-23 改：后端无法判定 ready（无状态数据源）；恒为 false。 */
  ready: boolean
  /** 2026-07-23 改：恒为空；前端不应据此覆盖本地状态。 */
  scanned_serials: string[]
}

// 2026-08-21 v2 扫码建单（设计文档 §3 D3 / §5 / §6.2）---------------------

/** 设计文档 §3.2：送货单范围枚举。前端只展示，不参与业务校验。 */
export type NoteScope = 'L1_WIDE' | 'GROUP' | 'LEAF'

export const NOTE_SCOPE_LABEL: Record<NoteScope, string> = {
  L1_WIDE: '按一级客户',
  GROUP: '按装配件组',
  LEAF: '按零件',
}

/** 扫码建单 outcome（2026-08-28 后端路线 B 扩展到 4 种）。
 * - ADDED：草稿已建/复用 + 批次全部挂载
 * - ALREADY_PRESENT：草稿已存在 + 全部批次已在本单（幂等）
 * - CANDIDATES_AVAILABLE：散件仅 B 组（未送检），unresolved_targets 含候选批次
 * - PARTIAL_ADDED：装配件混合（A 组挂载 + B 组子件未送检） */
export type ScanOutcome =
  | 'ADDED'
  | 'ALREADY_PRESENT'
  | 'CANDIDATES_AVAILABLE'
  | 'PARTIAL_ADDED'

/** 扫码命中的实体（2026-08-28 路线 B 重构）。
 * `kind` 替代旧的 part_id / assembly_id 二选一，统一结构。 */
export interface ScanResolved {
  kind: 'PART' | 'ASSEMBLY'
  /** 雪花 ID 字符串（硬约束 #3）；part.id 或 assembly.id。 */
  id: string
  serial_no: string
  drawing_no: string
  name: string
}

/** 设计文档 §5.7.added_batches：本回合新入单 / 已存在的批次。 */
export interface ScanAddedBatch {
  batch_id: string
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
  quantity: number
}

/** 路线 B B 组候选批次（route B B-group candidate）。
 * 简化形态：仅含 batch_id / quantity / status，part 级信息在外层 ScanUnresolvedTarget。 */
export interface ScanAvailableBatch {
  /** 雪花 ID 字符串。 */
  batch_id: string
  /** 该批次当前数量。 */
  quantity: number
  /** 批次状态（如 PENDING / PROGRAMMING / IN_PROCESS / REPAIRING）。 */
  status: string
  /** 2026-08-29：批次乐观锁版本；转发到 batch-to-* 必须带。 */
  version: number
}

/** 路线 B 未就绪工单（route B unresolved target）。
 * 一个 part 可能挂在多个未送检批次（available_batches）。 */
export interface ScanUnresolvedTarget {
  part_id: string
  serial_no: string
  drawing_no: string
  name: string
  available_batches: ScanAvailableBatch[]
}

/** 草稿卡片要展示的最近加入批次条目（后端 limit=8，按 id DESC）。 */
export interface ScanRecentItem {
  batch_id: string
  part_id: string
  /** 工单序列号；t_part.serial_no 在 DB 里 nullable → 序列化可能为 null。 */
  serial_no: string | null
  drawing_no: string
  name: string
  /** 工单订单号；nullable。 */
  order_no: string | null
}

/** 设计文档 §5.7.note：扫码返回的当前草稿摘要（与 DeliveryNoteOut 字段对齐 + scope_label）。 */
export interface ScanNoteSummary {
  id: string
  delivery_note_no: string
  /** 乐观锁 version；后端 ScanDeliveryNoteSummaryDto 已返（hsh-erp-rust dto.rs:478），
   *  前端早先漏声明，导致 removeParts 只能另开 noteVersions 旁路。
   *  2026-08-23 补声明后，前端可直读 d.version。 */
  version: number
  /** note.customer_id 是 L1 root；与 parts.customer_id = L2 leaf 不同 */
  customer_id: string
  customer_name: string | null
  parent_customer_name: string | null
  customer_path: string | null
  status: DeliveryNoteStatus
  scope: NoteScope
  /** 服务端已算好的人类可读 scope 名（前端直接展示） */
  scope_label: string
  part_count: number
  delivery_date: string | null
  created_at: string
  updated_at: string
  /** 最近加入的批次行（max 8；后端在 scan 响应里直接返回）。 */
  recent_items: ScanRecentItem[]
}

/** 设计文档 §5.7 扫码端点响应。 */
export interface ScanDeliveryOut {
  outcome: ScanOutcome
  resolved?: ScanResolved
  note?: ScanNoteSummary
  added_batches?: ScanAddedBatch[]
  /** 2026-08-28 新增：仅 CANDIDATES_AVAILABLE / PARTIAL_ADDED 时非空。 */
  unresolved_targets?: ScanUnresolvedTarget[]
  message?: string
}

/** `POST /delivery-notes/{id}/submit` 结果类别（2026-08-29 起）。
 *
 * - `SUBMITTED`：全部批次已 `READY_TO_SHIP`，状态机 DRAFT → SUBMITTED 已提交
 * - `CANDIDATES_AVAILABLE`：存在仍在 INSPECTION 的已挂单批次，本次未提交，
 *   返回 `unresolved_targets[]` 供前端一键过检（转发 `batch-to-ship`）。
 *   走前端确认后再次 submit 即可。
 */
export type SubmitOutcome = 'SUBMITTED' | 'CANDIDATES_AVAILABLE'

/** `POST /delivery-notes/{id}/submit` 200 响应（2026-08-29 起）。
 *
 * - `outcome=SUBMITTED` → `note` 非 null，`unresolved_targets` 缺省
 * - `outcome=CANDIDATES_AVAILABLE` → `note` 为 null，`unresolved_targets` 非空（INSPECTION 批次）。
 *   shape 与 scan 的 `ScanUnresolvedTarget[]` 完全一致（共享 `AvailableBatchDto`）。 */
export interface SubmitDeliveryOut {
  outcome: SubmitOutcome
  note: DeliveryNoteOut | null
  /** 仅 `CANDIDATES_AVAILABLE` 时存在；`SUBMITTED` 时为 undefined（后端 skip_serializing_if）。 */
  unresolved_targets?: ScanUnresolvedTarget[]
}

export interface ScanDeliveryReq {
  code: string
}

// ============ 扫码阻塞响应类型（2026-08-23 新增）==============
/**
 * 后端 21418 / 21405 错误响应的 data.failures[] 元素结构。
 *
 * 当前后端只填 serial_no / name / reason；part_id / batch_id / drawing_no / status
 * 计划在 ~/Code/hsh-erp-rust/src/modules/delivery_note/dto.rs:523-529 的
 * ScanFailureDto 扩展后才有。前端先以可选字段写，扩展前「一键通过品检」按钮
 * 检测到 part_id 缺失时 disabled + tooltip 提示「需要后端扩展」。
 */
export interface BlockedScanItem {
  /** 后端扩展后必有；扩展前 undefined。雪花 ID 用 string（与全仓约定一致，见 BulkPassItem.part_id）。 */
  part_id?: string
  /** 后端扩展后必有；扩展前 undefined。 */
  batch_id?: string | null
  /** serial_no 通常必有；21418 后端有，21405 message 解析也有。 */
  serial_no: string
  /** 后端扩展后才有；扩展前 undefined。 */
  drawing_no?: string
  /** 名称（必填，弹窗列表展示）。 */
  name: string
  /** 后端扩展后才有；扩展前从 reason 字符串解析（如 status=IN_PROCESS → 'IN_PROCESS'）。 */
  status?: string
  /**
   * 兜底字段，可能取值：
   * - `status=XXX` → 未送检 / 阻塞类
   * - `on note DN-XXXX` → 已挂别的 active 单
   */
  reason: string
}

/**
 * 2026-08-28 后端路线 B：scan 路径仅 21421 BIZ_DELIVERY_BATCH_STATE_INVALID
 * 表示 C 组状态短路（DELIVERED / OUTSOURCE / IN_PROCESS 工人持有 / COMPLETED / CANCELLED）。
 * 原 21405 / 21418 不再由 scan 触发，由 add-parts 等保留使用。
 */
export const BLOCK_SCAN_CODES = [21421] as const

/** 触发「扫码阻塞确认弹窗」的 ApiError.code 取值类型。 */
export type BlockScanCode = (typeof BLOCK_SCAN_CODES)[number]
