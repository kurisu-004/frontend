// types/part_file.ts
//
// 2026-07-10 起统一的零件 / 装配体文件类型（与后端 schema/part_file.PartFileOut 对齐）。
// 取代旧的 DrawingFileItem / CncProgramItem。Assembly master / 零件图纸 / 3D 模型 /
// G 代码 / 设定单 / CAD 源文件 全部走这一个类型，用 `kind` 字段区分。
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
// `/api/v2/part-files/*` → `/api/v2/files/objects/*`，配对上传硬切
// `/api/v2/cnc-programs/pairs` → `/api/v2/files/cnc/pairs`。**旧路径 404、无 alias**。
//
// 2026-10-13 图纸预览切 CI 转图直链：新增 `FilePreviewResult` / `FilePreviewState` 与
// 降级码白名单 `PREVIEW_UNSUPPORTED_CODES`（见下方小节）。预览链路是**两条**：
// `GET /files/objects/{id}/preview`（首选，回逐页图片直链，浏览器不下载整份 PDF）与
// `GET /files/objects/{id}/content`（**保留**，是「查看原始 PDF」逃生口 + 转图不可用
// 时的兜底 + 非图纸文件内嵌预览的唯一形态）。两者不是替代关系，不要因为切了预览路径
// 就把 `/content` 当成遗留清掉。
//
// 2026-09-16 M3 新增：STS 直传 COS 契约（upload-intents / confirm / FileBinding）。
// 所有 id 字段保持 string 雪花；file_size 为 string i64；content_sha256 为 64-char 小写 hex。

/** 文件类型枚举（与后端 PartFileKind 的字符串值对齐） */
export type PartFileKind =
  'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D';

/**
 * 文件对象的多态 owner 类型（对齐后端 `owner_kind`）。
 *
 * `t_part_file` 一张表同时存零件与装配件的文件（装配件总装图 = `owner_kind='ASSEMBLY'`
 * + `kind='ASSEMBLY_MASTER'`），owner 维度从 path 段搬进了请求体，故上传 / 确认两个
 * 端点的入参都必须显式带它。
 */
export type FileOwnerKind = 'PART' | 'ASSEMBLY';

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
    typeof code === 'number' &&
    (PREVIEW_UNSUPPORTED_CODES as readonly number[]).includes(code)
  );
}

/** 判断一个后端错误是否命中 `PREVIEW_SELF_HEAL_CODES`（读 `ApiError.code`）。 */
export function isPreviewSelfHealError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    typeof code === 'number' && (PREVIEW_SELF_HEAL_CODES as readonly number[]).includes(code)
  );
}

/**
 * 2026-09-29 修复：原 /api/v2/parts/{id}/cnc-pair 已移除兼容 nest，迁移到配对上传端点。
 * 2026-10-13：随 files 域重组硬切为 `POST /api/v2/files/cnc/pairs`（旧路径 404、无 alias）。
 * POST /api/v2/files/cnc/pairs 响应中的单文件引用（v2 CncFileRef）。
 * 2026-09-16 新增：Phase 5 切 v2 后该端点返回 { g_code, setup_sheet } 对象（非数组）。
 */
export interface CncPairedFileRef {
  id: string;
  kind: PartFileKind;
  file_type: string;
  original_filename: string;
  /** v2 i64 雪花序列化器转 string */
  file_size: string;
  content_type: string;
  content_sha256: string | null;
  download_url: string;
  paired_file_id: string | null;
}

// ---------- 向后兼容 alias（旧 import 路径仍可用） ----------

/** @deprecated 用 PartFileItem 替代 */
export type DrawingFileItem = PartFileItem;
/** @deprecated 用 PartFileItem 替代 */
export type CncProgramItem = PartFileItem;

// ============================================================
// 2026-09-16 M3 新增：STS 直传 COS 契约（与 backend-rust files::part_file::dto 对齐）
// ============================================================

/** STS 临时凭证（`POST /api/v2/part-files/upload-intents` 返回）。
 *
 *  直接喂给 `new COS({ SecretId, SecretKey, SecurityToken, XCosSecurityToken })`。
 *  expired_time 是 UTC 秒数（i64，JSON 解析为 number），前端比较时需 *1000。
 */
export interface CosCredentials {
  tmp_secret_id: string;
  tmp_secret_key: string;
  session_token: string;
  /** UTC 秒（i64，后端直接以 i64 序列化） */
  expired_time: number;
}

/** upload-intents 单项入参（与 `UploadIntentItemIn` 对齐）。 */
export interface UploadIntentItemIn {
  kind: PartFileKind;
  filename: string;
  /** 字节数；v2 i64 序列化器统一转 string，消费侧同样按 string 序列化回发。 */
  file_size: string;
  /** 64-char 小写 hex；由前端 `computeSha256` 计算。 */
  content_sha256: string;
  content_type: string;
}

/** upload-intents 请求 body（与 `UploadIntentsIn` 对齐）。
 *
 *  owner_part_id 可选：场景 A（创建工单）不填，后端直接签发新 batch tmp_key；
 *  场景 B（详情页补传）填 part_id，后端会按 (part_id, kind, sha) 查重，
 *  命中项标 `dedup_hit: true` 附 `existing_file`，跳过上传直接用旧文件。
 */
export interface UploadIntentsIn {
  owner_part_id?: string;
  files: UploadIntentItemIn[];
}

/** upload-intents 单项出参（与 `UploadIntentItemOut` 对齐）。 */
export interface UploadIntentItemOut {
  /** 前端生成的 client_ref（用于在 items 数组中反查原始 File）。 */
  client_ref: string;
  /** COS tmp 区 key；后端生成，前端需原样填回 confirm / batch item。 */
  tmp_key: string;
  /** true = 后端按 (owner, kind, sha) 命中已有文件，可跳过上传直接复用 existing_file。 */
  dedup_hit: boolean;
  /** dedup_hit 时返回已有文件（前端用其替换本次上传）；非命中时 undefined。 */
  existing_file?: PartFileItem;
}

/** upload-intents 完整响应（与 `UploadIntentsOut` 对齐）。 */
export interface UploadIntentsOut {
  credentials: CosCredentials;
  bucket: string;
  region: string;
  /** STS policy resource 限定前缀（前端展示用，实际写传时 tmp_key 已自含该前缀）。 */
  tmp_prefix: string;
  items: UploadIntentItemOut[];
}

/** `POST /api/v2/files/objects/confirm` 入参（场景 B）。
 *  2026-09-29 新增：与 rust `ConfirmFileIn` 对齐，新增 `ext: string` 必填字段。
 *  caller 用 utils/fileExt.parseFileExt 从 original_filename 解析；后端据此做
 *  CAS path 派生 + 类型校验（与 grant 端口的 ext 共享同一白名单）。
 *
 *  2026-10-13：owner 从 URL path 段搬进请求体（`POST /parts/{id}/files/confirm`
 *  → `POST /files/objects/confirm`，旧路径 404、无 alias），故新增
 *  `owner_kind` / `owner_id` 两个必填字段。 */
export interface ConfirmFileIn {
  kind: PartFileKind;
  tmp_key: string;
  content_sha256: string;
  original_filename: string;
  file_size: string;
  content_type: string;
  /** 2026-09-29 必填：文件扩展名小写字母数字 1-7 字符（utils/fileExt.parseFileExt 解析）。 */
  ext: string;
  /** 多态 owner 类型：`PART` = t_part 行，`ASSEMBLY` = t_assembly 行。 */
  owner_kind: FileOwnerKind;
  /** 雪花 ID 字符串（t_part.id 或 t_assembly.id），**一律按 string 处理**。 */
  owner_id: string;
}

/** 批量建单 item 的文件绑定（场景 A）。
 *
 *  与 rust 后端 `PartBatchCreateItem.drawing_file` / `model3d_file` 字段对齐，
 *  类型为 `FileBindingIn`（tmp_key + sha + filename + size + content_type）。
 */
export interface FileBinding {
  tmp_key: string;
  content_sha256: string;
  original_filename: string;
  file_size: string;
  content_type: string;
}

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
