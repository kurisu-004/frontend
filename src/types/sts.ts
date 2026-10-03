// types/sts.ts
//
// 2026-09-17 新增：python STS 端口契约类型（与 backend-python/schema/sts.py 对齐）。
//
// 范围：
// - `POST /api/v2/files/sts-tmp-keys` 的请求 / 响应 shape；
// - 复用 src/types/cos_upload.ts 的 `CosCredentials` 不可能（python 端多了
//   `start_time` 字段 + purpose 枚举 + 单端口 1-key response 形态），但**不污染**
//   cos_upload.ts 的通用契约（它仍然承载 CosCredentials / CosUploadGrant 等
//   领域无关的最小骨架，caller 在适配层做字段挑选）。
//   2026-09-28 迁移：cos_upload.ts → components/CosUploader/types.ts；
//   CosUploadSession → CosUploadGrant（2026-09-28 重命名）。
//
// 为什么单独建文件：
// - 2026-09-17 STS 端口迁移：原 backend-rust `POST /api/v2/part-files/upload-intents`
//   是 part-file 域专用（带 dedup_hit / existing_file），本次切到 python
//   `POST /api/v2/files/sts-tmp-keys` 后**单端口 1-key 响应 + 7 个 purpose 枚举**
//   与 part-file 域解耦，新业务域（外协 / 品检 / 扫码台）也能复用；
// - 类型与 cos_upload.ts 的 `CosCredentials` 重名但字段多 1 个（start_time），
//   不合并是避免对通用组件加领域字段。
//
// 字段约束（与 backend-python/schema/sts.py / backend-rust handler 严格对齐）：
// - purpose 是有限枚举，便于 policy 跟踪 / 日志分类；
// - filename 必填且 1..255；
// - content_sha256 **必填**，完整 64 hex（不再截前 16 hex）；
// - ext **必填**，小写字母数字 1-7 字符（由 utils/fileExt.parseFileExt 解析）；
// - expire_seconds 默认 1800、上限 43200（12 小时）。
//
// 2026-09-29 升级：rust handler 把 content_sha256 收紧为 required 64 hex + 新增
// ext required 字段；前端必须在调 grantStsTmpKey* 之前算完整 SHA-256 + 解析 ext。
// 本文件仅承载类型契约，caller 改造见 composables/usePartFileUpload.ts、
// views/parts/new/composables/{usePartBatchManual,usePartBatchPdf}.ts。

/** STS 用途枚举（python `Purpose` Literal 一一对应）。
 *  2026-09-17：与 backend-python/schema/sts.py:20-28 严格对齐，新增 / 删减 / 重命名
 *  必须同步 backend schema。 */
export type StsPurpose =
  'drawing' | '3d_model' | 'cad_2d' | 'g_code' | 'setup_sheet' | 'assembly_master' | 'tmp';

/** `POST /api/v2/files/sts-tmp-keys` 请求 body。
 *  2026-09-17：purpose 是必填枚举；content_sha256 / content_type / expire_seconds
 *  均为可选（python schema 给 default）。
 *  2026-09-29：rust handler 收紧 → content_sha256 必填完整 64 hex（不再截前 16），
 *  ext 必填（小写字母数字 1-7 字符）；content_type / expire_seconds 仍可选。 */
export interface StsTmpKeysRequest {
  purpose: StsPurpose;
  filename: string;
  content_type?: string;
  /** 缺省 1800；范围 [60, 43200]。 */
  expire_seconds?: number;
  /** 2026-09-29 必填：完整 64-char 小写 hex（前端 computeSha256 直传，禁止截断）。
   *  与 backend-rust StsTmpKeysRequest.content_sha256 严格对齐（required）。 */
  content_sha256: string;
  /** 2026-09-29 必填：文件扩展名小写字母数字 1-7 字符。
   *  caller 用 utils/fileExt.parseFileExt 解析后传入；解析失败抛 Error。
   *  与 backend-rust StsTmpKeysRequest.ext 严格对齐（required, lowercase, 1-7）。 */
  ext: string;
}

/** python 端返回的 STS 凭证（StsCredentialsOut）。
 *  比通用 CosCredentials 多 `start_time`（UTC 秒，i64 雪花序列化）—— STS 凭证
 *  生效时间，用于审计 / 提前过期检测。前端不直接消费，但保型对齐后端契约。 */
export interface StsCredentialsOut {
  tmp_secret_id: string;
  tmp_secret_key: string;
  session_token: string;
  /** UTC 秒，i64 雪花序列化，JSON 解析为 number。 */
  start_time: number;
  /** UTC 秒，i64 雪花序列化，JSON 解析为 number。 */
  expired_time: number;
}

/** `POST /api/v2/files/sts-tmp-keys` 完整响应（StsTmpKeysResponse）。
 *
 *  注意：**单端口只签发 1 个 tmp_key**（与原 backend-rust bulk
 *  `/part-files/upload-intents` 一次签 N 个 key 完全不同）；caller 若要批量
 *  上传，需并发调 N 次本端点，再把 N 个 response 拼成 `CosUploadGrant`
 *  喂给 `useCosUploader` / `useCosUpload`。
 *  2026-09-28 迁移：CosUploadSession → CosUploadGrant。
 *
 *  字段含义：
 *  - `tmp_key`：COS tmp 区 key（前端直传时填 `cos.uploadFile({ Key })`）；
 *  - `bucket` / `region`：COS 桶标识 + 地域；
 *  - `endpoint` / `scheme`：完整请求地址（caller 可直接拼 / SDK 内部用）；
 *  - `credentials`：STS 凭证四元组 + start_time；
 *  - `expires_in`：本次签发的剩余秒数（与 credentials.expired_time 一致，更易读）；
 *  - `upload_prefix`：STS policy resource 限定的前缀（展示用；实际 key 已自含）。
 */
export interface StsTmpKeysResponse {
  tmp_key: string;
  bucket: string;
  region: string;
  endpoint: string;
  scheme: string;
  credentials: StsCredentialsOut;
  expires_in: number;
  upload_prefix: string;
}

/**
 * 2026-09-28 新增：`POST /api/v2/files/sts-tmp-keys` 批量入参契约。
 *
 * 上游把 N 个文件一次性塞进 `files[]`，python 端按 (purpose, filename,
 * content_sha256) 派生唯一 tmp_key 单次签名批；返回的 `items[i].tmp_key`
 * 与 `files[i]` 一一对应（下标对齐）。
 *
 * 由子任务 #5 启用（caller：usePartBatchManual / usePartBatchPdf 双 caller
 * 全部走 grantStsTmpKeyFiles，单 HTTP + 单签名批，不再每文件 1-key）。
 */
export interface BatchGrantStsKeyIn {
  scope: string;
  files: StsTmpKeysRequest[];
}

/**
 * 2026-09-28 新增：批量 STS 响应契约。
 *
 * 与单文件 `StsTmpKeysResponse` 的差异：去掉桶 / region / credentials 等
 * 单端口共享字段——caller 从 items 中任一项取桶 / region / credentials
 * 即可（python 端 batch 签发同 scope 共享同一 STS 凭证）。
 */
export interface BatchGrantStsTmpKeyOut {
  items: StsTmpKeysResponse[];
}

/** PartFileKind → StsPurpose 映射（caller 调用点处理）。
 *  2026-09-17：6 个 part-file 域 kind 全部对齐到 python purpose 枚举；
 *  若以后 part-file 域加新 kind 而 python 端未同步，需在此处加兜底分支。
 *  G_CODE / SETUP_SHEET / ASSEMBLY_MASTER 当前不在 usePartFileUpload 路径上
 *  （仅 PDF Tab / 手工录入 Tab 用），但 mapping 全量给出，便于 caller 复用。 */
export const PartFileKindToStsPurpose: Record<string, StsPurpose> = {
  DRAWING: 'drawing',
  '3D_MODEL': '3d_model',
  CAD_2D: 'cad_2d',
  G_CODE: 'g_code',
  SETUP_SHEET: 'setup_sheet',
  ASSEMBLY_MASTER: 'assembly_master',
};
