// utils/directUpload.ts —— 单文件直传引擎（2026-10-15 新增）
//
// 全仓六个上传场景（零件详情补传 / Tab2 PDF 批量 / Tab1 手工录入 / 装配件总装图 /
// CNC 配对 / 打印模板）都收敛到这一条四步链路：
//
//   1. computeSha256(file)              算 64 位小写 hex（秒传判据 + confirm 登记依据）
//   2. grantUploadIntents({...})        拿 object_key + 预签 PUT URL
//   3. xhrPut(url, file, onProgress)    XHR 直传，带真进度
//   4. confirmFileObject({...})         登记，返回 PartFileItem
//
// ## 秒传短路
//
// 第 2 步可能回 `already_exists: true`（后端按内容命中已有文件）。那一支**不发 PUT、
// 不发 confirm**，直接拿返回的 `existing_file` 收口 —— 「同一个零件补传同一张图」是
// 常见场景，少传一份几百 MB 的图纸是实打实的收益。
//
// ## URL 过期自动重签
//
// 预签 URL 到点即失效，而失效后本地无解 ⇒ 只能回后端换一枚新的。第 3 步撞 403 且
// 响应体是签名 / 过期问题时，**自动重签一次 + 重试一次**；仍失败向上抛，由各场景转
// error 态。**只重试一次**是有意的：重传一份 300MB 图纸的代价（几分钟 + 一份流量）
// 已经超过「让用户看一眼报错再点重试」，而无限重试会在 CORS 未配 / 桶被封这类**根本
// 不会自愈**的故障上变成流量黑洞。
//
// ## 归到这里的原因
//
// 六个场景的**状态机**各不相同（行内 cell / 弹窗列表 / 一条记录），但「一个文件怎么
// 传上去」逐字相同。传输收在共享层、状态留在各场景，就不会再出现「两套平行上传实现
// 只能靠对照两处才能发现漂移」那种结构。

import { computeSha256 } from '@/utils/fileHash';
import { parseFileExt } from '@/utils/fileExt';
import { normalizeUploadContentType } from '@/utils/fileContentType';
import { isPresignExpiredError, xhrPut } from '@/utils/presignedPut';
import { grantUploadIntents } from '@/api/files/intents';
import { confirmFileObject } from '@/api/files/objects';
import type { FileOwnerKind, PartFileItem, PartFileKind, UploadIntentItemOut } from '@/types/file_intent';

export interface DirectUploadOptions {
  ownerKind: FileOwnerKind;
  /** owner id 字符串（part.id / assembly.id / 一级客户 id）。 */
  ownerId: string;
  kind: PartFileKind;
  file: File;
  /** CNC 配对：confirm 时带上另一侧已登记的文件 id。 */
  pairWithFileId?: string;
  /**
   * 进度回调，回抛整个四步链路的 0-100 整数百分比：hash 阶段占 0-30，PUT 阶段占
   * 30-100，confirm 是纯 JSON 往返、不单独占区间（否则进度会在 99% 停一下才跳 100）。
   *
   * hash 阶段**不做**中间回抛：300MB 的 SHA-256 在本机约 1-2 秒，逐块回抛反而让
   * 进度条看起来在动，实际却几乎不涨 —— 直接从 0 跳到 30 更诚实。
   */
  onProgress?: (percent: number) => void;
}

/** 直传结果。秒传命中与实际 PUT 落盘收敛到同一形状，调用方不需要分支。 */
export interface DirectUploadResult {
  item: PartFileItem;
  /** true = 后端秒传命中（本次既没发 PUT 也没发 confirm）。 */
  alreadyExists: boolean;
}

/** 生成 client_ref：优先 crypto.randomUUID，回退到时间戳 + 随机串（非安全上下文）。 */
export function newClientRef(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** PUT 阶段进度（0-100）映射到整链路的 30-100 区间。 */
function mapPutProgress(percent: number): number {
  return 30 + Math.round(percent * 0.7);
}

/**
 * 直传一个文件并登记，返回后端 `PartFileItem`。
 *
 * 失败抛出的 Error 分两类：① 第 3 步抛 `PresignedPutError`（带 `status` / `body` /
 * `presignExpired` / `networkOrCors` 四个诊断字段，见 `utils/presignedPut.ts`）；
 * ② 第 2 / 4 步抛 axios 的 `ApiError`（带业务码 `code`）。调用方按需分流。
 */
export async function directUpload(opts: DirectUploadOptions): Promise<DirectUploadResult> {
  const { ownerKind, ownerId, kind, file, pairWithFileId, onProgress } = opts;

  // ---- 步骤 1：SHA-256（秒传判据 + confirm 登记依据，两处都要）----
  const sha = await computeSha256(file);
  const ext = parseFileExt(file.name);
  const declaredContentType = normalizeUploadContentType(file);
  const clientRef = newClientRef();
  onProgress?.(30);

  /**
   * 签发（或重签）一枚上传意图。`client_ref` 在两次调用间**必须复用** —— 它是响应项
   * 对齐回本地 File 的唯一稳定键。
   */
  const grantOnce = async (): Promise<UploadIntentItemOut> => {
    const resp = await grantUploadIntents({
      owner_kind: ownerKind,
      owner_id: ownerId,
      items: [
        {
          client_ref: clientRef,
          kind,
          original_filename: file.name,
          content_type: declaredContentType,
          // String()：后端 deserialize_i64 只收 JSON 字符串（见 types/file_intent.ts）。
          file_size: String(file.size),
          content_sha256: sha,
        },
      ],
    });
    const item = resp.items[0];
    if (!item) throw new Error('upload-intents 未返回对应项（响应异常）');
    return item;
  };

  /** 秒传命中 → 直接收口；响应缺 existing_file 视为异常（不容许静默当失败）。 */
  const takeInstant = (item: UploadIntentItemOut): DirectUploadResult => {
    if (!item.existing_file) {
      throw new Error('upload-intents 标记秒传命中但未返回 existing_file（响应异常）');
    }
    onProgress?.(100);
    return { item: item.existing_file, alreadyExists: true };
  };

  // ---- 步骤 2：签发预签 URL ----
  let intent = await grantOnce();
  if (intent.already_exists) return takeInstant(intent);
  if (!intent.upload_url || !intent.content_type || !intent.object_key) {
    throw new Error('upload-intents 返回的上传参数不完整（缺 upload_url / content_type）');
  }

  // ---- 步骤 3：XHR PUT 直传 ----
  const putOnce = async (item: UploadIntentItemOut): Promise<void> => {
    await xhrPut(
      {
        url: item.upload_url!,
        // ⚠️ 原样回填：这一行参与 SigV4 签名比对，改一个字就是 403。
        contentType: item.content_type!,
        expiresAt: Date.now() + item.expires_in * 1000,
      },
      file,
      (p) => onProgress?.(mapPutProgress(p)),
    );
  };

  try {
    await putOnce(intent);
  } catch (e) {
    // 只有「签名 / 过期」这一类 403 才重签：重签要重发一次 intent 并重传整个文件，
    // 代价与误判成正比。CORS 未配（同样 403、body 为空）重签多少次都不会好。
    if (!isPresignExpiredError(e)) throw e;
    console.warn('[directUpload] 预签 URL 失效，重新签发一次后重试：', (e as Error).message);
    const fresh = await grantOnce();
    if (fresh.already_exists) return takeInstant(fresh);
    if (!fresh.upload_url || !fresh.content_type) {
      throw new Error('重新签发的上传参数不完整（缺 upload_url / content_type）');
    }
    await putOnce(fresh);
    intent = fresh;
  }

  // ---- 步骤 4：confirm 登记 ----
  const confirmed = await confirmFileObject({
    owner_kind: ownerKind,
    owner_id: ownerId,
    kind,
    object_key: intent.object_key!,
    content_sha256: sha,
    original_filename: file.name,
    // String()：同上，后端 confirm 的 file_size 也只收字符串。
    file_size: String(file.size),
    // confirm 登记的 content_type 必须与 PUT 时实际发的一致，取重签后的那份。
    content_type: intent.content_type ?? declaredContentType,
    ext,
    ...(pairWithFileId ? { pair_with_file_id: pairWithFileId } : {}),
  });
  onProgress?.(100);
  return { item: confirmed, alreadyExists: false };
}
