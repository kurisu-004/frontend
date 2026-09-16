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
