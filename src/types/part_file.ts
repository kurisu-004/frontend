// types/part_file.ts
//
// 2026-07-10 起统一的零件 / 装配体文件类型（与后端 schema/part_file.PartFileOut 对齐）。
// 取代旧的 DrawingFileItem / CncProgramItem。Assembly master / 零件图纸 / 3D 模型 /
// G 代码 / 设定单 / CAD 源文件 全部走这一个类型，用 `kind` 字段区分。
//
// 2026-07-14 扩展：DRAWING 同时接受 9 种图片格式（PNG/JPG/.../HEIC）；
// 新增 CAD_2D kind（DWG/DXF）；所有 row 带可选 `content_sha256` 用于去重提示。
//
// 2026-09-16 Phase 5 切 v2 后 part-file 域契约错位修复：
// - 列表端点 /parts/{id}/cnc-programs、/setup-sheets、/files 从裸数组改为
//   分页包装 PartFileListOut = { items, total }（无 limit/offset），新增 PartFileListResult；
// - PartFileItem.file_size 由 number 改 string（v2 i64 雪花序列化器统一转 string）；
// - 删除 download_url（v2 列表项不再即时签发下载 URL，改走 GET /part-files/{id}/url）。
//
// 2026-09-16 M3 新增：STS 直传 COS 契约（upload-intents / confirm / FileBinding）。
// 所有 id 字段保持 string 雪花；file_size 为 string i64；content_sha256 为 64-char 小写 hex。

/** 文件类型枚举（与后端 PartFileKind 的字符串值对齐） */
export type PartFileKind =
  'DRAWING' | '3D_MODEL' | 'G_CODE' | 'SETUP_SHEET' | 'ASSEMBLY_MASTER' | 'CAD_2D';

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
 * GET /api/v2/part-files/{id}/url 响应（/cnc-programs/{id}/download-url 为其 alias，同形状）。
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

/**
 * POST /api/v2/parts/{id}/cnc-pair 响应中的单文件引用（v2 CncFileRef）。
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
// 2026-09-16 M3 新增：STS 直传 COS 契约（与 backend-rust part_file::dto 对齐）
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

/** `POST /api/v2/parts/{id}/files/confirm` 入参（场景 B）。 */
export interface ConfirmFileIn {
  kind: PartFileKind;
  tmp_key: string;
  content_sha256: string;
  original_filename: string;
  file_size: string;
  content_type: string;
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

/** `PartBatchCreateOut.created[]` 单元素形状——结构上与 PartItem 兼容但
 *  含 version / 等额外字段（PartDetailOut 超集）。vitest / TS 类型断言时
 *  用 `as unknown as PartItem` 即可。 */
export interface PartFileDetailOut {
  id: string;
  version: number;
}
