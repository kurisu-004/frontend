// api/files/uploadSession.ts
//
// 2026-09-18 新增：backend-rust `/api/v2/upload-sessions/*` 端点 caller。
//
// 取代旧的「每文件一次 grantStsTmpKey」模式 —— 新端点对 (scope, batch)
// 一次性签发 1 个 STS 凭证（pool）+ 多个 tmp_key，凭证续期走
// `POST /upload-sessions/{id}/renew`，临时文件清理由 `consume` /
// `discard` 完成。
//
// 走 `api`（baseURL `/api/v2`）的原因：
// - 端点在 backend-rust（v2），与业务端点同源；
// - 与其它业务端点共享同一组 axios 拦截器 + refreshPromise 模块单例。
//
// 7 个端点 caller（命名统一 `getOrCreateUploadSession` /
// `allocateUploadSessionFiles` / `completeUploadSessionFile` /
// `removeUploadSessionFiles` / `renewUploadSessionCredentials` /
// `consumeUploadSessionFiles` / `discardUploadSession`），入参与出参类型
// 全部从 `@/types/upload_session` 导入，与契约严格对齐。
//
// 错误码：当前实现未提供专用业务错误码（参考 useProcessChainRequiredHandler
// 模式）；实际联调首日如发现专用 code，caller 端按 ApiError.code 兜底。
//
// 与 src/api/files/sts.ts 的差异：
// - sts.ts 走 `apiPrint`（baseURL `/api/v1`）python 单端口 1-key 响应；
// - 本文件走 `api`（baseURL `/api/v2`）rust session-pool 多 key 响应。
// 两套并存：detail 页补传仍走 sts.ts（python，零耦合），新建批量页
// 改走本文件（rust session pool，凭证共享）。

import { api } from '@/api/http';
import type {
  AllocateUploadSessionFilesIn,
  AllocateUploadSessionFilesOut,
  CompleteUploadSessionFileIn,
  CompleteUploadSessionFileOut,
  ConsumeUploadSessionFilesIn,
  ConsumeUploadSessionFilesOut,
  DiscardUploadSessionIn,
  DiscardUploadSessionOut,
  GetOrCreateUploadSessionIn,
  GetOrCreateUploadSessionOut,
  RemoveUploadSessionFilesIn,
  RemoveUploadSessionFilesOut,
  RenewUploadSessionCredentialsIn,
  RenewUploadSessionCredentialsOut,
} from '@/types/upload_session';

/**
 * 申请或获取当前 scope 的 upload session（pool 模式）。
 *
 * - 若当前 user/scope 已存在未过期的 session → 后端复用，返回旧 session；
 * - 若不存在或已过期 → 后端新签发，返回新 session；
 * - credentials / bucket / region / tmp_prefix 在顶层，files 在 init 时为 `[]`。
 *
 * 调用方拿到响应后应通过 `useUploadSession` 统一管理（定时 renew、文件
 * allocate / complete / remove 等）；不应在 composable 之外裸用本函数。
 *
 * 走 `api`（baseURL `/api/v2`），与其它业务端点共享拦截器。
 *
 * @example
 * ```ts
 * const session = await getOrCreateUploadSession({ scope: 'parts_new' })
 * // session.session_id / session.credentials / session.files
 * ```
 */
export async function getOrCreateUploadSession(
  payload: GetOrCreateUploadSessionIn,
): Promise<GetOrCreateUploadSessionOut> {
  const resp = await api.post<GetOrCreateUploadSessionOut>(
    '/upload-sessions/get-or-create',
    payload,
  );
  return resp.data;
}

/**
 * 批量申请 tmp_key（一次 allocate N 个 file，对应 caller 传入的 `files[]`）。
 *
 * 返回的 `items[i].client_ref` 与入参 `files[i].client_ref` 一一对应；
 * caller 用 client_ref 反查原始 File，再喂给 `useCosUpload` / `useCosUploader`。
 *
 * @example
 * ```ts
 * const allocated = await allocateUploadSessionFiles({
 *   scope: 'parts_new',
 *   session_id: '...',
 *   files: [
 *     { client_ref: 'a', kind: 'drawing', ... },
 *     { client_ref: 'b', kind: '3d_model', ... },
 *   ],
 * })
 * // allocated.items[0].tmp_key  →  cos.uploadFile({ Key })
 * ```
 */
export async function allocateUploadSessionFiles(
  sessionId: string,
  payload: AllocateUploadSessionFilesIn,
): Promise<AllocateUploadSessionFilesOut> {
  const resp = await api.post<AllocateUploadSessionFilesOut>(
    `/upload-sessions/${encodeURIComponent(sessionId)}/files:allocate`,
    payload,
  );
  return resp.data;
}

/**
 * 标记单个 file 上传完成（PUT 到 tmp 区成功后调）。
 *
 * - 后端将该 file 的 status 从 'pending' → 'done'，记录 etag + uploaded_at；
 * - 返回更新后的 SessionFile（含新 status），caller 不必自行维护状态机。
 *
 * @example
 * ```ts
 * await completeUploadSessionFile('session-id', 'client-ref', {
 *   scope: 'parts_new',
 *   etag: '"abc123"',
 * })
 * ```
 */
export async function completeUploadSessionFile(
  sessionId: string,
  clientRef: string,
  payload: CompleteUploadSessionFileIn,
): Promise<CompleteUploadSessionFileOut> {
  const resp = await api.post<CompleteUploadSessionFileOut>(
    `/upload-sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(clientRef)}/complete`,
    payload,
  );
  return resp.data;
}

/**
 * 批量移除 file（用户取消上传 / 解析后丢弃 / 上传失败后清理）。
 *
 * 已 status=done 的 file 不允许 remove（需先调 discard 整 session 才能回收）；
 * 后端返回实际被移除的 client_ref 列表（可能少于入参）。
 */
export async function removeUploadSessionFiles(
  sessionId: string,
  payload: RemoveUploadSessionFilesIn,
): Promise<RemoveUploadSessionFilesOut> {
  const resp = await api.post<RemoveUploadSessionFilesOut>(
    `/upload-sessions/${encodeURIComponent(sessionId)}/files:remove`,
    payload,
  );
  return resp.data;
}

/**
 * 续期 STS 凭证（到期前 5min 自动触发 / 凭证过期后手动触发）。
 *
 * 返回新的 credentials（不返回 tmp_prefix / bucket / region，caller 复用
 * 原 session 顶层字段；这与 backend-rust 响应契约一致）。
 */
export async function renewUploadSessionCredentials(
  sessionId: string,
  payload: RenewUploadSessionCredentialsIn,
): Promise<RenewUploadSessionCredentialsOut> {
  const resp = await api.post<RenewUploadSessionCredentialsOut>(
    `/upload-sessions/${encodeURIComponent(sessionId)}/renew`,
    payload,
  );
  return resp.data;
}

/**
 * 标记 file 为「已消费」—— 后端会延长对应 tmp 对象保留窗口，便于业务
 * 端点（batch create parts / confirm part file）在事务内 head + copy。
 *
 * 2026-09-18 注释修正：本端点仅延长保留窗口（business extension），tmp 物理
 * 删除由 batch_create_parts / confirm-part-file 等下游业务端点 spawn delete
 * 兜底（详见 backend-rust `src/handlers/parts/batch.rs`）。前端不感知 tmp
 * 删除；与 `removeFiles`（仅本地过滤 session.files）不同，consumeFiles 走
 * 后端协议，状态变化可观测。
 */
export async function consumeUploadSessionFiles(
  sessionId: string,
  payload: ConsumeUploadSessionFilesIn,
): Promise<ConsumeUploadSessionFilesOut> {
  const resp = await api.post<ConsumeUploadSessionFilesOut>(
    `/upload-sessions/${encodeURIComponent(sessionId)}/consume`,
    payload,
  );
  return resp.data;
}

/**
 * 销毁整个 session —— 后端清理所有未消费的 tmp 对象，session 状态置 closed。
 *
 * 通常在用户主动点「取消」/「重新开始」/切换 scope 时调；调后本 session
 * 不应再被任何 caller 使用（composable 内部应清理本地 state + 定时器）。
 */
export async function discardUploadSession(
  sessionId: string,
  payload: DiscardUploadSessionIn,
): Promise<DiscardUploadSessionOut> {
  const resp = await api.post<DiscardUploadSessionOut>(
    `/upload-sessions/${encodeURIComponent(sessionId)}/discard`,
    payload,
  );
  return resp.data;
}
