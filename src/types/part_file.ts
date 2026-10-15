// types/part_file.ts
//
// 2026-07-10 起统一的零件 / 装配体文件类型（与后端 schema/part_file.PartFileOut 对齐）。
// Assembly master / 零件图纸 / 3D 模型 / G 代码 / 设定单 / CAD 源文件 全部走
// `PartFileItem` 这一个类型，用 `kind` 字段（枚举见 `PartFileKind`）区分。
//
// 2026-07-14 扩展：新增 CAD_2D kind（DWG/DXF）；所有 row 带可选 `content_sha256` 用于去重提示。
// ⚠️ **DRAWING 当前只收 PDF**：后端 `part_file::policy::allowed_exts("DRAWING")` 就是
//   `["pdf"]`，图片格式（PNG / JPG / HEIC …）未开放。要放开时同时改后端白名单与前端
//   `api/files/objects.ts::normalizeUploadContentType` 的 content_type 映射（见那里的
//   「新增扩展名必须同时改三处」）。
//
// 2026-09-16 Phase 5 切 v2 后 part-file 域契约错位修复：
// - 列表端点 /parts/{id}/cnc-programs、/setup-sheets、/files 从裸数组改为
//   分页包装 PartFileListOut = { items, total }（无 limit/offset），新增 PartFileListResult；
// - PartFileItem.file_size 由 number 改 string（v2 i64 雪花序列化器统一转 string）；
// - 删除 download_url（v2 列表项不再即时签发下载 URL，改走 GET /files/objects/{id}/url）。
//
// 2026-10-13 后端 files 域重组：列表 / 下载 URL / 内容三条端点硬切
// `/api/v2/part-files/*` → `/api/v2/files/objects/*`。**旧路径 404、无 alias**。
//
// 2026-10-15：配对上传端点 `/api/v2/files/cnc/pairs` 下线（multipart 代理上传一并下线），
// 配对关系改由直传链路的 `objects/confirm` 的 `pair_with_file_id` 表达；随它一起走的
// `CncPairedFileRef` 类型与本文件里的 `upload-intents` 凭证类型（`CosCredentials` 等）
// 一并删除 —— 本文件现在只剩文件对象域自身的行 VO / 预览契约 / 错误码分流。
//
// 2026-10-13 图纸预览切 CI 转图直链：新增 `FilePreviewResult` / `FilePreviewState` 与
// 降级码白名单 `PREVIEW_UNSUPPORTED_CODES`（见下方小节）。预览链路是**两条**：
// `GET /files/objects/{id}/preview`（首选，回逐页图片直链，浏览器不下载整份 PDF）与
// `GET /files/objects/{id}/content`（**保留**，是「查看原始 PDF」逃生口 + 转图不可用
// 时的兜底 + 非图纸文件内嵌预览的唯一形态）。两者不是替代关系，不要因为切了预览路径
// 就把 `/content` 当成遗留清掉。
//
// 2026-10-15：STS 直传链路（upload-intents 凭证 + tmp_key）下线，本文件只剩**文件对象域
// 自身的行 VO / 预览契约 / 错误码分流**。上传的 wire 契约见 `src/types/file_intent.ts`。

/** 文件类型枚举（与后端 PartFileKind 的字符串值对齐）
 *
 *  2026-10-15 新增 `DELIVERY_TEMPLATE`：送货单打印模板（按一级客户绑定的那份 xlsx）。
 *  它与其它 kind 最大的差别是**文件对象不挂零件也不挂装配件**，owner 是 CUSTOMER
 *  （见 `FileOwnerKind`），但落库仍是同一张 `t_part_file`、读侧仍是同一套
 *  `PartFileItem` 形状 —— 打印对话框的「按客户解析模板」走的是独立的 print-templates
 *  端点，不从这里读。
 */
export type PartFileKind =
  | 'DRAWING'
  | '3D_MODEL'
  | 'CAD_2D'
  | 'G_CODE'
  | 'SETUP_SHEET'
  | 'ASSEMBLY_MASTER'
  | 'DELIVERY_TEMPLATE';

/**
 * 文件对象的多态 owner 类型（对齐后端 `owner_kind`）。
 *
 * `t_part_file` 一张表同时存零件与装配件的文件（装配件总装图 = `owner_kind='ASSEMBLY'`
 * + `kind='ASSEMBLY_MASTER'`），owner 维度从 path 段搬进了请求体，故上传 / 确认两个
 * 端点的入参都必须显式带它。
 *
 * 2026-10-15 新增 `CUSTOMER`：送货单打印模板的 owner 是**一级客户**（不是零件也不是
 * 装配件），故直传链路必须能表达这一维。⚠️ `owner_id` 在这一支是客户 id，与零件 /
 * 装配件分支下的 part.id / assembly.id 是**不同的表**——三者的雪花取值范围不重叠，
 * 读代码时不要按「都是 t_ 开头」推定它们可互换。
 */
export type FileOwnerKind = 'PART' | 'ASSEMBLY' | 'CUSTOMER';

/**
 * 2026-10-04：后端 `BIZ_PART_FILE_DUPLICATE` —— 同一 `(part_id, kind)` 已有未删除文件。
 *
 * 唯一索引 `uk_t_part_file_single ON (part_id, kind) WHERE deleted_at IS NULL`，与文件
 * 内容无关：只要那个 part 的那个 kind 已经有文件，二次上传必撞此码。
 *
 * multipart 上传最常见的失败形态是「后端已写完 `t_part_file`、响应在回程被掐掉」
 * （超时 / 连接重置）。此时文件其实好好在服务端，前端却记成了失败；再重试一次只会
 * 稳定地拿到这个码，于是 UI 永远停在假错误里。⇒ 命中此码按**已存在**处理，不记失败。
 */
export const PART_FILE_DUPLICATE_CODES = [21108] as const;

/** 触发「文件已存在、按成功处理」的 ApiError.code 取值类型。 */
export type PartFileDuplicateCode = (typeof PART_FILE_DUPLICATE_CODES)[number];

/** 判断一个后端错误是否命中 `PART_FILE_DUPLICATE_CODES`（读 `ApiError.code`）。 */
export function isPartFileDuplicateError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    typeof code === 'number' && (PART_FILE_DUPLICATE_CODES as readonly number[]).includes(code)
  );
}

/** 统一文件项（对齐 v2 backend-rust PartFileOut） */
export interface PartFileItem {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  /** polymorphic owner_id：真实 t_part.id 或 t_assembly.id（kind=ASSEMBLY_MASTER） */
  owner_id: string;
  kind: PartFileKind;
  /** 扩展名大写：PDF / PNG / STEP / NC / DWG / DXF / ... */
  file_type: string;
  original_filename: string;
  /** 字节数；v2 i64 雪花序列化器转 string，消费侧需 Number() 后再格式化 */
  file_size: string;
  content_type: string;
  upload_status: string;
  /** SHA-256 hex（64 chars）；NULL = 历史记录未计算。用于判断去重命中。 */
  content_sha256: string | null;
  created_at: string;
  /** 关联的配对文件 ID（G_CODE <-> SETUP_SHEET 双向关联）；NULL=未配对 */
  paired_file_id: string | null;
}

/**
 * part-file 域列表分页结果（对齐 v2 backend-rust PartFileListOut）。
 * 2026-09-16 新增：Phase 5 切 v2 后 /parts/{id}/cnc-programs、/setup-sheets、/files
 * 返回 { items, total } 包装（无 limit/offset 字段），前端用 `.items` 取数组。
 */
export interface PartFileListResult {
  items: PartFileItem[];
  total: number;
}

/**
 * GET /api/v2/files/objects/{id}/url 响应（同形状的 /cnc-programs/{id}/download-url
 * alias 端点后端已下线，旧路径 404）。
 * 2026-09-16 新增：Phase 5 切 v2 后临时下载 URL 走该端点，字段名是 download_url（非 url）。
 */
export interface PartFileUrlResult {
  id: string;
  kind: PartFileKind;
  file_type: string;
  original_filename: string;
  /** 该出参 file_size 是纯 i64（未走雪花序列化器）→ JSON number，与列表项的 string 不同 */
  file_size: number;
  content_type: string;
  content_sha256: string | null;
  upload_status: string;
  /** COS 临时签名下载 URL；每次请求即时签发 */
  download_url: string;
  url_expires_in_seconds: number;
}

// ============================================================
// 图纸预览（CI 转图直链）
// ============================================================

/**
 * `GET /files/objects/{id}/preview` 的转码态（2026-10-13 新增）。
 *
 * **只有这两个取值**：后端失败一律走「HTTP 5xx + 信封业务码」，不返终态字符串 ——
 * `FAILED` 只存在于后端 `t_file_preview.state` 表列里、不出现在响应里。故消费侧拿到
 * 本枚举之外的值（后端将来加了新状态）当「不认识」处理，不要当成功也不要当失败。
 *
 * - `READY`：转图完成，`pages` 是逐页图片直链（公开读直链，无签名、不过期，可带部署级
 *   固定查询参数，见 `?size=` 档位；2026-10-12 补注），长度 = `page_count`；
 * - `PENDING`：CI 仍在转，`pages` 恒为空数组，`retry_after_ms` 是**建议**重试间隔。
 */
export type FilePreviewState = 'READY' | 'PENDING';

/**
 * `GET /api/v2/files/objects/{id}/preview` 出参（2026-10-13 新增）。
 *
 * 图纸预览的**首选**链路：服务端把 PDF 转成逐页图片，前端只拿直链，浏览器不再下载
 * 整份 PDF 交给 pdf.js 解析。`/content` 保留为「查看原始 PDF」兜底入口，两者不是
 * 替代关系（见 `ImagePager.vue` 文件头的能力取舍说明）。
 *
 * `retry_after_ms` 后端是**非空** `u64`（`PENDING` 返距节流戳的毫秒数、`READY` 返 0），
 * 这里仍放宽成 `number | null` 作防御：后端将来给一个可空的建议间隔时不必改前端类型。
 */
export interface FilePreviewResult {
  state: FilePreviewState;
  /** PDF 总页数；`PENDING` 时后端返 0，消费侧只在 `READY` 时读它。 */
  page_count: number;
  /** 逐页图片直链；仅 `READY` 时非空。公开读、无签名、不过期，可带部署级固定查询参数。 */
  pages: string[];
  /** 建议重试间隔（毫秒）；后端 `READY` 时返 0（不是 null）。 */
  retry_after_ms: number | null;
  /**
   * 预留字段：**后端当前恒为 `null`**（转码失败走 5xx 信封，见 `FilePreviewState` 的
   * 说明）。消费侧不要从它取失败原因 —— 失败原因在 `ApiError.message` 里。
   */
  error: string | null;
}

// ---------------------------------------------------------------------------
// 转图失败的错误码分流
// ---------------------------------------------------------------------------
//
// ⚠️ **这里判的是 `ApiError.code`，而 `ApiError.code` 在响应体是信封时等于信封里的
// 业务码、不是 HTTP 状态码**（`api/http.ts` 的响应拦截器 `new ApiError(payload.code…)`）。
// 后端 `AppError::into_response()` 对 21116 / 21117 / 21118 一律装信封，所以
// 「21116 的 HTTP 400」在前端读到的 `code` 是 **21116**、不是 400。
//
// 400 / 502 两个 HTTP 状态码只兜**无信封**的代理层错误（nginx 直接返的纯文本 /
// HTML 502）：那时响应体解析不出信封，拦截器退化成用 HTTP 状态码兜底。
//
// 与 `PART_FILE_DUPLICATE_CODES` 同款：这里是常量白名单，配下面的判别器。
// **改动必须同步**两处。

/**
 * 2026-10-13：`/preview` 端点**重试没有意义**的错误码 ⇒ 命中即降级到 `/content`。
 *
 * - `21116` 该文件不做转图（kind 非图纸类 / `file_type ≠ PDF`）：确定性判定，重试一万次
 *   结果也一样；
 * - `21118` 打 python / CI 转发失败（含后端 `NoopPyBackend` 占位）：转发链路本身不通，
 *   轮询只是在等一个不会自己好起来的上游；
 * - `400` / `502` 无信封的代理层错误：同一 origin 的 `/content` 兜底走的是同一条链路，
 *   代理层不通时重试预览没有不同结果。
 */
export const PREVIEW_UNSUPPORTED_CODES = [400, 502, 21116, 21118] as const;

/**
 * 2026-10-13：转码失败但**允许有限自愈**的错误码 ⇒ 至多重试
 * `PREVIEW_SELF_HEAL_MAX_RETRY` 次，之后降级。
 *
 * `21117` = CI job 终态失败（Failed / Cancel / Pause / NotExist）。后端对 FAILED 行做的是
 * 「重置为 PENDING + 清 `ci_job_id` 后重走推进流程」= **重新提交一个 CI job**，而 CI 按页
 * 计费 ⇒ 不设上限的话一次终局失败会被前端轮询驱动成十几次重新提交。
 * 留 1 次重试是尊重后端「下一次调用自愈」的设计（python 侧偶发抖动能自愈），
 * 同时把重复提交的次数钉在可接受的量级。
 */
export const PREVIEW_SELF_HEAL_CODES = [21117] as const;

/** `PREVIEW_SELF_HEAL_CODES` 命中的错误最多自愈重试几次。 */
export const PREVIEW_SELF_HEAL_MAX_RETRY = 1;

/**
 * 判断一个后端错误是否命中 `PREVIEW_UNSUPPORTED_CODES`（读 `ApiError.code`）。
 *
 * ⚠️ **只判这些码**，不要顺手把网络错误（`code === 0`）也吞进来：网络错误是「不知道
 * 能不能转」，不是「不支持转」，静默降级会让现场看到「预览偶尔变成 PDF」却查不出
 * 网关在抖。轮询上限到点后由 `usePreviewPolling` 显式置 `degraded`，那条路径是有告知的。
 */
export function isPreviewUnsupportedError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    typeof code === 'number' && (PREVIEW_UNSUPPORTED_CODES as readonly number[]).includes(code)
  );
}

/** 判断一个后端错误是否命中 `PREVIEW_SELF_HEAL_CODES`（读 `ApiError.code`）。 */
export function isPreviewSelfHealError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'number' && (PREVIEW_SELF_HEAL_CODES as readonly number[]).includes(code);
}

// ---------- 向后兼容 alias（旧 import 路径仍可用） ----------

/** @deprecated 用 PartFileItem 替代 */
export type DrawingFileItem = PartFileItem;

// ============================================================
// 2026-09-16 M3 新增：STS 直传 COS 契约（与 backend-rust files::part_file::dto 对齐）
//
// 2026-10-15：STS 临时凭证链路整段下线（`CosCredentials` / `UploadIntentsIn` /
// `UploadIntentsOut` / `FileBinding` / 本文件内的 `ConfirmFileIn` 全部移出）。
// 直传契约的新形状（upload-intents 预签 URL + confirm 登记）见 `src/types/file_intent.ts`。
// ============================================================

/** `POST /api/v2/parts/batch` 出参（场景 A，FE 视图）。
 *
 *  与 rust 后端 `PartBatchCreateOut` 对齐：`created` = `Vec<PartDetailOut>`，
 *  `failed` = `Vec<PartBatchCreateFailure>`，`cleanup_tmp_keys` = 后端自清理的
 *  失败 tmp 对象 key 列表。前端**忽略** cleanup_tmp_keys（M3 范围，T3.4 改造后
 *  表单提交也无需关心），后端 commit 后会尽力清理。 */
export interface PartBatchCreateOut {
  created: PartFileDetailOut[];
  failed: Array<{
    item_index: number;
    code: number;
    message: string;
    part_id?: string | null;
  }>;
  cleanup_tmp_keys: string[];
}

/** `PartBatchCreateOut.created[]` 单元素形状——结构上与 `@/api/parts` 的
 *  `PartDetailDto` 兼容但含 version 等额外字段（PartDetailOut 超集）。vitest / TS
 *  类型断言时用 `as unknown as PartDetailDto` 即可。 */
export interface PartFileDetailOut {
  id: string;
  version: number;
}
