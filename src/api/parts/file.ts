// 后端零件 API 封装 —— 文件 / 打印相关端点（图纸双面打印 PDF 生成）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./file 子域。
// 2026-09-15 Phase 5：打印 2 端点保留 v1（未迁），统一走 `apiPrint`（baseURL `/api/v1`）。
//
// 注：图纸上传 / 3D 模型上传 / CNC 程序上传分别在 `api/cnc.ts`（G 代码 / 设定单）
// 和前端 el-upload 直接走 `api/parts/{id}/...` 端点；本子域仅含返回文件 Blob 的
// 打印端点。CNC 程序 / 设定单的 list/upload/delete 详见 `api/cnc.ts`。
//
// 2026-09-16 M3：新增 createUploadIntents / confirmPartFile（STS 直传 COS 链路）。

import { api, apiPrint } from '@/api/http';
import type {
  ConfirmFileIn,
  PartFileItem,
  UploadIntentsIn,
  UploadIntentsOut,
} from '@/types/part_file';

/**
 * 生成零件的双面打印 PDF（图纸 + 反面右下角条形码）。
 * 返回 Blob，content-type=application/pdf。
 *
 * 注：返回的是文件 blob，调用方需自行用 iframe / window 触发打印。
 *
 * 2026-09-15 Phase 5：走 `apiPrint`（baseURL `/api/v1`，v1 Python FastAPI 保留）。
 */
export async function printPartDrawing(partId: string): Promise<Blob> {
  const resp = await apiPrint.get<Blob>(`/parts/${encodeURIComponent(partId)}/print-drawing`, {
    responseType: 'blob',
  });
  return resp.data;
}

/**
 * 批量生成多个零件的双面打印 PDF 并合并为一个 PDF（2026-07-17 接入）。
 * 后端把 N 个 part 的双面 PDF 用 pypdf.PdfWriter 顺序拼接成单文件返回。
 * 前端拿到 Blob 后用单 iframe 一次 print()，避免 N 次打印弹窗。
 *
 * 2026-09-15 Phase 5：走 `apiPrint`（baseURL `/api/v1`，v1 Python FastAPI 保留）。
 */
export async function printPartDrawingBatch(
  partIds: string[],
  assemblyIds?: string[],
): Promise<Blob> {
  const resp = await apiPrint.post<Blob>(
    '/parts/print-drawing-batch',
    { part_ids: partIds, assembly_ids: assemblyIds },
    { responseType: 'blob', timeout: 10 * 60 * 1000 },
  );
  return resp.data;
}

// ============================================================
// 2026-09-16 M3：STS 直传 COS 链路（与 backend-rust part_file handler 对齐）
// ============================================================

/**
 * `POST /api/v2/part-files/upload-intents`：批量申请 STS 临时凭证 + tmp_key。
 *
 * 走 `api`（baseURL `/api/v2`）。请求入参：`UploadIntentsIn`；响应：`UploadIntentsOut`。
 *
 * 场景：
 * - 创建工单（场景 A）：不传 `owner_part_id`，每个 file 都会分配 tmp_key；
 * - 详情页补传（场景 B）：传 `owner_part_id`，后端按 (part, kind, sha) 查重，
 *   命中项标 `dedup_hit: true` 并附 `existing_file`；前端可直接跳过上传复用旧文件。
 */
export async function createUploadIntents(payload: UploadIntentsIn): Promise<UploadIntentsOut> {
  const resp = await api.post<UploadIntentsOut>('/part-files/upload-intents', payload);
  return resp.data;
}

/**
 * `POST /api/v2/parts/{part_id}/files/confirm`：场景 B 确认绑定。
 *
 * 前端拿 `UploadIntentsOut.items[i].tmp_key` 配合 `cos-js-sdk-v5` 实际上传到 COS tmp 区，
 * 完成后调此端点让后端 head 校验 + copy tmp → 正式 CAS key + 插 `t_part_file(READY)` 行。
 */
export async function confirmPartFile(
  partId: string,
  payload: ConfirmFileIn,
): Promise<PartFileItem> {
  const resp = await api.post<PartFileItem>(
    `/parts/${encodeURIComponent(partId)}/files/confirm`,
    payload,
  );
  return resp.data;
}
