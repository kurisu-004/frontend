// 后端零件 API 封装 —— 文件 / 打印相关端点（图纸双面打印 PDF 生成）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./file 子域。
// 2026-09-15 Phase 5：打印 2 端点保留 v1（未迁），统一走 `apiPrint`（baseURL `/api/v1`）。
//
// 注：图纸上传 / 3D 模型上传 / CNC 程序上传分别在 `api/cnc.ts`（G 代码 / 设定单）
// 和前端 el-upload 直接走 `api/parts/{id}/...` 端点；本子域仅含返回文件 Blob 的
// 打印端点。CNC 程序 / 设定单的 list/upload/delete 详见 `api/cnc.ts`。
//
// 2026-09-16 M3 + 2026-09-17 STS 端口迁移：原 createUploadIntents（backend-rust bulk）已下线；
// 本文件保留 confirmPartFile（场景 B 专用确认端点）配合 grantStsTmpKey
// （python STS 单端口，详见 @/api/files/sts）。

import { api, apiPrint } from '@/api/http';
import type { ConfirmFileIn, PartFileItem, PartFileUrlResult } from '@/types/part_file';

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
// 2026-09-16 M3 + 2026-09-17 STS 端口迁移：场景 B 确认端点（与 python STS grantStsTmpKey 配合）
// ============================================================

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

// ============================================================
// 2026-09-16 T3.5：part-file 域 v2 实际路径的辅助端点（删除 / 下载 / 内容预览）
// ============================================================
//
// 背景：原 `api/assembly.ts` 里的 `deleteFile / getDownloadUrl` 路径写的是
// `POST /files/{id}/delete` / `GET /files/{id}/content`（v1 时代的端点），
// v2 后端实际路径是 `/part-files/{id}/...`。本组函数走 v2 实际路径 +
// 对齐 PartFileUrlResult / PartFileListResult 契约。

/**
 * `GET /api/v2/part-files/{id}/url`：临时下载 URL 签发。
 *
 * 后端返回 `PartFileUrlResult.download_url`，直接 `window.open(url)` 或 `a.href = url` 触发下载。
 * URL 含 COS 临时签名（过期时间由 `url_expires_in_seconds` 决定）。
 */
export async function getPartFileDownloadUrl(fileId: string): Promise<string> {
  const resp = await api.get<PartFileUrlResult>(`/part-files/${encodeURIComponent(fileId)}/url`);
  return resp.data.download_url;
}

/**
 * `POST /api/v2/part-files/{id}/delete`：软删（OCC）。
 *
 * v2 `soft_delete_part_file` 强制要求 JSON body `{ version }`，bodyless POST 会
 * 返回 415 Unsupported Media Type。`version` 是当前行的乐观锁版本号，前端拿到
 * PartFileItem.version 后回传；后端版本不匹配会返 409 Conflict。
 *
 * 不传 version 会触发后端 schema validation 错误 → 这里强制 required。
 */
export async function deletePartFile(fileId: string, version: number): Promise<void> {
  await api.post(`/part-files/${encodeURIComponent(fileId)}/delete`, { version });
}

/**
 * `GET /api/v2/part-files/{id}/content`：返回文件原始二进制（blob）。
 *
 * 用于内嵌预览（PDF / 图片走 el-image / PdfViewer）。URL 走相对路径，
 * 与 `api` 实例 baseURL `/api/v2` 拼接，由调用方自行 `axios.get(url, { responseType: 'blob' })`
 * 拉取。这里**只返回 URL 字符串**，避免绑死请求实例 —— FileListCard 需要
 * 既支持 props 注入（外部 axios 实例），也支持默认走 `api`。
 *
 * 端点不带鉴权 header 直接 GET → 由调用方 axios 拦截器注入 Bearer token；
 * 不要把 URL 直接塞进 `<img src>` / `<iframe src>`，那样会绕过鉴权拦截器。
 */
export function getPartFileContentUrl(fileId: string): string {
  return `/part-files/${encodeURIComponent(fileId)}/content`;
}

/**
 * `GET /api/v2/part-files/{id}/content`：拉文件 blob。
 *
 * 默认实现：走 `api` 实例 + responseType=blob。FileListCard 在 caller 未注入
 * `apiGetPreviewUrl` 时走这条默认路径（替代原 v1 `/files/{id}/content`）。
 */
export async function fetchPartFileContent(fileId: string): Promise<Blob> {
  const resp = await api.get<Blob>(getPartFileContentUrl(fileId), {
    responseType: 'blob',
  });
  return resp.data;
}

// ============================================================
// 2026-09-25 迁移：原误放在 assembly.ts 的零件文件上传函数迁回 parts/file.ts。
// ============================================================
//
// 历史背景：2026-09-16 M3 重构时 multipart 直传路径被 COS 直传 + JSON 链路取代，
// 后端 `/parts/{id}/drawings` / `/3d-models` / `/cad-files` 端点已删除（v2 不再
// 支持 multipart upload）。原函数在 assembly.ts 标注 @deprecated 但保留 export。
// 2026-09-25 清理：把 export 从 assembly.ts 迁移到本文件（更符合子域归属），
// 调用端继续可用，但实际调用会抛 404 Not Found。详情页补传请改用
// `usePartFileUpload({ ownerPartId, kind: 'DRAWING' })`（场景 B）。

/**
 * 上传零件图纸。2026-07-14 起 DRAWING 同时接受 PDF + 8 种图片格式
 * （PNG/JPG/JPEG/GIF/BMP/TIF/TIFF/WEBP/HEIC），后端 /drawings 端点统一处理。
 * 图片与 PDF 同槽（单文件覆盖语义）。
 *
 * @deprecated 2026-09-16 M3 重构：multipart 直传路径已被 COS 直传 + JSON 链路取代，
 * 后端 `/parts/{id}/drawings` 端点已删除（v2 不再支持 multipart upload）。
 * 详情页补传请改用 `usePartFileUpload({ ownerPartId, kind: 'DRAWING' })`（场景 B）。
 * 保留 export 仅作 import 兼容；调用会抛 404 Not Found。
 *
 * 2026-09-25 迁移：从 `api/assembly.ts` 迁回 `api/parts/file.ts`（更符合子域归属）。
 */
export async function uploadPartDrawing(partId: string, file: File): Promise<PartFileItem> {
  const form = new FormData();
  form.append('file', file);
  const resp = await api.post<PartFileItem>(`/parts/${partId}/drawings`, form);
  return resp.data;
}

/**
 * 上传零件 3D 模型（STEP / STP / IGES / IGS / STL / OBJ / 3MF）。
 *
 * @deprecated 2026-09-16 M3 重构：multipart 直传路径已被 COS 直传 + JSON 链路取代，
 * 后端 `/parts/{id}/3d-models` 端点已删除。详情页补传请改用
 * `usePartFileUpload({ ownerPartId, kind: '3D_MODEL' })`（场景 B）。
 *
 * 2026-09-25 迁移：从 `api/assembly.ts` 迁回 `api/parts/file.ts`。
 */
export async function uploadPart3DModel(partId: string, file: File): Promise<PartFileItem> {
  const form = new FormData();
  form.append('file', file);
  const resp = await api.post<PartFileItem>(`/parts/${partId}/3d-models`, form);
  return resp.data;
}

/**
 * 上传零件 CAD 源文件（DWG / DXF）。2026-07-14 新增 kind=CAD_2D：
 * 与 PDF 图纸生命周期分离，删除 CAD 源不影响打印用 PDF。
 *
 * @deprecated 2026-09-16 M3 重构：multipart 直传路径已被 COS 直传 + JSON 链路取代，
 * 后端 `/parts/{id}/cad-files` 端点已删除。详情页补传请改用
 * `usePartFileUpload({ ownerPartId, kind: 'CAD_2D' })`（场景 B）。
 *
 * 2026-09-25 迁移：从 `api/assembly.ts` 迁回 `api/parts/file.ts`。
 */
export async function uploadPartCadFile(partId: string, file: File): Promise<PartFileItem> {
  const form = new FormData();
  form.append('file', file);
  const resp = await api.post<PartFileItem>(`/parts/${partId}/cad-files`, form);
  return resp.data;
}
