// 后端零件 API 封装 —— 应标 / 采购订单导入（PO Excel 解析后与系统零件匹配 + 回填订单号/系统交期）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./bid 子域。
//
// 注：`parseBidExcel` / `matchBidColumns` 之类的本地 Excel 解析逻辑在
// `utils/bidExcelParser.ts`，不归本文件（前端 utils 域，非 API）。

import { api } from '@/api/http'
import type { PartItem } from './crud'

/** 采购订单 Excel 中解析出的有效明细行。 */
export interface PurchaseOrderExcelItem {
  rowNo: number
  lineNo: string
  deleted: boolean
  drawingNo: string
  name: string
  deliveryDate: string | null
  unitPrice: number | null
  shippableQty: number | null
}

export interface PartBatchOrderInfoMatchItem {
  row_no: number
  line_no?: string | null
  drawing_no?: string | null
  name?: string | null
  delivery_date?: string | null
  unit_price?: number | null
  quantity?: number | null
}

export interface PartMatchInfo {
  part_id: string
  version: number
  drawing_no: string | null
  name: string
  unit_price: number | null
  quantity: number | null
  order_no: string | null
  system_delivery_date: string | null
  assembly_id: string | null
  assembly_name: string | null
}

export interface PartBatchOrderInfoMatchResult {
  row_no: number
  match_type: 'PART_CODE' | 'PART_NAME' | 'ASSEMBLY_CODE' | 'ASSEMBLY_NAME' | 'NONE'
  parts: PartMatchInfo[]
  warnings: string[]
}

export interface PartBatchOrderInfoMatchRequest {
  doc_no: string
  items: PartBatchOrderInfoMatchItem[]
}

export interface PartBatchOrderInfoUpdateItem {
  part_id: string
  version: number
  order_no?: string | null
  system_delivery_date?: string | null
  skip?: boolean
}

export interface PartBatchOrderInfoUpdateFailure {
  part_id: string
  code: number
  message: string
}

export interface PartBatchOrderInfoUpdateResult {
  updated: PartItem[]
  failed: PartBatchOrderInfoUpdateFailure[]
  skipped_count: number
}

export async function matchPartsByExcelItems(
  payload: PartBatchOrderInfoMatchRequest,
): Promise<PartBatchOrderInfoMatchResult[]> {
  const resp = await api.post<PartBatchOrderInfoMatchResult[]>(
    '/parts/match-by-excel-items',
    payload,
  )
  return resp.data
}

export async function batchUpdatePartsOrderInfo(
  payload: { items: PartBatchOrderInfoUpdateItem[] },
): Promise<PartBatchOrderInfoUpdateResult> {
  const resp = await api.post<PartBatchOrderInfoUpdateResult>(
    '/parts/batch-update-order-info',
    payload,
  )
  return resp.data
}