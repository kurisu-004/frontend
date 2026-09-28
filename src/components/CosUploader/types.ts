// types.ts —— CosUploader 通用契约（2026-09-28 迁移到 src/components/CosUploader/）
//
// 2026-09-28 迁移：本文件原在 src/types/cos_upload.ts，迁移到组件包内。
// 迁移原因：通用类型与组件包强绑定（仅 CosUploader 消费），不再跨域共享，
// 按 CLAUDE.md「composable 归属判别」收紧到组件包内。
//
// 命名变更（2026-09-28）：
// - 原 `CosUploadSession` → `CosUploadGrant`：澄清「纯前端数据形状，与后端 Redis
//   session 无关」的语义。caller 通过 getUploadGrant 拿到的只是一次性上传授权包，
//   组件本身完全不感知 Redis / session 生命周期。
// - 原匿名 items 元素类型 → `CosUploadGrantItem`：从 inline 提取命名后方便 caller
//   在适配层引用。
// - 原 `requestUpload` 回调 → `getUploadGrant`：更准确的动词（get 一次性的 grant）。
//
// 与 src/types/part_file.ts 中同名词差异（保持原注释思路）：
// - CosCredentials：字段一致
// - UploadIntentsIn / Out（part_file.ts）vs CosUploadGrant（本文件）：part_file 域
//   把 kind / filename / file_size / content_sha256 等绑死在 item 上；本文件只固定
//   client_ref / tmp_key 两个最小必须字段，caller 自定 item 内其余字段名。

/** STS 临时凭证（与 cos-js-sdk-v5 的 stsOpts 字段对齐，UTC 秒数足够） */
export interface CosCredentials {
  tmp_secret_id: string;
  tmp_secret_key: string;
  session_token: string;
  /** UTC 秒（i64，后端 i64 序列化，JSON 解析为 number） */
  expired_time: number;
}

/** CosUploadGrant.items 的元素类型（client_ref + tmp_key 一一对应 files）。 */
export interface CosUploadGrantItem {
  client_ref: string;
  /** COS bucket 内的目标 key（含目录前缀）。 */
  tmp_key: string;
}

/**
 * getUploadGrant 回调返回的一次性上传授权包。
 *
 * 纯前端数据形状，与后端 rust 的 Redis upload-session 概念无关 —— 后端的
 * session 池只是「实现 caller 的一种选项」（如 parts/new 的 useUploadSession），
 * 组件本身不感知也不依赖。
 *
 * bucket / region / items[].tmp_key 由 caller 在返回值中指定，等价于「指定桶和
 * 目录」的能力。caller 想用什么 bucket 就用什么 bucket，想把文件写到什么 key
 * 前缀就写什么前缀（受限于后端 STS policy）。
 */
export interface CosUploadGrant {
  credentials: CosCredentials;
  bucket: string;
  region: string;
  items: CosUploadGrantItem[];
}

/** getUploadGrant 回调签名：caller 实现「拿 File 列表 → 申请 STS → 拼 CosUploadGrant」。 */
export type GetUploadGrant = (files: File[]) => Promise<CosUploadGrant>;

/** 上传完成后的对外输出（confirm 回调的入参 / uploaded 事件的 payload） */
export interface CosUploadedItem {
  client_ref: string;
  tmp_key: string;
  etag?: string;
  file: File;
  sha256?: string;
}

/** 组件内部 item（运行时状态机） */
export type CosUploaderStatus = 'pending' | 'hashing' | 'uploading' | 'done' | 'error';
export interface CosUploaderItem extends CosUploadedItem {
  status: CosUploaderStatus;
  progress: number;
  error?: string;
}