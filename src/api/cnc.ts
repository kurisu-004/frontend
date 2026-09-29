// api/cnc.ts
//
// 2026-09-29 修复：本文件原本 87 行，承载 7 个函数（listPartCncPrograms /
// listPartSetupSheets / uploadPartCncProgram / uploadPartSetupSheet /
// getCncDownloadUrl / deleteCncProgram / uploadCncPair）。其中 6 个：
//
//   - listPartCncPrograms / listPartSetupSheets —— 是 part_file 域窄路径
//     alias（handler 硬编码 kind=G_CODE/SETUP_SHEET + limit=500 不读 Query），
//     前端 usePartFilesListQuery 已拉 owner 全量，按 kind filter 即可。
//   - uploadPartCncProgram / uploadPartSetupSheet —— 零调用方（2026-09-16
//     M3 后 multipart 直传链路已被 COS 直传 + JSON 链路取代；前端不再发这
//     两端点）。
//   - getCncDownloadUrl / deleteCncProgram —— 走 cnc-programs alias 端点
//     （/cnc-programs/{id}/download-url + /cnc-programs/{id}/delete），但
//     实际是 /part-files/{id}/url + /part-files/{id}/delete 的 alias；前端
//     改走 api/parts/file 的 native 端点更直接。
//
// 唯一保留 `uploadCncPair`：CNC G 代码 + 设定单的「配对上传」业务。canonical
// 端点是 `POST /api/v2/cnc-programs/pairs`（backend-rust
// src/modules/cnc_program/handler.rs::create_pair），field 名重映射：
//   - gcode_file  → g_code
//   - setup_file  → setup_sheet
//   - 新增 data JSON 文本字段含 part_id（multipart + json hybrid 形态）
// 返回类型 PartFileItem（与 part_file 域列表项同形，partFilesListQuery 失
// 效后 UI 自动 refetch 反映新 pair）。

import { api } from '@/api/http';
import type { PartFileItem } from '@/types/part_file';

/**
 * 配对上传：G 代码 + CNC 设定单 PDF。
 *
 * 2026-09-29 修复：迁到 canonical `POST /api/v2/cnc-programs/pairs`
 * （原 `/parts/{id}/cnc-pair` 已在 backend-rust part::router() nest 移除，
 * 唯一入口是 cnc_program 域）。field 重映射：gcode_file → g_code、
 * setup_file → setup_sheet；新增 data JSON 文本字段含 part_id（multipart
 * + JSON hybrid 形态）。
 */
export async function uploadCncPair(
  partId: string,
  gcodeFile: File,
  setupFile: File,
): Promise<{ g_code: PartFileItem; setup_sheet: PartFileItem }> {
  const form = new FormData();
  form.append('data', JSON.stringify({ part_id: partId }));
  form.append('g_code', gcodeFile);
  form.append('setup_sheet', setupFile);
  const resp = await api.post<{ g_code: PartFileItem; setup_sheet: PartFileItem }>(
    '/cnc-programs/pairs',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
    },
  );
  return resp.data;
}
