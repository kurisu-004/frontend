// 后端零件 API 封装 —— 批量 / 批次化端点（批量新建、批次拆分/取消、品检待办、批量品检通过）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./batch 子域。
//
// 跨子域类型引用：PartItem / PartCreatePayload 定义在 ./crud；本文件所有批量响应
// （DTO / 失败明细）都涉及单件 DTO 与单件创建 payload，因此仅 type-only 导入，
// 运行时不会产生 ESM 循环。

import { api, apiV2, cleanParams } from '@/api/http'
import type { PartFileItem } from '@/types/part_file'
import type { PartCreatePayload, PartItem } from './crud'
import type { PartScanContextOut } from '@/types/parts'

export interface PartBatchFailure {
  index: number
  message: string
}

export interface PartBatchResult {
  created: PartItem[]
  failed: PartBatchFailure[]
}

export interface PartBatchFilePayload {
  /** 浏览器里的 File 对象（el-upload 的 uploadFile.raw）。 */
  data: Blob
  /** 原始文件名（含扩展名，后端据此判 PDF 类型）。 */
  filename: string
  /** 可选 content-type；后端会按文件扩展名兜底。 */
  contentType?: string
}

/**
 * 批量新建零件（multipart/form-data）。
 *
 * 后端 `POST /parts/batch` 2026-07-09 起接受 `data` (JSON 字符串) + `files` (PDF 数组)，
 * 文件与 items 按下标对齐；缺失位按无图处理。任一上传失败 → 整批回滚。
 *
 * 不手动设 Content-Type —— axios 会自动加正确的 multipart boundary。
 */
export async function batchCreateParts(
  items: PartCreatePayload[],
  files: (PartBatchFilePayload | null)[] = [],
): Promise<PartBatchResult> {
  const form = new FormData()
  form.append('data', JSON.stringify({ items }))
  files.forEach((f) => {
    if (f) form.append('files', f.data, f.filename)
  })
  const resp = await api.post<PartBatchResult>('/parts/batch', form)
  return resp.data
}

// ===== 2026-07-21：批量树形创建（PDF 批量上传，单页=独立零件，多页=装配件+子件） =====

export interface PartBatchTreeAssemblyFE {
  uid: string
  drawing_no: string | null
  name: string | null
  applicant_name: string | null
  applicant_id: string | null
  customer_id: string
  request_date: string
  planned_delivery_date: string
  system_delivery_date?: string | null
  order_no?: string | null
  note?: string | null
  is_urgent: boolean
  /** 装配体套数（默认 1）。2026-08-04 新增：用于背面页 Q: 打印。 */
  quantity: number
}

export interface PartBatchTreeItemFE {
  pdf_index: number
  page_index: number
  assembly_uid: string | null
  is_master: boolean
  drawing_no: string
  name: string
  applicant_name: string | null
  applicant_id: string | null
  quantity: number
  customer_id: string
  request_date: string
  planned_delivery_date: string
  system_delivery_date?: string | null
  order_no?: string | null
  note?: string | null
  is_urgent: boolean
  /** PR-H 2026-07-28：含税单价（来自历史价确认单 G 列；可空） */
  unit_price?: number | null
  /** PR-H 2026-07-28：含税价格（来自历史价确认单 I 列；空时按 unit_price × quantity 计算） */
  total_price?: number | null
  /** PR-H 2026-07-28：3D 模型下标（指向 three_d_models 数组；null = 不挂） */
  three_d_index?: number | null
}

export interface PartBatchTreePartResultFE {
  uid: string
  kind: 'part' | 'assembly_child'
  part: PartItem
}

export interface PartBatchTreeAssemblyResultFE {
  uid: string
  assembly: {
    id: string
    serial_no: string | null
    drawing_no: string
    name: string
    status: string
    child_count: number
  }
  master_file: PartFileItem | null
  children: PartBatchTreePartResultFE[]
  child_files: PartFileItem[]
}

export interface PartBatchTreeResultFE {
  standalone_parts: PartBatchTreePartResultFE[]
  assemblies: PartBatchTreeAssemblyResultFE[]
  failed: PartBatchFailure[]
}

/**
 * 批量树形创建：单页 PDF → 独立零件；多页 PDF → 装配件 + 子件。
 * 文件按 `pdf_index` 隐式对齐 `items`（frontend 端按上传顺序记录）。
 * PR-H 2026-07-28：`threeDModels` 按 `items[i].three_d_index` 对齐。
 */
export async function batchCreatePartsWithPdfs(
  items: PartBatchTreeItemFE[],
  assemblies: PartBatchTreeAssemblyFE[],
  files: PartBatchFilePayload[],
  threeDModels: PartBatchFilePayload[] = [],
): Promise<PartBatchTreeResultFE> {
  const form = new FormData()
  form.append('data', JSON.stringify({ items, assemblies }))
  files.forEach((f) => {
    if (f.data) form.append('files', f.data, f.filename)
  })
  threeDModels.forEach((f) => {
    if (f.data) form.append('three_d_models', f.data, f.filename)
  })
  // 批量上传可能耗时数分钟，单点延长到 10 分钟；全局 axios `timeout: 30_000` 不动（其他业务保持短超时）。
  const resp = await api.post<PartBatchTreeResultFE>(
    '/parts/batch-with-pdfs',
    form,
    { timeout: 10 * 60 * 1000 },
  )
  return resp.data
}

// ============================================================
// 批次（2026-07-29 批次化）
// ============================================================

/** 批次监控条目（详情页批次卡片） */
export interface PartBatch {
  id: string
  version: number
  part_id: string
  batch_no: number
  batch_label: string
  quantity: number
  status: string
  location: string | null
  current_holder_id: string | null
  current_holder_display: string | null
  next_process_id: string | null
  next_process_name: string | null
  placed_at: string | null
  delivery_note_id: string | null
  delivery_note_no: string | null
  parent_batch_id: string | null
  created_at: string
  updated_at: string
}

export async function listPartBatches(partId: string): Promise<PartBatch[]> {
  const resp = await api.get<PartBatch[]>(`/parts/${partId}/batches`)
  return resp.data
}

export async function splitPartBatch(
  partId: string,
  payload: { batch_id: string; quantity: number },
): Promise<PartBatch[]> {
  const resp = await api.post<PartBatch[]>(
    `/parts/${partId}/batches/split`,
    payload,
  )
  return resp.data
}

export async function cancelPartBatch(
  partId: string,
  batchId: string,
): Promise<PartBatch[]> {
  const resp = await api.post<PartBatch[]>(
    `/parts/${partId}/batches/${batchId}/cancel`,
  )
  return resp.data
}

/** 品检待办（批次级；行=批次） */
export interface InspectionBatchListResult {
  items: PartItem[]
  total: number
  limit: number
  offset: number
}

export async function listInspectionBatches(params: {
  keyword?: string
  serial_no?: string
  customer_id?: string
  planned_delivery_date_from?: string
  planned_delivery_date_to?: string
  limit?: number
  offset?: number
} = {}): Promise<InspectionBatchListResult> {
  const resp = await api.get<InspectionBatchListResult>('/parts/inspection-batches', {
    params: cleanParams(params),
  })
  return resp.data
}

// ============ inspection to-XXX 体系批量（2026-08-28 后端路线 B 重构）==============

/** v2 `POST /parts/batch-to-inspection` 入参项。
 *
 * 字段名 / 可选性与后端 `BatchToInspectionItem` 对齐；`batch_id` 必填，雪花 ID 字符串。
 * `part_id` **不再需要** —— 后端 service 按 `batch_id` 反查 `t_part_batch.part_id`。
 * 2026-08-29：新增 `version` 必填，caller OCC 锚 t_part_batch。 */
export interface BatchToInspectionItem {
  /** 必填；雪花 ID 字符串（CLAUDE.md §3）。 */
  batch_id: string
  /** 必填；2026-08-29：t_part_batch.version。 */
  version: number
  /** 可选；部分数量。缺省 = 批次全量；小于批次量时后端会拆分 remainder。 */
  quantity?: number | null
}

export interface BatchToInspectionRequest {
  /** 共享品检架 id（雪花 ID 字符串；必填，zone=INSPECTION active）。 */
  target_inspection_shelf_id: string
  /** 1..=200 项；超出后端返回 40001 VALIDATION_ERROR。 */
  items: BatchToInspectionItem[]
}

export interface BatchToInspectionFailureFE {
  /** 雪花 ID 字符串；与请求 items[].batch_id 一一对应。 */
  batch_id: string
  /** 业务错误码（20103 INVALID_TRANSITION / 20109 / 20111 / 20511 / 20512 等）。 */
  code: number
  /** 后端 message 原样透传。 */
  message: string
}

export interface BatchToInspectionOutFE {
  /** 成功项，与请求 items 同序（后端顺序处理）；失败项落在 failed[]，
   *  故 submitted.length = items.length - failed.length，**下标不与 items 对齐**。
   *  注意后端 `ToXxxOut` 只序列化 `part` + `new_batch_id`，**不含 batch_id**
   *  （2026-08-28 修正，见 inspection.md「ToXxxOut 字段」表）——响应 → 请求的反查
   *  只能靠「位置 + 用 failed[].batch_id 扣除失败项」，不能指望 submitted[].batch_id。 */
  submitted: Array<{
    part: PartItem
    /** 拆批语义（见 inspection.md「自动拆批」）：
     *  - 整批操作（quantity 缺省 / == batch.quantity）→ `null`，未拆批；
     *  - 部分操作（quantity < batch.quantity）→ 拆出的 **remainder 批次 id**
     *    （原批次量减少后留在源状态，待后续操作），**不等于**入参 batch_id。
     *  前端拿到非 null 应刷新批次列表（会多出一行 quantity = 原量 - 操作量 的批次）。 */
    new_batch_id: string | null
  }>
  failed: BatchToInspectionFailureFE[]
}

export async function batchToInspection(
  payload: BatchToInspectionRequest,
): Promise<BatchToInspectionOutFE> {
  const resp = await apiV2.post<BatchToInspectionOutFE>(
    '/parts/batch-to-inspection',
    payload,
  )
  return resp.data
}

/** v2 `POST /parts/batch-to-ship` 入参项（与 BatchToInspectionItem 同形）。
 * 2026-08-29：新增 `version` 必填，caller OCC 锚 t_part_batch。 */
export interface BatchToShipItem {
  batch_id: string
  /** 必填；2026-08-29：t_part_batch.version。 */
  version: number
  quantity?: number | null
}

export interface BatchToShipRequest {
  items: BatchToShipItem[]
}

export interface BatchToShipFailureFE {
  batch_id: string
  code: number
  message: string
}

export interface BatchToShipOutFE {
  /** 与 BatchToInspectionOutFE.submitted 同形同语义（后端 `ToXxxOut` 单 / 批端点共用）：
   *  与请求 items 同序、**不含 batch_id**、失败项不占位。 */
  submitted: Array<{
    part: PartItem
    /** 拆批语义（见 inspection.md「自动拆批」）：
     *  - 整批操作（quantity 缺省 / == batch.quantity）→ `null`，未拆批；
     *  - 部分操作（quantity < batch.quantity）→ 拆出的 **remainder 批次 id**，
     *    **不等于**入参 batch_id。前端拿到非 null 应刷新批次列表。 */
    new_batch_id: string | null
  }>
  failed: BatchToShipFailureFE[]
}

export async function batchToShip(
  payload: BatchToShipRequest,
): Promise<BatchToShipOutFE> {
  const resp = await apiV2.post<BatchToShipOutFE>(
    '/parts/batch-to-ship',
    payload,
  )
  return resp.data
}

// ============ 扫码拉批次（路线 B 候选弹窗数据源）==============

/** 2026-08-31 新增：扫码序列号拉批次列表（路线 B 弹窗填充）。 */
export async function getPartBatchesBySerial(
  serialNo: string,
): Promise<PartScanContextOut> {
  const resp = await apiV2.get<PartScanContextOut>(
    `/parts/by-serial/${encodeURIComponent(serialNo)}/part-batches`,
  )
  return resp.data
}