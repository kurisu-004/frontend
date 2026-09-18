// types/upload_session.ts
//
// 2026-09-18 新增：backend-rust `/api/v2/upload-sessions/*` 端点契约类型。
//
// 取代旧的「每文件一次 grantStsTmpKey」模式 —— 新端点对 (scope, batch)
// 一次性签发 1 个 STS 凭证（pool）+ 多个 tmp_key，凭证续期走
// `POST /upload-sessions/{id}/renew`，临时文件清理由 `consume` /
// `discard` 完成。
//
// 范围（与 backend-rust `src/handlers/upload_sessions.rs` 严格对齐）：
// - get-or-create / allocate / complete / remove / renew / consume / discard 7 个端点；
// - 所有端点 baseURL = `/api/v2`，走 `api` 客户端（业务 v2，与 Phase 5 一致）。
//
// 字段约束：
// - `client_ref`：前端生成（crypto.randomUUID），唯一键；
// - `scope`：当前实现仅 `parts_new`（新建零件场景），但接口允许扩展；
// - `tmp_prefix`：STS policy resource 限定前缀（前端展示用，实际写传时 tmp_key 已自含）；
// - `credentials.expired_time` / `start_time`：UTC 秒（i64，JSON 解析为 number）。

/** 上传 session 作用域（与 backend-rust `UploadScope` Literal 对齐）。
 *  2026-09-18：当前实现仅 `parts_new`；新增 / 删减 / 重命名必须同步后端 schema。 */
export type UploadScope = 'parts_new';

/** Session 中单个文件条目（与 backend-rust `SessionFile` 对齐）。 */
export interface SessionFile {
  /** 前端生成的 client_ref（crypto.randomUUID），上传 + complete 阶段用于反查。 */
  client_ref: string;
  /** 文件 kind（前端统一小写：'drawing' / '3d_model' / ...，与 python StsPurpose 同源）。 */
  kind: string;
  /** 原始文件名。 */
  original_filename: string;
  /** 字节数；v2 i64 雪花序列化器统一转 string，消费侧 Number() 后再格式化。 */
  file_size: number;
  /** MIME type（image/png、application/pdf、application/octet-stream 等）。 */
  content_type: string;
  /** SHA-256 hex（64 chars，前端 computeSha256 输出）。 */
  content_sha256: string;
  /** COS tmp 区 key（allocate 后由后端分配）。 */
  tmp_key: string;
  /** 当前阶段：`pending`（allocate 后未上传）/ `done`（complete 后）/ `error`（上传失败后由 caller 显式 remove）。 */
  status: 'pending' | 'done' | 'error';
  /** COS ETag（status=done 后由前端调用 complete 时回传，可能为 null 表示未填）。 */
  etag: string | null;
  /** 上传完成时间 ISO8601；status=pending 时为 null。 */
  uploaded_at: string | null;
}

/** STS 凭证（与 backend-rust `StsCredentials` 对齐）。 */
export interface StsCredentials {
  tmp_secret_id: string;
  tmp_secret_key: string;
  session_token: string;
  /** UTC 秒（i64 雪花序列化器，JSON 解析为 number）。 */
  start_time: number;
  /** UTC 秒（i64 雪花序列化器，JSON 解析为 number）。 */
  expired_time: number;
}

/** upload session 完整响应（与 backend-rust `UploadSessionOut` 对齐）。
 *
 *  顶层字段：session_id / scope / tmp_prefix / bucket / region / credentials /
 *  expires_in / files[]。`files` 在 init 时为空数组，每次 allocate 后由后端追加。
 */
export interface UploadSession {
  session_id: string;
  scope: UploadScope;
  tmp_prefix: string;
  bucket: string;
  region: string;
  credentials: StsCredentials;
  /** 本次凭证剩余秒数（与 credentials.expired_time 一致，更易读）。 */
  expires_in: number;
  /** session 内已分配的文件条目（init 时为空）。 */
  files: SessionFile[];
}

// ============================================================
// 7 个端点的入参 / 出参类型
// ============================================================

/** `POST /upload-sessions/get-or-create` 入参。 */
export interface GetOrCreateUploadSessionIn {
  scope: UploadScope;
}

/** `POST /upload-sessions/get-or-create` 出参。 */
export type GetOrCreateUploadSessionOut = UploadSession;

/** `POST /upload-sessions/{session_id}/files:allocate` 入参的 files 单项。 */
export interface AllocateUploadSessionFileIn {
  /** 前端生成的 client_ref（caller 决定，便于 allocate 后反查 File）。 */
  client_ref: string;
  kind: string;
  original_filename: string;
  file_size: number;
  content_type: string;
  /** 完整 SHA-256 hex（64 chars）。前端 computeSha256 输出，截前 16 hex 是 python STS 端口约定；
   *  本 upload-session 端口约定**全量 64 chars**，与后端 SessionFile.content_sha256 字段对齐。 */
  content_sha256: string;
}

/** `POST /upload-sessions/{session_id}/files:allocate` 入参。 */
export interface AllocateUploadSessionFilesIn {
  scope: UploadScope;
  files: AllocateUploadSessionFileIn[];
}

/** `POST /upload-sessions/{session_id}/files:allocate` 出参的 items 单项。 */
export interface AllocateUploadSessionFileOut {
  /** 与入参 client_ref 一一对应。 */
  client_ref: string;
  /** COS tmp 区 key（后端生成）。 */
  tmp_key: string;
}

/** `POST /upload-sessions/{session_id}/files:allocate` 出参。 */
export interface AllocateUploadSessionFilesOut {
  items: AllocateUploadSessionFileOut[];
}

/** `POST /upload-sessions/{session_id}/files/{client_ref}/complete` 入参。 */
export interface CompleteUploadSessionFileIn {
  scope: UploadScope;
  /** COS 返回的 ETag；某些 SDK / 小文件 PUT 不返回 ETag 时可省略。 */
  etag?: string;
  /** 实际上传字节数（与 SessionFile.file_size 应一致，可选校验）。 */
  file_size?: number;
}

/** `POST /upload-sessions/{session_id}/files/{client_ref}/complete` 出参（单个 SessionFile）。 */
export type CompleteUploadSessionFileOut = SessionFile;

/** `POST /upload-sessions/{session_id}/files:remove` 入参。 */
export interface RemoveUploadSessionFilesIn {
  scope: UploadScope;
  client_refs: string[];
}

/** `POST /upload-sessions/{session_id}/files:remove` 出参。 */
export interface RemoveUploadSessionFilesOut {
  /** 实际被后端移除的 client_ref 列表（与入参可能不一致 —— 已 done 的不允许 remove）。 */
  removed: string[];
}

/** `POST /upload-sessions/{session_id}/renew` 入参。 */
export interface RenewUploadSessionCredentialsIn {
  scope: UploadScope;
}

/** `POST /upload-sessions/{session_id}/renew` 出参。 */
export interface RenewUploadSessionCredentialsOut {
  credentials: StsCredentials;
  /** 本次新凭证剩余秒数。 */
  expires_in: number;
}

/** `POST /upload-sessions/{session_id}/consume` 入参（提交成功后批量标记消费，
 *  后端将对应 tmp 对象保留更长时间窗以便业务端点 head+copy，避免被 tmp 区回收）。 */
export interface ConsumeUploadSessionFilesIn {
  scope: UploadScope;
  client_refs: string[];
}

/** `POST /upload-sessions/{session_id}/consume` 出参。 */
export interface ConsumeUploadSessionFilesOut {
  /** 实际被标记的 client_ref 列表（与入参一致）。 */
  consumed: string[];
}

/** `POST /upload-sessions/{session_id}/discard` 入参。 */
export interface DiscardUploadSessionIn {
  scope: UploadScope;
}

/** `POST /upload-sessions/{session_id}/discard` 出参。 */
export interface DiscardUploadSessionOut {
  session_id: string;
}
