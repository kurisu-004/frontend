// 送货单管理 API 封装（PR-G 2026-07-22 重写；2026-07-23 增强：候选零件/可编辑日期/打印；
// 2026-08-24 切 v2：后端业务 REST 已迁 Rust，本文件全部走 apiV2）。
// 全部雪花 ID 入参为 string（CLAUDE.md §3 JS Number 丢精度）。
//
// 端点清单（与 src/modules/delivery_note/handler.rs 对应，全部 baseURL /api/v2）：
//   GET    /delivery-notes                       - listNotes
//   GET    /delivery-notes/pickup-pending        - listPickupPending
//   GET    /delivery-notes/candidate-parts       - listCandidateParts
//   POST   /delivery-notes                       - createNote
//   GET    /delivery-notes/{id}                  - getNote
//   GET    /delivery-notes/{id}/events           - listNoteEvents
//   POST   /delivery-notes/{id}/update           - updateNote
//   POST   /delivery-notes/{id}/add-parts        - addParts
//   POST   /delivery-notes/{id}/remove-parts     - removeParts
//   POST   /delivery-notes/{id}/submit           - submitNote
//   POST   /delivery-notes/{id}/recall           - recallNote
//   POST   /delivery-notes/{id}/pickup-scan      - pickupScan
//   POST   /delivery-notes/{id}/pickup           - pickup
//   POST   /delivery-notes/{id}/soft-delete      - softDelete
//   POST   /delivery-notes/{id}/print            - printNote
//   POST   /delivery-notes/{id}/print-labels     - printNoteLabels
//   POST   /delivery-notes/scan                  - scanDelivery (Rust v2 P3)
//   GET    /delivery-notes/batch-detail          - batchGetNotes (Rust v2 PR3; ids=1,2,3 逗号分隔)

import { apiV2 } from '@/api/http'
import type {
  DeliveryNoteCandidatePart,
  DeliveryNoteDetailOut,
  DeliveryNoteEventOut,
  DeliveryNoteOut,
  DeliveryNotePickupScanOut,
  DeliveryNoteSortDir,
  DeliveryNoteSortKey,
  DeliveryNoteStatus,
  ScanDeliveryOut,
  SubmitDeliveryOut,
} from '@/types/deliveryNote'

// v2 后端 DeliveryNoteListQuery.statuses 是逗号分隔字符串；
// src/api/http.ts 的 paramsSerializer 对 'statuses' 自动 join(',')，
// 调用方保持传数组，无需手动拼字符串。
export interface ListNotesParams {
  statuses?: DeliveryNoteStatus[]
  customer_id?: string
  keyword?: string
  sort_by?: DeliveryNoteSortKey
  sort_dir?: DeliveryNoteSortDir
  limit?: number
  offset?: number
}

export interface DeliveryNoteListResponse {
  items: DeliveryNoteOut[]
  total: number
  limit: number
  offset: number
}

/** 入单条目（2026-07-29 批次化）：批次 + 可选部分数量（小于批次量时后端自动拆分） */
export interface AddPartsItem {
  batch_id: string
  quantity?: number | null
}

export interface CreateNotePayload {
  customer_id: string
  /** YYYY-MM-DD；不传时服务端 fallback 到创建当天 */
  delivery_date?: string | null
  /** 原子带入首批零件（批次条目）；后端 add_parts 内部跑一次 */
  items?: AddPartsItem[]
  note?: string | null
}

export interface UpdateNotePayload {
  version: number
  /** 不传（undefined）= 不改；空串=清空（服务端支持时） */
  delivery_date?: string | null
  note?: string | null
}

export interface AddPartsPayload {
  items: AddPartsItem[]
  version: number
}

export interface RemovePartsPayload {
  batch_ids: string[]
  version: number
}

export interface VersionPayload {
  version: number
}

export interface PickupScanPayload {
  part_serial: string
  badge_code?: string | null
}

export interface PickupPayload {
  driver_worker_id: string
  version: number
  badge_code?: string | null
}

// 1) list
export async function listNotes(
  params: ListNotesParams = {},
): Promise<DeliveryNoteListResponse> {
  const query: Record<string, unknown> = {}
  if (params.statuses?.length) query.statuses = params.statuses
  if (params.customer_id) query.customer_id = params.customer_id
  if (params.keyword) query.keyword = params.keyword
  if (params.sort_by) query.sort_by = params.sort_by
  if (params.sort_dir) query.sort_dir = params.sort_dir
  if (params.limit !== undefined) query.limit = params.limit
  if (params.offset !== undefined) query.offset = params.offset
  const resp = await apiV2.get<DeliveryNoteListResponse>('/delivery-notes', {
    params: query,
  })
  return resp.data
}

// 2) pickup-pending list
export async function listPickupPending(
  customer_id?: string,
): Promise<DeliveryNoteOut[]> {
  const resp = await apiV2.get<{ items: DeliveryNoteOut[] }>(
    '/delivery-notes/pickup-pending',
    { params: customer_id ? { customer_id } : {} },
  )
  return resp.data.items
}

// 3) create draft
export async function createNote(
  payload: CreateNotePayload,
): Promise<DeliveryNoteOut> {
  const resp = await apiV2.post<DeliveryNoteOut>('/delivery-notes', payload)
  return resp.data
}

// 4) detail
export async function getNote(noteId: string): Promise<DeliveryNoteDetailOut> {
  const resp = await apiV2.get<DeliveryNoteDetailOut>(`/delivery-notes/${noteId}`)
  return resp.data
}

/** `GET /delivery-notes/batch-detail?ids=...` 响应载体（2026-08-24 后端 PR3 新增）。
 *
 * 后端 schema `BatchDeliveryDetailData { items: Vec<DeliveryNoteDetailOut> }`，
 * 信封解封后前端拿到该结构。items 按入参 ids 顺序装配，缺失 id 静默跳过。
 * 限制 1..=200 项，超出或非 i64 后端返回 400 / BIZ_INVALID_VALUE（20104）。
 */
export interface BatchDeliveryDetailData {
  items: DeliveryNoteDetailOut[]
}

/**
 * 按 ID 列表批量拉取送货单详情（含 line_items）。
 * 推荐用于 N 张草稿详情加载——一次往返替代 N 个 getNote。
 * 注意：后端按 ids 入参顺序返回；调用方需要按 id 自索引对齐到本地草稿。
 */
export async function batchGetNotes(ids: readonly string[]): Promise<DeliveryNoteDetailOut[]> {
  if (ids.length === 0) return []
  const resp = await apiV2.get<BatchDeliveryDetailData>('/delivery-notes/batch-detail', {
    params: { ids: ids.join(',') },
  })
  return resp.data.items
}

// 5) events
export async function listNoteEvents(
  noteId: string,
): Promise<DeliveryNoteEventOut[]> {
  const resp = await apiV2.get<DeliveryNoteEventOut[]>(
    `/delivery-notes/${noteId}/events`,
  )
  return resp.data
}

// 6) add-parts
export async function addParts(
  noteId: string,
  payload: AddPartsPayload,
): Promise<DeliveryNoteDetailOut> {
  const resp = await apiV2.post<DeliveryNoteDetailOut>(
    `/delivery-notes/${noteId}/add-parts`,
    payload,
  )
  return resp.data
}

// 7) remove-parts
export async function removeParts(
  noteId: string,
  payload: RemovePartsPayload,
): Promise<DeliveryNoteDetailOut> {
  const resp = await apiV2.post<DeliveryNoteDetailOut>(
    `/delivery-notes/${noteId}/remove-parts`,
    payload,
  )
  return resp.data
}

// 8) submit
// 2026-08-29：submit 返回 SubmitDeliveryOut（outcome 包装）。
// - SUBMITTED → note 非 null；CANDIDATES_AVAILABLE → unresolved_targets[] 非空 + note=null。
export async function submitNote(
  noteId: string,
  payload: VersionPayload,
): Promise<SubmitDeliveryOut> {
  const resp = await apiV2.post<SubmitDeliveryOut>(
    `/delivery-notes/${noteId}/submit`,
    payload,
  )
  return resp.data
}

// 9) recall
export async function recallNote(
  noteId: string,
  payload: VersionPayload,
): Promise<DeliveryNoteOut> {
  const resp = await apiV2.post<DeliveryNoteOut>(
    `/delivery-notes/${noteId}/recall`,
    payload,
  )
  return resp.data
}

// 10) pickup-scan (driver 累积扫描)
export async function pickupScan(
  noteId: string,
  payload: PickupScanPayload,
): Promise<DeliveryNotePickupScanOut> {
  const resp = await apiV2.post<DeliveryNotePickupScanOut>(
    `/delivery-notes/${noteId}/pickup-scan`,
    payload,
  )
  return resp.data
}

// 11) pickup (finalize)
export async function pickup(
  noteId: string,
  payload: PickupPayload,
): Promise<DeliveryNoteOut> {
  const resp = await apiV2.post<DeliveryNoteOut>(
    `/delivery-notes/${noteId}/pickup`,
    payload,
  )
  return resp.data
}

// 12) soft-delete
export async function softDeleteNote(
  noteId: string,
  payload: VersionPayload,
): Promise<void> {
  await apiV2.post(`/delivery-notes/${noteId}/soft-delete`, payload)
}

// 2026-07-23 增强 ----------------------------------------------------------
//
// 13) candidate-parts（一级客户下 INSPECTION + READY_TO_SHIP 候选入单零件）
export async function listCandidateParts(
  customerId: string,
): Promise<DeliveryNoteCandidatePart[]> {
  const resp = await apiV2.get<{ items: DeliveryNoteCandidatePart[] }>(
    '/delivery-notes/candidate-parts',
    { params: { customer_id: customerId } },
  )
  return resp.data.items
}

// 14) partial update（详情页改送货日期 / 备注）
export async function updateNote(
  noteId: string,
  payload: UpdateNotePayload,
): Promise<DeliveryNoteOut> {
  const resp = await apiV2.post<DeliveryNoteOut>(
    `/delivery-notes/${noteId}/update`,
    payload,
  )
  return resp.data
}

/**
 * 程序化下载送货单 XLSX（Axios blob + onDownloadProgress）。
 *
 * - 走标准 `apiV2` 拦截器：Authorization 头自动挂、40102 自动 refresh + 重试。
 * - `onDownloadProgress` 通过 `Content-Length` 给出 total，前端据此算出百分比。
 * - 拿到完整 Blob 后再用 `URL.createObjectURL` + `<a download>` 触发浏览器保存。
 */
export interface PrintNoteProgress {
  loaded: number
  total: number
}

export interface PrintNoteResult {
  blob: Blob
  filename: string
}

export interface PrintNotePayload {
  /** 2026-08-02 新增：批次 id 顺序（与预览组件产出对齐；空 = 走默认 DB 顺序） */
  custom_order?: string[]
  /** 2026-08-04 新增：装配件子件合并为一行（数量 1，单位套，总装图信息）；
   * false = 散件逐行（默认）。 */
  merge_assemblies?: boolean
  /** 2026-08-04 扩展：装配件合并行每套 override 数量（assembly_id 雪花 ID 字符串 → 套数，≥ 1） */
  merge_quantities?: Record<string, number>
}

/** 2026-08-07：标签导出专用（送货单 /print 不支持部分导出）。 */
export interface PrintLabelsPayload extends PrintNotePayload {
  /** 只打这些批次行（line_items[].id）；省略 = 全部。
   *  合并模式下需由调用方把装配件父行展开为组内子件 id。 */
  line_item_ids?: string[]
}

export async function printNote(
  noteId: string,
  payload: PrintNotePayload = {},
  onProgress?: (p: PrintNoteProgress) => void,
): Promise<PrintNoteResult> {
  // 2026-08-02 改 POST + body（携带 custom_order；GET 无法带 array body）
  const resp = await apiV2.post<Blob>(
    `/delivery-notes/${encodeURIComponent(noteId)}/print`,
    payload,
    {
      responseType: 'blob',
      onDownloadProgress: (event) => {
        onProgress?.({ loaded: event.loaded, total: event.total ?? 0 })
      },
    },
  )
  const filename =
    parseFilename(resp.headers['content-disposition']) ??
    `note-${noteId}.xlsx`
  return { blob: resp.data, filename }
}

/** 2026-08-05 PR-C5：打印标签 Excel（与 printNote 配对，触发浏览器二次下载）。
 * 2026-08-07 升级：可传 ``line_item_ids`` 只打勾选行。
 * 同一 payload 保证行口径与送货单完全一致。 */
export async function printNoteLabels(
  noteId: string,
  payload: PrintLabelsPayload = {},
  onProgress?: (p: PrintNoteProgress) => void,
): Promise<PrintNoteResult> {
  const resp = await apiV2.post<Blob>(
    `/delivery-notes/${encodeURIComponent(noteId)}/print-labels`,
    payload,
    {
      responseType: 'blob',
      onDownloadProgress: (event) => {
        onProgress?.({ loaded: event.loaded, total: event.total ?? 0 })
      },
    },
  )
  const filename =
    parseFilename(resp.headers['content-disposition']) ??
    `label-${noteId}.xlsx`
  return { blob: resp.data, filename }
}

/** 解析 `attachment; filename="delivery_note_F_123.xlsx"`。 */
function parseFilename(header: string | undefined): string | null {
  if (!header) return null
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return m ? decodeURIComponent(m[1].trim()) : null
}

/**
 * 扫码建单（P3，find-or-create draft + 4 outcome 软化路径）。
 *
 * 2026-08-28 后端路线 B 重构后响应 4 种 outcome：
 * - ADDED: 草稿已建/复用 + 批次全部挂载
 * - ALREADY_PRESENT: 草稿已存在 + 全部批次已在本单（幂等）
 * - CANDIDATES_AVAILABLE: 散件仅 B 组（未送检），unresolved_targets 含候选批次
 * - PARTIAL_ADDED: 装配件混合（A 组挂载 + B 组子件未送检）
 *
 * 批次 3 分组（A 直接入单 / B 候选送检 / C 短路报错）：
 *   - A 组（READY_TO_SHIP / INSPECTION）→ added_batches
 *   - B 组（PENDING / PROGRAMMING / IN_PROCESS 非工人持有 / REPAIRING）→ unresolved_targets
 *   - C 组（DELIVERED / OUTSOURCE / IN_PROCESS 工人持有 / COMPLETED / CANCELLED）→ 21421 硬错误
 *
 * 工人持有以 `t_part_batch.location='WORKER'` 判定（不用 current_holder_id，因为该列在
 * 货架上存的是 shelf.id）。旧 21405 / 21418 错误码已不再由 scan 触发。
 */
export async function scanDelivery(code: string): Promise<ScanDeliveryOut> {
  const resp = await apiV2.post<ScanDeliveryOut>('/delivery-notes/scan', { code })
  return resp.data
}

