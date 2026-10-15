// types.ts —— CosUploader 通用契约（2026-10-15 改为预签 URL 直传）
//
// 本文件是组件包的类型契约：组件零业务字段，`kind` / `owner` 这些维度全部由调用方
// 在实现 `getUploadIntents` 时闭包持有 —— 组件只认「给一批 File，拿回一批可上传项」。
//
// 2026-10-15 的口径变化：从「STS 临时凭证 + tmp_key」改为「预签 PUT URL + object_key」。
// 组件**不再**感知任何凭证（`credentials` / `bucket` / `region` 三个字段与
// `CosUploadGrant` 整型一起消失），也不再感知 `tmp_key`：签发端点直接给的是最终
// 落点的 `object_key` + 一枚 `upload_url`。传输由 `utils/presignedPut.ts::xhrPut`
// 完成，不经 cos-js-sdk-v5。

import type { PartFileItem, UploadIntentItemOut } from '@/types/file_intent';

/**
 * 「给一批 File → 拿回一批可上传项」的回调。
 *
 * 实现方（业务侧）负责：算 SHA-256、拼 kind / owner / content_type、调
 * `api/files/intents.ts::grantUploadIntents`，然后把响应的 `items[]` 原样返回。
 * 组件按下标把 `files[i]` 与 `items[i]` 对齐（后端保证响应与请求 items 同序）。
 *
 * 组件**保持注入**而不是自己 import grantUploadIntents，理由与本仓其它组件一致：
 * 组件与业务解耦、可单测（注入一个假函数即可覆盖整条状态机）。
 */
export type GetUploadIntents = (files: File[]) => Promise<UploadIntentItemOut[]>;

/** 上传完成后的对外输出（`uploaded` / `allDone` 事件的 payload）。 */
export interface CosUploadedItem {
  /** 与 intent 一一对应的稳定标识（签发时由调用方生成）。 */
  client_ref: string;
  /** 直传成功后落到的正式对象 key；秒传命中时为空（那一支没有新的对象）。 */
  object_key?: string;
  /** 秒传命中时后端返回的已有文件项；直传路径为空。 */
  existing_file?: PartFileItem;
  /** 本地原始 File（调用方偶尔要用它的 size / name）。 */
  file: File;
  /** 本次算出的 SHA-256（hex）；调用方写日志 / 去重用。 */
  sha256: string;
  /** true = 秒传命中（后端按内容命中已有文件，本次既没发 PUT 也没发 confirm）。 */
  already_exists: boolean;
  /**
   * 登记后的文件项。**只有在调用方注入了 confirm 且它返回 PartFileItem 时才有值** ——
   * 组件自己不做登记（它不知道 kind / owner），拿不到后端返回的文件行。
   * 秒传命中时不需要登记，`existing_file` 就是答案。
   */
  file_item?: PartFileItem;
}

/** 组件内部 item（运行时状态机）。 */
export type CosUploaderStatus = 'pending' | 'hashing' | 'uploading' | 'done' | 'error';

export interface CosUploaderItem {
  client_ref: string;
  file: File;
  /** 签发端点给的正式对象 key；秒传命中时为空。 */
  object_key?: string;
  /** 预签 PUT URL；秒传命中时为空。 */
  upload_url?: string;
  /** PUT 时必须原样回填的 Content-Type；秒传命中时为空。 */
  content_type?: string;
  /** true = 秒传命中，直接以 `existing_file` 落 done 态，不发 PUT / confirm。 */
  already_exists: boolean;
  /** 秒传命中时后端返回的已有文件项。 */
  existing_file?: PartFileItem;
  status: CosUploaderStatus;
  progress: number;
  /** SHA-256 hex；hash 阶段完成后写入。 */
  sha256?: string;
  error?: string;
}
