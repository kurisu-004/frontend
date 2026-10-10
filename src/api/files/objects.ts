// 后端零件 API 封装 —— 文件 / 打印相关端点（图纸双面打印 PDF 生成）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./file 子域。
// 打印 2 端点走 `api`（baseURL `/api/v2`）：由 rust 鉴权后转发 python 生成 PDF，
// 前端路径与响应消费方式（blob + 隐藏 iframe 打印）不变。
//
// 2026-10-13 随后端 files 域重组：本文件自 `api/parts/file.ts` 迁入 `api/files/objects.ts`，
// URL 由 `/api/v2/part-files/*` **硬切**为 `/api/v2/files/objects/*`。
// ⚠️ **旧路径 `/api/v2/part-files/*` 已 404、无 alias**，后端同时删掉了 12 条零调用方端点。
// 迁入理由：`src/api/` 的子目录按「镜像独占 URL 命名空间」组织（约定见 `api/shelves.ts`
// 的模块注释），files 域重组后 `/files` 下有 `objects` / `cnc` / `sts-tmp-keys` 三个子
// 命名空间，正好对应 `api/files/` 下的 `objects.ts` / `cnc.ts` / `sts.ts`。
// ⚠️ **本文件仍寄住 5 个打 `/parts/*` 的零件侧函数**（printPartDrawing /
// printPartDrawingBatch / confirmPartFile / uploadPartDrawing / uploadPart3DModel）：
// 打印 BFF 后端刻意留在 part 域不搬，本次只做机械搬家不拆文件。后端 PR1b 会把
// upload-drawing / upload-3d-model / confirm 三条合并进 `POST /files/objects`，
// 届时应把这几个函数一并迁到本文件的 files 域实现下或退回 `parts/`。
//
// 2026-09-29 修复：兼容 nest 已移除。
// - 列出文件：listPartFilesByOwner + usePartFilesListQuery（composables/queries/）
// - 删除文件：本文件 deletePartFile
// - CNC 程序 / 设定单配对上传：`api/files/cnc.ts::uploadCncPair`
//   （走 POST /api/v2/files/cnc/pairs）
// - 打印端点（本文件核心）保持不变
//
// 2026-09-16 M3 + 2026-09-17 STS 端口迁移：原 createUploadIntents（backend-rust bulk）已下线；
// 本文件保留 confirmPartFile（场景 B 专用确认端点）配合 grantStsTmpKey
// （python STS 单端口，详见 @/api/files/sts）。

import { api } from '@/api/http';
import type { ConfirmFileIn, PartFileItem, PartFileUrlResult } from '@/types/part_file';

/**
 * 生成零件的双面打印 PDF（图纸 + 反面右下角条形码）。
 * 返回 Blob，content-type=application/pdf。
 *
 * 注：返回的是文件 blob，调用方需自行用 iframe / window 触发打印。
 *
 * 2026-10-03：端点由 rust 鉴权后转发 python（`GET /api/v2/parts/{id}/print-drawing`），
 * 前端走 `api`。响应是 PDF blob，**文件名不消费**——单件打印由调用方把 blob 塞进隐藏
 * iframe 内联渲染，不落盘，因此用不到 `Content-Disposition`。
 */
export async function printPartDrawing(partId: string): Promise<Blob> {
  const resp = await api.get<Blob>(`/parts/${encodeURIComponent(partId)}/print-drawing`, {
    responseType: 'blob',
  });
  return resp.data;
}

/**
 * 批量生成多个零件的双面打印 PDF 并合并为一个 PDF（2026-07-17 接入）。
 * 后端把 N 个 part 的双面 PDF 顺序拼接成单文件返回。
 * 前端拿到 Blob 后用单 iframe 一次 print()，避免 N 次打印弹窗。
 *
 * 2026-10-03：端点由 rust 鉴权后转发 python（`POST /api/v2/parts/print-drawing-batch`）。
 * timeout 12 分钟：N 个 part 拼 PDF 耗时可达分钟级，**必须严格大于 rust 打印档的 660s**
 * 并留余量。两级超时串联时若浏览器先到点，只会抛一个无信息量的 ECONNABORTED，把 rust
 * 侧的真实诊断（转发层 600s 转发超时的 502 + 20407，或打印档 660s 请求中间件的
 * 408 + 40800）整个吃掉，排查时看不到任何服务端信号。
 */
export async function printPartDrawingBatch(
  partIds: string[],
  assemblyIds?: string[],
): Promise<Blob> {
  const resp = await api.post<Blob>(
    '/parts/print-drawing-batch',
    { part_ids: partIds, assembly_ids: assemblyIds },
    { responseType: 'blob', timeout: 12 * 60 * 1000 },
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
// 2026-09-16 T3.5：文件对象域 v2 实际路径的辅助端点（删除 / 下载 / 内容预览）
// ============================================================
//
// 背景：原 `api/assembly.ts` 里的 `deleteFile / getDownloadUrl` 路径写的是
// `POST /files/{id}/delete` / `GET /files/{id}/content`（v1 时代的端点），
// v2 后端实际路径先是 `/part-files/{id}/...`、2026-10-13 起随 files 域重组
// 硬切为 `/files/objects/{id}/...`。本组函数走 v2 实际路径 +
// 对齐 PartFileUrlResult / PartFileListResult 契约。

/**
 * `GET /api/v2/files/objects/{id}/url`：临时下载 URL 签发。
 *
 * 后端返回 `PartFileUrlResult.download_url`，直接 `window.open(url)` 或 `a.href = url` 触发下载。
 * URL 含 COS 临时签名（过期时间由 `url_expires_in_seconds` 决定）。
 */
export async function getPartFileDownloadUrl(fileId: string): Promise<string> {
  const resp = await api.get<PartFileUrlResult>(`/files/objects/${encodeURIComponent(fileId)}/url`);
  return resp.data.download_url;
}

/**
 * `POST /api/v2/files/objects/{id}/delete`：软删（OCC）。
 *
 * v2 `soft_delete_part_file` 强制要求 JSON body `{ version }`，bodyless POST 会
 * 返回 415 Unsupported Media Type。`version` 是当前行的乐观锁版本号，前端拿到
 * PartFileItem.version 后回传；后端版本不匹配会返 409 Conflict。
 *
 * 不传 version 会触发后端 schema validation 错误 → 这里强制 required。
 */
export async function deletePartFile(fileId: string, version: number): Promise<void> {
  await api.post(`/files/objects/${encodeURIComponent(fileId)}/delete`, { version });
}

/**
 * `GET /api/v2/files/objects/{id}/content`：返回文件原始二进制（blob）。
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
  return `/files/objects/${encodeURIComponent(fileId)}/content`;
}

/**
 * `GET /api/v2/files/objects/{id}/content`：拉文件 blob。
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
// 零件文件 multipart 上传（图纸 / 3D 模型）
// ============================================================
//
// 2026-10-04：图纸 / 3D 的后置上传端点是 `POST /parts/{id}/upload-drawing` 与
// `POST /parts/{id}/upload-3d-model`（与详情页的 `usePartFileUpload` 是两条不同链路：
// 后者带 `owner_part_id` + kind 落 part-file 表，作用于任意所有者；本文件这两个是
// 「part 建好之后，把这批录入用的原件补传上去」的批量录入路径）。
//
// 端点契约对 multipart body 有**严格**约束（违反即 40001）：
// 1. 只接受**一个**名为 `file` 的字段。多 append 一个字段、缺字段、或换个字段名都不行；
// 2. `content_type` 必须落在扩展名白名单里（见下方两个归一函数）。后端按「扩展名 →
//    允许的 content_type」比对，不按浏览器嗅探结果放行。
//
// 因此 `content_type` **不能**直接用 `file.type`：.step / .stp / .igs 在多数浏览器上
// 是空串或 `application/octet-stream` 之外的怪值（部分环境给 .igs 报 text/plain），
// 直传会被后端 policy 挡回 40001。归一逻辑见 PDF_CONTENT_TYPE / THREE_D_CONTENT_TYPE。

/** 图纸 / PDF 的 content_type：后端对 `.pdf` 只接受这一种。 */
const PDF_CONTENT_TYPE = 'application/pdf';
/** 3D 模型的 content_type：后端对全部 3D 扩展名统一接受这一种二进制流。 */
const THREE_D_CONTENT_TYPE = 'application/octet-stream';

/**
 * 上传零件图纸（`POST /api/v2/parts/{part_id}/upload-drawing`）。
 *
 * multipart body **只** append 一个 `file` 字段；`content_type` 一律写
 * `application/pdf`（后端按扩展名白名单比对，不接受浏览器嗅探值）。
 * 单文件 ≤ 300MB；服务端把整份 multipart 读进内存后再转存对象存储 ⇒ 调用侧自己
 * 控并发（见 `usePartBatchPdf` 的 `PART_UPLOAD_CONCURRENCY`）。
 */
export async function uploadPartDrawing(partId: string, file: File): Promise<PartFileItem> {
  const form = new FormData();
  const payload = new File([file], file.name, { type: PDF_CONTENT_TYPE });
  form.append('file', payload);
  const resp = await api.post<PartFileItem>(
    `/parts/${encodeURIComponent(partId)}/upload-drawing`,
    form,
  );
  return resp.data;
}

/**
 * 上传零件 3D 模型（`POST /api/v2/parts/{part_id}/upload-3d-model`）。
 *
 * 支持 STEP / STP / IGES / IGS / STL / OBJ / 3MF。multipart body **只** append 一个
 * `file` 字段；`content_type` 一律写 `application/octet-stream`（后端对全部 3D
 * 扩展名接受这一种，浏览器给的 `File.type` 多为空串或怪值，不能直接用）。
 * 单文件 ≤ 300MB；服务端把整份 multipart 读进内存后再转存对象存储。
 */
export async function uploadPart3DModel(partId: string, file: File): Promise<PartFileItem> {
  const form = new FormData();
  const payload = new File([file], file.name, { type: THREE_D_CONTENT_TYPE });
  form.append('file', payload);
  const resp = await api.post<PartFileItem>(
    `/parts/${encodeURIComponent(partId)}/upload-3d-model`,
    form,
  );
  return resp.data;
}

// 2026-10-13：删除 `uploadPartCadFile`（本文件原 :202-217）。
// 理由：它打的 `POST /api/v2/parts/{id}/cad-files` 后端路由**早已不存在**（2026-09-16
// M3 重构时 multipart 直传链路被 COS 直传 + JSON 链路取代），函数自身已于
// 2026-09-16 标注 `@deprecated`，且 rg 核实**零调用方**（全仓仅余
// `api/assembly.ts` 清理记录里的一句名字提及）。留着只会让人以为 CAD 2D 还能直传。
// CAD 源文件补传的正确入口是场景 B：`usePartFileUpload({ ownerPartId, kind: 'CAD_2D' })`。
