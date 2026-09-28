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
// - 因此 caller 拿到本响应后需**自行组装** `CosUploadGrant.items[]` 数组形态
//   喂给 `useCosUploader` / `useCosUpload`；具体适配逻辑在 3 处 composable
//   （usePartFileUpload / usePartBatchPdf / usePartBatchManual）内完成。
//
// 2026-09-28 重命名：CosUploadSession → CosUploadGrant（语义澄清，组件包与后端
// Redis session 解耦）。
//
// 错误码：python STS 端口当前未实现业务错误码（仅 21502 / 通用 40001 等）；
// 实际联调首日如发现专用 code，caller 端按 ApiError.code 兜底（详见
// useProcessChainRequiredHandler 模式）。

import { apiPrint } from '@/api/http';
import type {
  BatchGrantStsKeyIn,
  BatchGrantStsTmpKeyOut,
  StsTmpKeysRequest,
  StsTmpKeysResponse,
} from '@/types/sts';

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

/**
 * 批量申请 N 个 STS 临时凭证 + tmp_key（2026-09-28 子任务 #5 启用）。
 *
 * 把 N 个文件的入参一次性塞进 `files[]`，python 后端按 (purpose, filename,
 * content_sha256) 派生唯一 tmp_key 单次签名批；返回的 `items[i].tmp_key`
 * 与请求 `files[i]` 一一对应（下标对齐）。相比 N 次并发调 `grantStsTmpKey`：
 *
 * - 单 HTTP（减少后端签名协调成本）；
 * - 共享同一 STS 凭证（python 端按 scope 复用同一 STS session）；
 * - 不再与 backend-rust upload_session 域耦合，无 24h 滑动 TTL / 自动 renew
 *   等长连接设施（详见 plan §3.3 caller 改造）。
 *
 * 仅入参形态与 `grantStsTmpKey` 不同（`files[]` 数组 vs 单文件对象）；底层端点
 * 仍是 `POST /api/v1/files/sts-tmp-keys`，由 pydantic validator 区分单 / 批
 * 入参。走 `apiPrint`（baseURL `/api/v1`）的原因同 `grantStsTmpKey`。
 *
 * caller 拿到响应后通常这样组装：
 * ```ts
 * const grants = await grantStsTmpKeyFiles({
 *   scope: 'parts_new',
 *   files: files.map(f => ({
 *     purpose: 'drawing',
 *     filename: f.name,
 *     content_type: f.type || 'application/octet-stream',
 *   })),
 * });
 * // 桶 / region / credentials 共享：从 items[0] 取
 * const head = grants.items[0]!;
 * const grant: CosUploadGrant = {
 *   credentials: toCosCredentials(head.credentials),
 *   bucket: head.bucket,
 *   region: head.region,
 *   items: grants.items.map((it, i) => ({ client_ref: clientRefs[i]!, tmp_key: it.tmp_key })),
 * };
 * ```
 */
export async function grantStsTmpKeyFiles(
  payload: BatchGrantStsKeyIn,
): Promise<BatchGrantStsTmpKeyOut> {
  const resp = await apiPrint.post<BatchGrantStsTmpKeyOut>('/files/sts-tmp-keys', payload);
  return resp.data;
}
