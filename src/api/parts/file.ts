// 后端零件 API 封装 —— 文件 / 打印相关端点（图纸双面打印 PDF 生成）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./file 子域。
//
// 注：图纸上传 / 3D 模型上传 / CNC 程序上传分别在 `api/cnc.ts`（G 代码 / 设定单）
// 和前端 el-upload 直接走 `api/parts/{id}/...` 端点；本子域仅含返回文件 Blob 的
// 打印端点。CNC 程序 / 设定单的 list/upload/delete 详见 `api/cnc.ts`。

import { api } from '@/api/http'

/**
 * 生成零件的双面打印 PDF（图纸 + 反面右下角条形码）。
 * 返回 Blob，content-type=application/pdf。
 *
 * 注：返回的是文件 blob，调用方需自行用 iframe / window 触发打印。
 */
export async function printPartDrawing(partId: string): Promise<Blob> {
  const resp = await api.get<Blob>(
    `/parts/${encodeURIComponent(partId)}/print-drawing`,
    { responseType: 'blob' },
  )
  return resp.data
}

/**
 * 批量生成多个零件的双面打印 PDF 并合并为一个 PDF（2026-07-17 接入）。
 * 后端把 N 个 part 的双面 PDF 用 pypdf.PdfWriter 顺序拼接成单文件返回。
 * 前端拿到 Blob 后用单 iframe 一次 print()，避免 N 次打印弹窗。
 */
export async function printPartDrawingBatch(
  partIds: string[],
  assemblyIds?: string[],
): Promise<Blob> {
  const resp = await api.post<Blob>(
    '/parts/print-drawing-batch',
    { part_ids: partIds, assembly_ids: assemblyIds },
    { responseType: 'blob', timeout: 10 * 60 * 1000 },
  )
  return resp.data
}