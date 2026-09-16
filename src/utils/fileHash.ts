// 2026-09-16 新增：前端文件 SHA-256 流式哈希工具。
//
// 背景：M3 前端直传 COS 改造要求"先 hash 再传"，与 cos-js-sdk-v5 的 STS 临时
// 凭证 + content_sha256 后端校验配套。FileReader 一次性 readAsArrayBuffer 对
// 300MB 大文件会触发浏览器 OOM；hash-wasm 提供 createSHA256() 流式 API（init /
// update / digest），支持 8MB 分块增量更新，恒定内存。
//
// 用法：
// ```ts
// const sha = await computeSha256(file, ({ bytesHashed, totalBytes }) => {
//   console.log(`hashed ${bytesHashed}/${totalBytes}`);
// });
// ```
// 返回的 hex 为小写 64 字符，与后端 UploadIntentItemIn.content_sha256 字段对齐。

import { createSHA256 } from 'hash-wasm';

/** 进度回调 payload（bytesHashed 是已 hash 字节数；totalBytes 是文件总大小）。 */
export interface HashProgress {
  bytesHashed: number;
  totalBytes: number;
}

/** 分块大小：8MB，平衡 throughput / 内存 / onProgress 频率。 */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * 流式计算 File 的 SHA-256 哈希（小写 hex，64 字符）。
 *
 * 2026-09-16：基于 hash-wasm@4.12 createSHA256() 流式 API。
 * - `hasher.init()` 重置内部状态；
 * - `hasher.update(chunk)` 增量喂数据；
 * - `hasher.digest('hex')` 输出 64-char 小写 hex（与后端 serde 默认行为对齐）。
 *
 * 异常：hash-wasm 初始化失败（wasm 加载异常）→ 抛出原 Error；调用方 try/catch
 * 后向用户提示「hash 失败，请重试」。
 */
export async function computeSha256(
  file: File,
  onProgress?: (p: HashProgress) => void,
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();

  const totalBytes = file.size;
  let bytesHashed = 0;

  // File.slice 是 subarray 语义，不复制数据 → 适合大文件流式。
  // 循环：每次取 [offset, offset+CHUNK_SIZE) 的字节更新 hasher。
  while (bytesHashed < totalBytes) {
    const end = Math.min(bytesHashed + CHUNK_SIZE, totalBytes);
    const chunk = await file.slice(bytesHashed, end).arrayBuffer();
    hasher.update(new Uint8Array(chunk));
    bytesHashed = end;
    if (onProgress) {
      onProgress({ bytesHashed, totalBytes });
    }
  }

  return hasher.digest('hex');
}
