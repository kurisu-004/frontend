// 装配体 REST API（走 @/api/http 统一 axios 客户端）。
// 创建 / 上传文件走 multipart：data 字段为 JSON 字符串，file 字段为 PDF。

import { api, cleanParams } from '@/api/http';
import type {
  AssemblyCreatePayload,
  AssemblyCreateResult,
  AssemblyDetail,
  AssemblyListQuery,
  AssemblyListResult,
  AssemblyItem,
  AssemblyUpdatePayload,
} from '@/types/assembly';
import type { PartFileListResult } from '@/types/part_file';
import type { PartListItem } from '@/types/parts';

export async function listAssemblies(q: AssemblyListQuery = {}): Promise<AssemblyListResult> {
  const resp = await api.get<AssemblyListResult>('/assemblies', {
    params: cleanParams(q),
  });
  return resp.data;
}

export async function getAssembly(id: string): Promise<AssemblyDetail> {
  const resp = await api.get<AssemblyDetail>(`/assemblies/${id}`);
  return resp.data;
}

/** 按 part_id 反查所属装配体。
 *  2026-09-25 修正：与 backend-rust 新加的 `GET /api/v2/parts/{part_id}/assembly`
 *  端点对齐 —— 后端返 `Option<AssemblyDetail>`（无父装配体时返 null），前端
 *  返回类型由 `AssemblyDetail` 改为 `AssemblyDetail | null`，调用方按 `null`
 *  表示「无父装配体」分支。 */
export async function getAssemblyForPart(partId: string): Promise<AssemblyDetail | null> {
  const resp = await api.get<AssemblyDetail | null>(`/parts/${partId}/assembly`);
  return resp.data;
}

export async function createAssembly(
  payload: AssemblyCreatePayload,
): Promise<AssemblyCreateResult> {
  const form = new FormData();
  form.append('data', JSON.stringify(payload));
  // 不传 file：创建空装配体；详情页再上传 PDF / 添加子件
  const resp = await api.post<AssemblyCreateResult>('/assemblies', form);
  return resp.data;
}

/** 一次性创建：上传总装 PDF + 子件一并生成。 */
export async function createAssemblyWithFile(
  payload: AssemblyCreatePayload,
  pdfFile: File,
): Promise<AssemblyCreateResult> {
  const form = new FormData();
  form.append('data', JSON.stringify(payload));
  form.append('file', pdfFile);
  const resp = await api.post<AssemblyCreateResult>('/assemblies', form);
  return resp.data;
}

/** 详情页上传总装 PDF：拆页 → 自动创建子件。
 *  2026-09-25 修正：v2 后端把 upload-pdf 合并到 `/files` 端点（multipart, field=file），
 *  不再走 `/upload-pdf`。 */
export async function uploadAssemblyPdf(id: string, file: File): Promise<AssemblyDetail> {
  const form = new FormData();
  form.append('file', file);
  const resp = await api.post<AssemblyDetail>(`/assemblies/${id}/files`, form);
  return resp.data;
}

/** 详情页添加单个子件（无 PDF；如需 PDF 走 uploadPartFile）。
 *  2026-09-25 修正：与 backend-rust 新加的 `POST /api/v2/assemblies/{id}/children`
 *  端点对齐 —— 后端接收 `{ drawing_no, name, quantity }` 入参，返回 `PartListItem`。 */
export async function addAssemblyChild(
  id: string,
  payload: { drawing_no: string; name: string; quantity: number },
): Promise<PartListItem> {
  const resp = await api.post<PartListItem>(`/assemblies/${id}/children`, payload);
  return resp.data;
}

export async function softDeleteAssembly(id: string): Promise<void> {
  await api.post(`/assemblies/${id}/soft-delete`);
}

/** 取消装配体（CLERK+）。级联取消所有非终态子件。 */
export async function cancelAssembly(id: string): Promise<AssemblyDetail> {
  const resp = await api.post<AssemblyDetail>(`/assemblies/${id}/cancel`);
  return resp.data;
}

/** 编辑装配体元数据（MANAGER + CLERK；仅 PENDING 可编辑）。 */
export async function updateAssembly(
  id: string,
  payload: AssemblyUpdatePayload,
): Promise<AssemblyDetail> {
  const resp = await api.post<AssemblyDetail>(`/assemblies/${id}/update`, payload);
  return resp.data;
}

// ---- 文件相关 ----
// 2026-07-10 起：装配体文件由 create_assembly / upload_total_pdf 流创建，
// uploadPdf 在 2026-09-25 合入 GET /assemblies/{id}/files 端点（POST multipart）。
// list 仍可调用。

// 2026-09-16 Phase 5 切 v2 后：列表端点返回分页包装 { items, total }（PartFileListResult），
// v2 默认 limit=50 会静默截断，clamp 上限 500，统一按上限取全量。
// 2026-09-25 修正：与 backend-rust 新加的 `GET /api/v2/assemblies/{id}/files` 端点对齐。
export async function listAssemblyFiles(id: string): Promise<PartFileListResult> {
  const resp = await api.get<PartFileListResult>(`/assemblies/${id}/files`, {
    params: { limit: 500 },
  });
  return resp.data;
}

/**
 * 列出某 part 关联的所有文件。
 *
 * @deprecated 2026-09-16 T3.5：v2 后端无 `/parts/{id}/files` 端点；保留此函数作为
 * `listPartFilesByOwner` 的 deprecation alias，转发到 `/part-files?owner_id=...`。
 * 下游调用点已在 T3.5 一次切换到 listPartFilesByOwner；M3-C 完成时统一移除。
 * 2026-09-25 显式补 `@deprecated` JSDoc tag。
 */
export async function listPartFiles(
  partId: string,
  kind?: 'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D',
): Promise<PartFileListResult> {
  return listPartFilesByOwner(partId, kind);
}

/**
 * 2026-09-16 M3 新增：owner 维度列出文件（`GET /api/v2/part-files?owner_id=...&kind=...`）。
 *
 * 替代 `listPartFiles` 的 `/parts/{part_id}/files` 旧路径——v2 rust 后端已经
 *  把列表端点统一到 `/part-files`（按 owner_id 多态查询）。kind 缺省 = 不过滤。
 *
 *  与 `listPartFiles` 区别：
 *  - 路径：`/part-files?owner_id=...&kind=...`（owner 多态）
 *  - 参数：limit 上限 500（v2 默认 50 会静默截断）
 *
 *  旧函数保留为 deprecation alias，下游调用点改在 M3-C 一次到位。
 */
export async function listPartFilesByOwner(
  partId: string,
  kind?: 'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D',
): Promise<PartFileListResult> {
  const resp = await api.get<PartFileListResult>('/part-files', {
    params: kind ? { owner_id: partId, kind, limit: 500 } : { owner_id: partId, limit: 500 },
  });
  return resp.data;
}

// 2026-09-25 清理：uploadPartDrawing / uploadPart3DModel / uploadPartCadFile
// 已迁回 `@/api/parts/file.ts`（更符合子域归属）；本文件不再 re-export。

/**
 * @deprecated 2026-09-16 T3.5：合并到 `deletePartFile(fileId, version)`。
 * 保留为 alias 以兼容未迁移 import；新代码请用具名导出。
 */
export { deletePartFile as deleteFile } from '@/api/parts/file';

/**
 * @deprecated 2026-09-16 T3.5：合并到 `getPartFileDownloadUrl(fileId)`。
 * 保留为 alias 以兼容未迁移 import；新代码请用具名导出。
 */
export { getPartFileDownloadUrl as getDownloadUrl } from '@/api/parts/file';

/** 类型守卫 */
export function isAssemblyItem(v: unknown): v is AssemblyItem {
  return !!v && typeof v === 'object' && 'drawing_no' in v && 'child_count' in v;
}
