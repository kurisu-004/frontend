// api/files/cnc.ts
//
// 2026-10-13 随后端 files 域重组：本文件自 `api/cnc.ts` 迁入 `api/files/cnc.ts`，
// canonical 端点由 `POST /api/v2/cnc-programs/pairs` **硬切**为
// `POST /api/v2/files/cnc/pairs`。⚠️ **旧路径 `/api/v2/cnc-programs/*` 已 404、无 alias**：
// 后端同批删掉了 12 条零调用方端点（cnc_program 4 条 + part_file 8 条，移除记录见
// backend-rust `src/modules/files/part_file/handler.rs` 模块 doc）。
// 迁入理由与 `objects.ts` 同款：`api/` 子目录镜像 URL 命名空间，`/files/cnc` 正好
// 对应 `api/files/cnc.ts`（同目录另有 `sts.ts` → `/files/sts-tmp-keys`、
// `objects.ts` → `/files/objects/*`）。
//
// 2026-09-29 修复：本文件原本 87 行，承载 7 个函数（listPartCncPrograms /
// listPartSetupSheets / uploadPartCncProgram / uploadPartSetupSheet /
// getCncDownloadUrl / deleteCncProgram / uploadCncPair）。其中 6 个：
//
//   - listPartCncPrograms / listPartSetupSheets —— 是文件对象域窄路径
//     alias（handler 硬编码 kind=G_CODE/SETUP_SHEET + limit=500 不读 Query），
//     前端 usePartFilesListQuery 已拉 owner 全量，按 kind filter 即可。
//     ⚠️ 这 2 条 alias 端点后端已下线（旧路径 404）。
//   - uploadPartCncProgram / uploadPartSetupSheet —— 零调用方（2026-09-16
//     M3 后 multipart 直传链路已被 COS 直传 + JSON 链路取代；前端不再发这
//     两端点）。
//   - getCncDownloadUrl / deleteCncProgram —— 走 cnc-programs alias 端点，
//     但实际是文件对象域端点的 alias；前端改走 `api/files/objects` 的 native
//     端点更直接。⚠️ 这 2 条 alias 端点后端已下线（旧路径 404）。
//
// 唯一保留 `uploadCncPair`：CNC G 代码 + 设定单的「配对上传」业务。canonical
// 端点是 `POST /api/v2/files/cnc/pairs`（backend-rust
// src/modules/files/part_file/cnc/handler.rs），field 名重映射：
//   - gcode_file  → g_code
//   - setup_file  → setup_sheet
//   - 新增 data JSON 文本字段含 part_id（multipart + json hybrid 形态）
// 返回类型 PartFileItem（与文件对象列表项同形，partFilesListQuery 失
// 效后 UI 自动 refetch 反映新 pair）。

import { api } from '@/api/http';
import type { PartFileItem } from '@/types/part_file';

/**
 * 配对上传：G 代码 + CNC 设定单 PDF。
 *
 * 2026-09-29 修复：迁到 canonical 配对端点（原 `/parts/{id}/cnc-pair` 已在
 * backend-rust part::router() nest 移除）。field 重映射：gcode_file → g_code、
 * setup_file → setup_sheet；新增 data JSON 文本字段含 part_id（multipart
 * + JSON hybrid 形态）。
 *
 * 2026-10-13：随 files 域重组，端点硬切 `POST /api/v2/cnc-programs/pairs` →
 * `POST /api/v2/files/cnc/pairs`（旧路径 404、无 alias）。
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
    '/files/cnc/pairs',
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
    },
  );
  return resp.data;
}
