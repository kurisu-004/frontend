// types/file_intent.ts —— 直传 COS 的文件上传意图契约（2026-10-15 新增）
//
// 本文件承载「预签 PUT 直传」这套链路的全部 wire 类型：
//
//   1. POST /api/v2/files/objects/upload-intents —— 批量申请预签 URL（+ 可能秒传短路）
//   2. XHR PUT 直传 COS                          —— 不经后端进程，带真进度
//   3. POST /api/v2/files/objects/confirm        —— 登记（object_key + sha + 文件元数据）
//
// 为什么 `PartFileKind` / `FileOwnerKind` / `PartFileItem` 不在这里重复声明：
// 它们是**文件对象域**的既有类型（`src/types/part_file.ts`），upload-intents 只是
// 引用它们做 kind / owner 维度，另起一份必然与域内声明漂移 ⇒ 从 part_file.ts import。
//
// 为什么 `ConfirmFileIn` 从 part_file.ts 搬到这里：它现在只属于「直传链路」这一个
// 用途（multipart 代理上传已下线，`tmp_key` 这个字段已经不存在），跟着 upload-intents
// 的类型住在同一个文件里，读代码时不必跨文件找「谁定义了 confirm 的入参」。
//
// `object_key` 与旧 `tmp_key` 的差别（不要写回 tmp_key）：旧链路先传到 tmp 区、再由
// 后端 copy 到正式 CAS key；新链路后端**直接签发正式 object_key**，PUT 落点就是最终
// 位置，confirm 只做「head 校验 + 插业务行」。

import type { FileOwnerKind, PartFileItem, PartFileKind } from '@/types/part_file';

/**
 * 直传链路的调用方大多要同时用到这三样（拼 intent 入参 + 收 confirm 出参），在这里
 * **转出**一份省得每个文件都写两行 import。声明只有 `part_file.ts` 一处 —— 本文件
 * 不重复定义任何字段。
 */
export type { FileOwnerKind, PartFileItem, PartFileKind };

/**
 * `POST /api/v2/files/objects/upload-intents` 单项入参。
 *
 * - `client_ref`：调用方生成的稳定标识（`crypto.randomUUID()`），用来把响应项对齐回
 *   本地 File —— **重签 URL 时必须复用同一个 client_ref**，否则上层拿不到对应项；
 * - `content_type`：**会被签进 SigV4 的 SignedHeaders** ⇒ 声明什么，PUT 时就必须
 *   原样带什么，改一个字就是 403 SignatureDoesNotMatch；
 * - `content_sha256`：64 位小写 hex，由前端 `computeSha256` 算。它同时是秒传判据
 *   （后端按内容命中已有文件）与 confirm 的登记依据。
 */
export interface UploadIntentItemIn {
  client_ref: string;
  kind: PartFileKind;
  original_filename: string;
  content_type: string;
  /**
   * 字节数，**必须发 JSON 字符串**。
   *
   * 后端 `UploadIntentItemIn.file_size` 与 `ConfirmFileIn.file_size` 都挂了
   * `#[serde(deserialize_with = "deserialize_i64")]`，而那个反序列化器的实现是
   * `String::deserialize(d)?.parse::<i64>()` —— **只接受字符串**，裸 number 会在 axum
   * 的 `Json` 提取器层就 422，返的还是**纯文本**而非 `R<T>` 信封（前端拿不到业务码）。
   *
   * ⚠️ **入参这条例外与出参那条例外是两件不同的事，别互相推导**（2026-10-15 订正）：
   *   - 入参（这里）：`deserialize_i64` 只认字符串 ⇒ **发** number 会 422。
   *   - 出参（`types/part_file.ts::PartFileItem.file_size`）：后端 `PartFileOut.file_size`
   *     是 `i64` + `#[serde(serialize_with = "serialize_i64")]`（序列化器实现就是
   *     `serialize_str(&v.to_string())`）⇒ 序列化成**字符串**，前端声明的 `string` 是对的，
   *     **不要**改成 number —— 会把零件详情 / 装配件 / CNC 三页的文件大小显示与
   *     `formatBytes` 全部打歪。
   * 换句话说：入参的 string 是「反序列化器的单向要求」，出参的 string 是「序列化器的
   * 精度保护」，两者碰巧都是 string，但没有任何因果关系。
   */
  file_size: string;
  content_sha256: string;
}

/**
 * `POST /api/v2/files/objects/upload-intents` 请求 body。
 *
 * `owner_kind` / `owner_id` 在 body 上而不是 URL 上 —— 端点对零件（PART）、装配件
 * （ASSEMBLY）、客户（CUSTOMER，打印模板）一视同仁，故只收一个 payload 对象。
 */
export interface GrantUploadIntentsIn {
  owner_kind: FileOwnerKind;
  owner_id: string;
  /** 批量 1..=200 项；响应 `items[]` 与它按下标一一对应。 */
  items: UploadIntentItemIn[];
}

/**
 * `POST /api/v2/files/objects/upload-intents` 单项出参。
 *
 * 两个互斥形态，判据是 `already_exists`：
 * - `already_exists === true`（秒传命中）：只有 `client_ref` / `already_exists` /
 *   `expires_in` / `existing_file` 有意义，其余字段缺省 —— 前端**不发 PUT、不发
 *   confirm**，直接拿 `existing_file` 收口；
 * - `already_exists === false`：`object_key` / `upload_url` / `content_type` 必有值，
 *   走「PUT → confirm」。
 */
export interface UploadIntentItemOut {
  client_ref: string;
  already_exists: boolean;
  /** COS 桶内的目标 key（正式位置，不是 tmp 区）。`already_exists=false` 时必有。 */
  object_key?: string;
  /** 预签 PUT URL（带 SigV4 query）。`already_exists=false` 时必有。 */
  upload_url?: string;
  /**
   * PUT 时必须原样带上的 Content-Type。`already_exists=false` 时必有。
   * 它签在 SigV4 的 SignedHeaders 里，**不能**由前端改写。
   */
  content_type?: string;
  /** 预签 URL 剩余有效秒数（到期后必须重新调 upload-intents 换 URL）。 */
  expires_in: number;
  /** `already_exists=true` 时返回的已有文件项（全字段）。 */
  existing_file?: PartFileItem;
}

/** `POST /api/v2/files/objects/upload-intents` 响应 data。 */
export interface GrantUploadIntentsOut {
  items: UploadIntentItemOut[];
}

/**
 * `POST /api/v2/files/objects/confirm` 入参。
 *
 * 用途：PUT 落盘后登记一行 `t_part_file`（后端 head 校验 object_key 的存在与大小）。
 *
 * - `object_key`：来自 upload-intents 响应，**不得**自行拼接；
 * - `pair_with_file_id`：CNC 配对用（G_CODE 先 confirm 拿到 id，SETUP_SHEET 再 confirm
 *   时带上它）。普通补传不传该键；
 * - `ext`：文件扩展名（小写字母数字），后端据此派生路径并做类型校验。
 */
export interface ConfirmFileIn {
  owner_kind: FileOwnerKind;
  owner_id: string;
  kind: PartFileKind;
  object_key: string;
  content_sha256: string;
  original_filename: string;
  /** 字节数，**必须发 JSON 字符串**（理由同 `UploadIntentItemIn.file_size`：后端
   *  `ConfirmFileIn.file_size` 也挂 `deserialize_i64`，裸 number 会在提取器层 422）。 */
  file_size: string;
  content_type: string;
  /** 文件扩展名（小写字母数字 1-7 字符）；`utils/fileExt.parseFileExt` 解析。 */
  ext?: string;
  /** CNC 配对：与哪一行文件互为配对（G_CODE ↔ SETUP_SHEET）。 */
  pair_with_file_id?: string;
}
