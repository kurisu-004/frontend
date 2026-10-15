// api/files/intents.ts —— 上传意图签发端口（`POST /api/v2/files/upload-intents`）
//
// 2026-10-15 新增：直传链路的第一个 HTTP 端点，也是整条链路的**唯一**「拿上传授权」
// 入口 —— 浏览器拿到的不是 STS 临时凭证，而是一枚**预签 PUT URL**。
//
// 直传链路与被替代的临时凭证链路的差别（决定了本文件为什么只有这一个函数）：
// - 旧链路：后端签发 STS 四元组（secret_id / secret_key / session_token）+ tmp_key，
//   前端拿 `cos-js-sdk-v5` 自己去 COS 换正式签名；凭证 30 分钟过期，重签要重发一批
//   intent，且 SDK 约 175KB 懒加载进页面闭包。
// - 新链路：后端**直接把 SigV4 签名编进 URL 的 query**（含 `X-Amz-Expires`），
//   浏览器用 XHR PUT 打这个 URL 即可，签名与 Content-Type 一并绑死。整个过程不碰
//   任何临时凭证、也不需要 SDK。
//
// ⚠️ **URL 到点即失效，且失效后没有任何本地补救**：必须重新调本端点换一枚新 URL。
// 上层（`utils/presignedPut.ts` + `components/CosUploader/useCosUploader.ts`）据此
// 在 403 时自动重签**一次**再重试一次，不做无限重试。
//
// 秒传短路：`items[i].already_exists === true` 表示后端按内容命中了已有文件项，
// 此时不发 PUT、不发 confirm，直接用返回的 `existing_file` 收口。

import { api } from '@/api/http';
import type { GrantUploadIntentsIn, GrantUploadIntentsOut } from '@/types/file_intent';

/**
 * 申请一批上传意图（`POST /api/v2/files/upload-intents`）。
 *
 * 批量上限 200 项；响应 `items[i]` 与请求 `items[i]` **按下标一一对应**，同时响应项
 * 也带回 `client_ref` —— 上层优先按 `client_ref` 匹配（它比下标稳：中途重签一批时
 * 下标会漂，client_ref 不会）。
 *
 * @example
 * ```ts
 * const { items } = await grantUploadIntents({
 *   owner_kind: 'PART',
 *   owner_id: partId,
 *   items: [
 *     {
 *       client_ref: crypto.randomUUID(),
 *       kind: 'DRAWING',
 *       original_filename: file.name,
 *       content_type: 'application/pdf',
 *       file_size: file.size,
 *       content_sha256: sha,
 *     },
 *   ],
 * });
 * // items[0].already_exists ? 直接用 existing_file : xhrPut(items[0]) 再 confirm
 * ```
 */
export async function grantUploadIntents(
  payload: GrantUploadIntentsIn,
): Promise<GrantUploadIntentsOut> {
  const resp = await api.post<GrantUploadIntentsOut>('/files/upload-intents', payload);
  return resp.data;
}
