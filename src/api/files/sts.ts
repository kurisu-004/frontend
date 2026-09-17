// api/files/sts.ts
//
// 2026-09-17 新增：python STS 端口 caller。
//
// `POST /api/v1/files/sts-tmp-keys` —— 前端直传 COS 临时凭证签发端口（替换原
// backend-rust `POST /api/v2/part-files/upload-intents`，2026-09-17 起 part-file
// 域 3 处上传入口统一切到这里）。
//
// 走 `apiPrint`（baseURL `/api/v1`）的原因：
// - python STS 端口物理在 v1，与 `apiPrint` 已有的 4 个打印端点（共享同一组
//   axios 拦截器 + refreshPromise 模块单例）路径对齐；
// - 不新建独立 axios 实例，避免重复挂拦截器 / 分散 refresh 雪崩队列。
//
// 单端口 1-key 响应 vs 原 backend-rust bulk：
// - python STS 一次只签发 1 个 tmp_key（与 file size / hash / filename / purpose
//   强绑定，policy resource 也按 1 个 key 写）；
// - 原 rust `createUploadIntents` 一次签 N 个 key + bulk dedup；
// - 因此 caller 拿到本响应后需**自行组装** `CosUploadSession.items[]` 数组形态
//   喂给 `useCosUploader` / `useCosUpload`；具体适配逻辑在 3 处 composable
//   （usePartFileUpload / usePartBatchPdf / usePartBatchManual）内完成。
//
// 错误码：python STS 端口当前未实现业务错误码（仅 21502 / 通用 40001 等）；
// 实际联调首日如发现专用 code，caller 端按 ApiError.code 兜底（详见
// useProcessChainRequiredHandler 模式）。

import { apiPrint } from '@/api/http';
import type { StsTmpKeysRequest, StsTmpKeysResponse } from '@/types/sts';

/**
 * 申请 1 个 STS 临时凭证 + tmp_key。
 *
 * 调用方传入 purpose / filename / content_sha256，python 后端按 (purpose,
 * filename, content_sha256) 派生唯一 tmp_key，返回 STS 凭证四元组 + COS 桶
 * / region。前端拿到响应后用 `cos-js-sdk-v5` 直传 COS tmp 区，后续业务端点
 *（`confirmPartFile` / `batchCreateParts`）再携带 `tmp_key` 让后端 head + copy
 * tmp → 正式 CAS key + 落业务表。
 *
 * 走 `apiPrint`（baseURL `/api/v1`），与打印 4 端点共享拦截器与 refreshPromise。
 * 端点路径 `/files/sts-tmp-keys`，不带 `/v1` 前缀（baseURL 已自带）。
 *
 * @example
 * ```ts
 * const resp = await grantStsTmpKey({
 *   purpose: 'drawing',
 *   filename: 'a.pdf',
 *   content_sha256: 'a'.repeat(16),
 *   content_type: 'application/pdf',
 * });
 * // resp.tmp_key / resp.credentials / resp.bucket / resp.region 喂给 cos.uploadFile
 * ```
 */
export async function grantStsTmpKey(payload: StsTmpKeysRequest): Promise<StsTmpKeysResponse> {
  const resp = await apiPrint.post<StsTmpKeysResponse>('/files/sts-tmp-keys', payload);
  return resp.data;
}
