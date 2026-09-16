// CNC 程序 + 设定单 API 封装（2026-07-10 起统一为 part file）。
// 2026-09-16 Phase 5 切 v2 后与 backend-rust part_file / cnc_program 模块对齐。

import { api } from '@/api/http';
import type {
  CncPairedFileRef,
  PartFileItem,
  PartFileListResult,
  PartFileUrlResult,
} from '@/types/part_file';

/** 列出某零件已上传的所有 G 代码程序。 */
export async function listPartCncPrograms(
  partId: string,
  kind: 'G_CODE' | 'SETUP_SHEET' = 'G_CODE',
): Promise<PartFileListResult> {
  // 2026-09-16：v2 默认 limit=50 会静默截断，clamp 上限 500；本页需要全量配对分组，取上限
  const resp = await api.get<PartFileListResult>(`/parts/${partId}/cnc-programs`, {
    params: { kind, limit: 500 },
  });
  return resp.data;
}

/** 列出某零件的 CNC 设定单（PDF）。 */
export async function listPartSetupSheets(partId: string): Promise<PartFileListResult> {
  // 2026-09-16：v2 默认 limit=50 会静默截断，clamp 上限 500
  const resp = await api.get<PartFileListResult>(`/parts/${partId}/setup-sheets`, {
    params: { limit: 500 },
  });
  return resp.data;
}

/** 上传 G 代码文件（NC / TAP / CNC / MPF / NGC）。 */
export async function uploadPartCncProgram(partId: string, file: File): Promise<PartFileItem> {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await api.post<PartFileItem>(`/parts/${partId}/cnc-programs`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return resp.data;
}

/** 上传 CNC 设定单（PDF）。 */
export async function uploadPartSetupSheet(partId: string, file: File): Promise<PartFileItem> {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await api.post<PartFileItem>(`/parts/${partId}/setup-sheets`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return resp.data;
}

/** 重新签发单文件临时下载 URL（兼容旧 /cnc-programs 前缀）。 */
export async function getCncDownloadUrl(fileId: string): Promise<string> {
  // 2026-09-16：v2 该端点（/part-files/{id}/url 的 alias）返回字段为 download_url（非 url）
  const resp = await api.get<PartFileUrlResult>(`/cnc-programs/${fileId}/download-url`);
  return resp.data.download_url;
}

/** 软删 CNC 文件（COS 对象异步清理；按文件 kind 自动派角色）。 */
export async function deleteCncProgram(fileId: string, version: number): Promise<void> {
  // 2026-09-16：v2 该端点是 part_file soft_delete 的 alias，同样强制 Json body { version }
  // （OCC），bodyless POST 会 415
  await api.post(`/cnc-programs/${fileId}/delete`, { version });
}

/**
 * 配对上传：G 代码 + CNC 设定单 PDF。
 * 2026-09-16：v2 该端点返回 { g_code, setup_sheet } 对象（非数组），按真实契约返回。
 */
export async function uploadCncPair(
  partId: string,
  gcodeFile: File,
  setupFile: File,
): Promise<{ g_code: CncPairedFileRef; setup_sheet: CncPairedFileRef }> {
  const fd = new FormData();
  fd.append('gcode_file', gcodeFile);
  fd.append('setup_file', setupFile);
  const resp = await api.post<{ g_code: CncPairedFileRef; setup_sheet: CncPairedFileRef }>(
    `/parts/${partId}/cnc-pair`,
    fd,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
    },
  );
  return resp.data;
}
