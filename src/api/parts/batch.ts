// 后端零件 API 封装 —— 批量 / 批次化端点（批量新建、批次拆分/取消、品检待办、批量品检通过）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./batch 子域。
//
// 跨子域类型引用：PartItem / PartCreatePayload 定义在 ./crud；本文件所有批量响应
// （DTO / 失败明细）都涉及单件 DTO 与单件创建 payload，因此仅 type-only 导入，
// 运行时不会产生 ESM 循环。

import { api, apiV2, cleanParams } from '@/api/http'
import type { PartFileItem } from '@/types/part_file'
import type { PartCreatePayload, PartItem } from './crud'

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

// ============ 批量品检通过（2026-08-23 新增；2026-08-25 切到 v2 批量端点）==============

/** v2 批量品检入参项（2026-08-25 接入）。
 *
 * 字段名 / 可选性与后端 `BatchPassItem` 对齐；`part_id` 必填，雪花 ID 字符串。 */
export interface BatchPassItem {
  /** 必填；雪花 ID 字符串（CLAUDE.md §3）。 */
  part_id: string
  /** 可选；目标批次 id（雪花 ID 字符串）。缺省 = 状态唯一批次解析。 */
  batch_id?: string | null
  /** 可选；部分数量。缺省 = 批次全量；小于批次量时后端会拆分。 */
  quantity?: number | null
}

/** v2 批量品检 per-item 失败元素（2026-08-25 接入）。
 *
 * 与 `BulkPassFailure`（composable 层）是一对一映射；后端 `failed[]` 原样透传。 */
export interface BatchPassFailureFE {
  /** 雪花 ID 字符串；与请求 items[].part_id 一一对应。 */
  part_id: string
  /** 业务错误码（20101 NOT_FOUND / 20103 INVALID_TRANSITION / 20104 INVALID_VALUE）。 */
  code: number
  /** 后端 message 原样透传。 */
  message: string
}

/** v2 `POST /parts/batch-pass-inspection` 响应 `data`。 */
export interface BatchPassInspectionOutFE {
  /** 成功通过的件（与 PartItem 同源；PartItem 在 part 域是大 DTO，包含 version/批次等）。 */
  passed: PartItem[]
  /** 部分失败的 per-item 明细；与请求 items 按 part_id 对齐。 */
  failed: BatchPassFailureFE[]
}

/**
 * 批量通过品检（v2 端点）。
 *
 * 后端 `POST /api/v2/parts/batch-pass-inspection`：1 次 round-trip 处理 N<=200 件；
 * 整体成功 200 OK + 部分失败走 `data.failed[]`，与单件 `passInspection` 行为对齐。
 *
 * 该端点是 `composables/useBulkPassInspection.run` 的单一后端入口；早前 worker pool
 * 方案（9 次 round-trip）已下线，仅作为 `BulkPassItem[]` → 调用层契约保留 composable 抽象。
 *
 * @see ~/Code/hsh-erp-rust/docs/api/parts.md（待后端 agent 提交 docs 后同步）
 */
export async function batchPassInspection(
  items: BatchPassItem[],
): Promise<BatchPassInspectionOutFE> {
  const resp = await apiV2.post<BatchPassInspectionOutFE>(
    '/parts/batch-pass-inspection',
    { items },
  )
  return resp.data
}

// ============ 批量一键送检（2026-08-25 新增；申请见 docs/api-requirements/scan-inspect.md）==============
//
// 与 batch-pass-inspection 形态对称：
// - 单件端点已切 v2（见 ./crud.ts `scanInspect`）
// - 批量端点走 v2 batch-scan-inspect：共享品检架 + per-item 数量 + 可选 decision
// - 后端必填：target_inspection_shelf_id（INSPECTION zone active）；items[].part_id 必填，decision 缺省 PASS
// - 用于：扫码建单扫到 IN_PROCESS/PROGRAMMING/PENDING 工件时弹窗确认；装配件整组送检
// - 配套 composable: composables/useBulkScanInspect.ts（镜像 useBulkPassInspection）

/** v2 批量一键送检入参项（2026-08-25 新增）。
 *
 * 字段对齐后端 `BatchScanInspectItem`（docs/api-requirements/scan-inspect.md §G.2 端点 2）；
 * `part_id` 必填（雪花 ID 字符串）；`decision` 缺省 = PASS；`shelf_id` / `next_process_id`
 * 仅 FAIL 时必填（前端 UI 默认全 PASS，validator 由后端 model_validator 拦截）。 */
export interface BatchScanInspectItemFE {
  /** 必填；雪花 ID 字符串。 */
  part_id: string
  /** 可选；缺省 PASS。FAIL 时需要同时给 shelf_id + next_process_id。 */
  decision?: 'PASS' | 'FAIL' | null
  /** FAIL 必填；目标生产货架（PRODUCTION zone active）。 */
  shelf_id?: string | null
  /** FAIL 必填；下一道工序 id。 */
  next_process_id?: string | null
  /** 可选；≤ 500 字符。 */
  note?: string | null
  /** 可选；目标批次 id；缺省按状态唯一批次解析。 */
  batch_id?: string | null
  /** 可选；部分数量；缺省 = 批次全量；>0 且 ≤ 批次剩余量。 */
  quantity?: number | null
}

/** v2 批量一键送检入参 request body。 */
export interface BatchScanInspectRequestFE {
  /** 共享品检架 id（雪花 ID 字符串；必填，zone=INSPECTION, is_active）。 */
  target_inspection_shelf_id: string
  /** 1..=200 项。 */
  items: BatchScanInspectItemFE[]
}

/** v2 批量一键送检 per-item 失败元素（与 BatchPassFailureFE 形态对称）。 */
export interface BatchScanInspectFailureFE {
  /** 雪花 ID 字符串；与请求 items[].part_id 一一对应。 */
  part_id: string
  /** 业务错误码（20103 INVALID_TRANSITION / 20111 INVALID_QUANTITY / 20511 / 20512 等）。 */
  code: number
  /** 后端 message 原样透传。 */
  message: string
}

/** v2 `POST /parts/batch-scan-inspect` 响应 `data`。 */
export interface BatchScanInspectOutFE {
  /** 成功搬上 INSPECTION 架并完成 PASS/FAIL 分流的件。 */
  submitted: PartItem[]
  /** per-item 失败明细；与请求 items 按 part_id 对齐。 */
  failed: BatchScanInspectFailureFE[]
}

/**
 * 批量一键送检（v2 端点）。
 *
 * 后端 `POST /api/v2/parts/batch-scan-inspect`：1 次 round-trip 处理 N<=200 件；
 * 共享品检架，per-item decision（缺省 PASS）。
 *
 * 该端点是 `composables/useBulkScanInspect.run` 的单一后端入口；
 * 主要消费方：`components/delivery/BatchSubmitInspectionConfirmDialog.vue`（扫码建单弹窗）。
 *
 * @see docs/api-requirements/scan-inspect.md
 */
export async function batchScanInspect(
  req: BatchScanInspectRequestFE,
): Promise<BatchScanInspectOutFE> {
  const resp = await apiV2.post<BatchScanInspectOutFE>(
    '/parts/batch-scan-inspect',
    req,
  )
  return resp.data
}