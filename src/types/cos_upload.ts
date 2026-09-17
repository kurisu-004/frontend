// types/cos_upload.ts
//
// 2026-09-17 新增：领域无关的 COS 上传组件对外契约类型。
//
// 本文件定义通用 COS 上传组件（cos-uploader）所有对外暴露的 TypeScript 类型。
// "领域无关" 意味着：
//   - 不 import 任何 part_file / api/parts / delivery-* 等域特定模块；
//   - 不绑定 PartFileKind / PartFileItem / UploadIntentsIn / ConfirmFileIn 等
//     part-file 域结构；
//   - 只描述"前端 → 后端 STS 直传 COS"这一通用流程的入参 / 出参 / 内部状态。
//
// 与 src/types/part_file.ts 中同名词的差异：
//   - `CosCredentials`（part_file.ts）与本文件的 `CosCredentials`：字段完全一致
//     （tmp_secret_id / tmp_secret_key / session_token / expired_time），因后端
//     STS 端点（无论 part-file 还是未来其它域）返回结构统一；本文件重复声明
//     是为了避免通用组件反向依赖 part-file 域类型。
//   - `UploadIntentsIn / UploadIntentsOut`（part_file.ts）vs 本文件的
//     `CosUploadSession`：part_file.ts 的版本把 `kind` / `filename` / `file_size`
//     / `content_sha256` 等 part-file 域字段绑死在 item 上；本文件的版本只固定
//     `client_ref` / `tmp_key` 两个最小必须字段，caller 自定 item 内其余字段名。
//   - 通用组件只关心三件事：(1) 拿到 STS 凭证，(2) 用 tmp_key 上传，
//     (3) 上传后回吐 client_ref + tmp_key 给 confirm 回调；具体 confirm body
//     的字段组合由 caller 决定（part-file 域用 ConfirmFileIn，未来其它域可自由扩展）。
//
// 使用方：
//   - src/components/cos-uploader/* 内部消费；
//   - src/views/parts/components/parts-form 等业务页面在调用前把领域字段塞进
//     `CosUploadSession.items[i]` 的扩展字段（通过泛型 / 断言），组件不感知。

/** STS 临时凭证（与 cos-js-sdk-v5 的 stsOpts 字段对齐，UTC 秒数足够） */
export interface CosCredentials {
  tmp_secret_id: string;
  tmp_secret_key: string;
  session_token: string;
  /** UTC 秒（i64，后端 i64 序列化，JSON 解析为 number） */
  expired_time: number;
}

/** requestUpload 回调返回的统一形状（caller 自定 items 内字段名，仅固定 client_ref / tmp_key） */
export interface CosUploadSession {
  credentials: CosCredentials;
  bucket: string;
  region: string;
  items: Array<{ client_ref: string; tmp_key: string }>;
}

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
