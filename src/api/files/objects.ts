// 文件对象域 API（`/api/v2/files/objects/*`）—— 本文件是 files 域的**纯**实现：
// 每个导出函数都打 `/files/objects/*`，与 `api/files/cnc.ts`（`/files/cnc/pairs`）、
// `api/files/sts.ts`（`/files/sts-tmp-keys`）逐个镜像 `/files` 下的一个子命名空间。
//
// 打 `/parts/*` 的打印 BFF（`printPartDrawing` / `printPartDrawingBatch`）归
// `api/parts/print.ts`；`src/api/parts/index.ts` 继续把它们聚合导出，调用方从
// `@/api/parts` 具名 import 的写法不变。
//
// 2026-10-13 随后端 files 域重组，本文件自 `api/parts/file.ts` 迁入，URL 由
// `/api/v2/part-files/*` 硬切为 `/api/v2/files/objects/*`。⚠️ **旧路径
// `/api/v2/part-files/*` 已 404、无 alias**。
//
// 本文件覆盖的 6 个端点：
//   - POST /files/objects               multipart 直传（图纸 / 3D 模型 / 装配件总装图统一入口）
//   - POST /files/objects/confirm       COS 直传后的确认绑定（场景 B，配 `api/files/sts.ts`）
//   - GET  /files/objects               按 owner_id (+kind) 列文件
//   - GET  /files/objects/{id}/url      临时下载 URL 签发
//   - GET  /files/objects/{id}/preview  逐页图片预览直链（CI 转图，2026-10-13 新增）
//   - POST /files/objects/{id}/delete   软删（OCC，body 必带 version）
//   - GET  /files/objects/{id}/content  原始二进制（blob）—— 降级为「查看原始 PDF」兜底
//
// 导出数与端点数不等：另有纯 URL 构造器 `partFileContentPath`（不发请求，只拼
// `{id}/content` 的路径，未导出）与包着它的 `fetchPartFileContent`，两者不单列。
//
// **预览链路的两条路**（2026-10-13）：图纸预览首选 `/preview` 拿 CI 转好的逐页图片直链
// （`getPartFilePreview`），浏览器不再下载整份 PDF 交给 pdf.js；`/content` 保留为
// 「查看原始 PDF」的逃生口 —— 图片模式没有矢量缩放与文字选中，用户要看细节时仍要能
// 退回原始 PDF。端点不支持（`isPreviewUnsupportedError` 命中）时也自动走这条兜底。

import { api } from '@/api/http';
import type {
  ConfirmFileIn,
  FileOwnerKind,
  FilePreviewResult,
  PartFileItem,
  PartFileListResult,
  PartFileUrlResult,
} from '@/types/part_file';

// ============================================================
// multipart 直传（POST /files/objects）
// ============================================================
//
// 端点契约对 multipart body 有**严格**约束（违反即 40001）：
// 1. **恰好两个**字段：`data`（JSON 字符串，承载 owner_kind / owner_id / kind）与
//    `file`（二进制）。多 append 一个字段、缺字段、或换个字段名都不行；
// 2. `content_type` 必须落在扩展名白名单里（见下方 normalizeUploadContentType）。
//    后端按「扩展名 → 允许的 content_type」比对，不按浏览器嗅探结果放行。
//
// 因此 `content_type` **不能**直接用 `file.type`：.step / .stp / .igs 在多数浏览器上
// 是空串或 `application/octet-stream` 之外的怪值（部分环境给 .igs 报 text/plain），
// 直传会被后端 policy 挡回 40001。

/** PDF 的 content_type：后端对 `.pdf` 只接受这一种。 */
const PDF_CONTENT_TYPE = 'application/pdf';
/** 非 PDF（3D 模型 / CAD 源文件）的 content_type：后端对对应扩展名统一接受这一种二进制流。 */
const BINARY_CONTENT_TYPE = 'application/octet-stream';

/** 上传 `content_type` 归一：按**扩展名**分两档，与后端的白名单判据同源。
 *
 *  `.pdf` → `application/pdf`；其余扩展名（step / stp / iges / igs / stl / obj /
 *  3mf / dwg / dxf …）→ `application/octet-stream`。
 *
 *  ⚠️ **新增扩展名必须同时改三处，缺一即被后端拒**：本函数的两档映射、后端
 *  `part_file::policy::allowed_exts`（kind → 允许的扩展名）、后端
 *  `part_file::policy::expected_content_types_for_ext`（扩展名 → 允许的
 *  content_type）。本函数是**按扩展名分两档**而不是逐个映射，所以图片类扩展名
 *  （png / jpg / heic …）会落进 `application/octet-stream` 分支 —— 后端一旦放开
 *  图片图纸（当前 `allowed_exts("DRAWING")` **只有 `["pdf"]`**）而没有同时在
 *  `expected_content_types_for_ext` 里放行该扩展名的 `application/octet-stream`，
 *  上传就会被 40001 挡回。 */
function normalizeUploadContentType(file: File): string {
  return file.name.toLowerCase().endsWith('.pdf') ? PDF_CONTENT_TYPE : BINARY_CONTENT_TYPE;
}

/**
 * 文件对象 multipart 直传（`POST /api/v2/files/objects`）。
 *
 * 零件图纸（kind=DRAWING）、零件 3D 模型（kind=3D_MODEL）、装配件总装图
 * （owner_kind=ASSEMBLY + kind=ASSEMBLY_MASTER）三条链路**同端点**，差别只在
 * owner / kind 两个字段。
 *
 * ⚠️ URL 无尾斜杠：后端 nest 把内层的 `/` 折叠成 prefix 本身，带尾斜杠会 404。
 *
 * 单文件 ≤ 300MB；服务端把整份 multipart 读进内存后再转存对象存储 ⇒ 调用侧自己
 * 控并发（见 `usePartBatchPdf` 的 `PART_UPLOAD_CONCURRENCY`）。
 */
export async function uploadFileObject(
  ownerKind: FileOwnerKind,
  ownerId: string,
  kind: PartFileItem['kind'],
  file: File,
): Promise<PartFileItem> {
  const form = new FormData();
  form.append('data', JSON.stringify({ owner_kind: ownerKind, owner_id: ownerId, kind }));
  form.append('file', new File([file], file.name, { type: normalizeUploadContentType(file) }));
  const resp = await api.post<PartFileItem>('/files/objects', form);
  return resp.data;
}

// ============================================================
// COS 直传确认（场景 B，与 python STS grantStsTmpKey 配合）
// ============================================================

/**
 * `POST /api/v2/files/objects/confirm`：场景 B 确认绑定。
 *
 * 前端拿 `grantStsTmpKey` 的 `tmp_key` 配合 `cos-js-sdk-v5` 实际上传到 COS tmp 区，
 * 完成后调此端点让后端 head 校验 + copy tmp → 正式 CAS key + 插 `t_part_file(READY)` 行。
 *
 * owner（`owner_kind` + `owner_id`）在 body 里，不在 URL 上 —— 端点对零件与装配件
 * 一视同仁，故签名只收一个 payload 对象。
 */
export async function confirmFileObject(payload: ConfirmFileIn): Promise<PartFileItem> {
  const resp = await api.post<PartFileItem>('/files/objects/confirm', payload);
  return resp.data;
}

// ============================================================
// 文件对象的增删查（GET /files/objects、/{id}/url、/{id}/preview、/{id}/delete、/{id}/content）
// ============================================================

/**
 * owner 维度列出文件（`GET /api/v2/files/objects?owner_id=...&kind=...`）。
 *
 * `kind` 缺省 = 不过滤。`limit` 上限 500（后端 v2 默认 50 会静默截断）。
 *
 * ⚠️ **本函数不发 `owner_kind`，后端缺省按 `PART` 过滤**（`owner_kind` 缺省值就是
 * `PART`）⇒ 传装配件 id 进来拿到的**不是**装配件的文件。查装配件文件前必须先补
 * `owner_kind: 'ASSEMBLY'` 入参；本函数暂未提供该入参，因为当前三个调用方都是查零件
 * 文件（零件详情 / 报工台图纸预览 / 外协报价图纸预览），补参数时记得连带核对这三处。
 *
 * 装配件侧的文件列表走 `GET /assemblies/{id}` 详情响应的 `files[]`，不经过本函数。
 */
export async function listPartFilesByOwner(
  ownerId: string,
  kind?: 'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D',
): Promise<PartFileListResult> {
  const resp = await api.get<PartFileListResult>('/files/objects', {
    params: kind ? { owner_id: ownerId, kind, limit: 500 } : { owner_id: ownerId, limit: 500 },
  });
  return resp.data;
}

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
 * 该端点强制要求 JSON body `{ version }`，bodyless POST 会返回 415 Unsupported
 * Media Type。`version` 是当前行的乐观锁版本号，前端拿到 PartFileItem.version 后回传；
 * 后端版本不匹配会返 409 Conflict。
 *
 * 不传 version 会触发后端 schema validation 错误 → 这里强制 required。
 */
export async function deletePartFile(fileId: string, version: number): Promise<void> {
  await api.post(`/files/objects/${encodeURIComponent(fileId)}/delete`, { version });
}

/**
 * `GET /api/v2/files/objects/{id}/preview`：拿逐页图片预览直链（2026-10-13 新增）。
 *
 * 图纸预览的**首选**链路：服务端把 PDF 转成逐页图片，这里只回直链数组。收益是
 * 浏览器不再下载整份 PDF 交给 pdf.js 解析（大图纸的解析与首帧渲染是秒级的），
 * 直接把 CDN 图片挂进 `<img>` 即可。
 *
 * 可选 query `size=view|thumb|full`（缺省 `view`，2026-10-12 新增）：后端按档位给
 * `pages[]` 的直链追加**部署级固定 EdgeOne 参数**（`view` = `eo-img.resize=l/2560`、
 * `thumb` = `eo-img.resize=w/480`、`full` 无参数），直链仍无签名、不过期。**前端当前
 * 不传该参数**（吃默认 `view` 档）；非法值后端返信封 `40001`。
 *
 * 两态返回（`state`）：`READY`（`pages` 齐）/ `PENDING`（还在转，看 `retry_after_ms`）。
 * **转码失败不在 `state` 里** —— 后端一律返 5xx + 信封业务码（21117 终态失败 /
 * 21118 转发失败），故失败分支按 `ApiError.code` 分流（`isPreviewUnsupportedError` /
 * `isPreviewSelfHealError`，白名单在 `types/part_file.ts`）。**轮询与退避由调用侧负责**，
 * 本函数只发一次请求 —— 轮询编排见 `composables/usePreviewPolling.ts`。
 *
 * ⚠️ `fileId` 是**文件对象 id**，不是 part / assembly id。装配件总装图（owner=ASSEMBLY）
 * 与零件图纸（owner=PART）走同一条端点，owner 语义由后端按文件行自己解析，前端只管传 id。
 *
 * 端点不支持（`isPreviewUnsupportedError` 命中，如非 PDF / CI 未开通）时消费侧应回落
 * `/content` 原始 PDF 路径，不要当失败弹错。
 *
 * `signal` 供轮询侧中断在途请求（切文件 / 关弹窗时），单发调用可以不传。
 */
export async function getPartFilePreview(
  fileId: string,
  signal?: AbortSignal,
): Promise<FilePreviewResult> {
  const resp = await api.get<FilePreviewResult>(
    `/files/objects/${encodeURIComponent(fileId)}/preview`,
    { signal },
  );
  return resp.data;
}

/** `GET /api/v2/files/objects/{id}/content` 的相对路径（**不发请求**，只拼 URL）。
 *
 *  不导出：全仓唯一的消费方是同文件的 `fetchPartFileContent`，而 `/content` 端点不带
 *  鉴权 header 直接 GET ⇒ 必须走 `api` 实例的拦截器注入 Bearer token，裸 URL 交给
 *  调用方自行 axios.get 只会绕开它。 */
function partFileContentPath(fileId: string): string {
  return `/files/objects/${encodeURIComponent(fileId)}/content`;
}

/**
 * `GET /api/v2/files/objects/{id}/content`：拉文件 blob。
 *
 * **降级定位**：图纸预览首选 `/preview` 的 CI 转图直链，本函数不再是预览主力，
 * 而是三处仍要它：
 *   1. 「查看原始 PDF」逃生口 —— 图片模式没有矢量缩放与文字选中，用户要看细节时
 *      退回原始 PDF；
 *   2. `/preview` 端点不支持 / 转码失败时的自动兜底（`isPreviewUnsupportedError`）；
 *   3. 非图纸类文件（3D 模型 STEP/STL、CNC G 代码…）的内嵌预览 —— 它们不参与转图，
 *      blob 路径是唯一形态。
 *
 * 走 `api` 实例 + responseType=blob（FileListCard 在 caller 未注入 `apiGetPreviewUrl`
 * 时走这条默认路径）。**不要在图纸预览上再新增直调点**。
 */
export async function fetchPartFileContent(fileId: string): Promise<Blob> {
  const resp = await api.get<Blob>(partFileContentPath(fileId), {
    responseType: 'blob',
  });
  return resp.data;
}
