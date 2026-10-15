// useCosUploader.ts —— CosUploader 组件的通用上传状态机（2026-10-15 改为预签直传）
//
// 组件包内唯一的「传输 + 状态机」实现，不感知任何业务域：kind / owner / 补传参数都
// 由调用方在实现 `getUploadIntents` 时闭包持有。
//
// ## 状态机
//
//   pending → hashing（computeHash 开启时）→ uploading → done
//                                          ↘ error →（retryItem）→ pending
//
// `already_exists: true` 的项从 pending **直接**落 done（秒传：不发 PUT、不发
// confirm），进度 100。
//
// ## 进度区间
//
// computeHash 开启时 hash 占 0-30%、PUT 占 30-100%（与旧实现的分段口径一致）；
// 关闭时 PUT 占 0-100%。hash 阶段不逐块回抛（300MB 的 SHA-256 只要一两秒，逐块回抛
// 会让进度条「在动但几乎不涨」，反而不如一次性跳到 30 诚实）。
//
// ## 为什么还需要这个 composable，而不是让组件直接调 utils/directUpload.ts
//
// `utils/directUpload.ts` 是**单文件**引擎（一次调用传一个文件、拿一个结果）。本组件
// 要的是「一批文件、各自独立的状态与进度、任一项失败不牵连其它项、单项可重试」——
// 那是数组维度的编排，只能待在这个组件包里。两者不是同一层东西，不要合并。

import { computed, type ComputedRef, type Ref } from 'vue';
import { isPresignExpiredError, xhrPut } from '@/utils/presignedPut';
import type { UploadIntentItemOut } from '@/types/file_intent';
import type { CosUploaderItem, GetUploadIntents } from './types';

/** 内部状态机的类型别名（直接复用 CosUploaderItem['status']）。 */
export type CosUploaderPhase = 'pending' | 'hashing' | 'uploading' | 'done' | 'error';

/** PUT 进度 → 整链路进度的映射：hash 开启时 PUT 占 30-100，否则 0-100。 */
function mapPutProgress(percent: number, hashed: boolean): number {
  return hashed ? 30 + Math.round(percent * 0.7) : percent;
}

/**
 * 输入项构造器：把「一批 File + 一批签发结果」对齐成内部 item 数组。
 *
 * 契约：`files.length === intents.length`（调用方保证一一对应；不一致时按短端截断，
 * 少出来的项根本没有可用的 upload_url，早失败好过传一半）。
 */
export function buildCosUploaderItems(
  files: File[],
  intents: UploadIntentItemOut[],
): CosUploaderItem[] {
  const len = Math.min(files.length, intents.length);
  const items: CosUploaderItem[] = [];
  for (let i = 0; i < len; i += 1) {
    const intent = intents[i]!;
    items.push({
      client_ref: intent.client_ref,
      file: files[i]!,
      object_key: intent.object_key,
      upload_url: intent.upload_url,
      content_type: intent.content_type,
      already_exists: intent.already_exists,
      existing_file: intent.existing_file,
      status: 'pending',
      progress: 0,
      sha256: undefined,
      error: undefined,
    });
  }
  return items;
}

export interface UseCosUploaderOptions {
  /** 待上传文件项列表。composable 会原地修改 status / progress / error。 */
  items: Ref<CosUploaderItem[]>;
  /**
   * 重新签发一批上传意图。实现示例：
   * ```ts
   * const getUploadIntents = async (files: File[]) => {
   *   const resp = await grantUploadIntents({
   *     owner_kind: 'PART', owner_id: partId,
   *     items: await Promise.all(files.map(async (f) => ({
   *       client_ref: crypto.randomUUID(), kind: 'DRAWING',
   *       original_filename: f.name,
   *       content_type: normalizeUploadContentType(f),
   *       file_size: f.size, content_sha256: await computeSha256(f),
   *     }))),
   *   });
   *   return resp.items;
   * };
   * ```
   *
   * ⚠️ **重签必须复用同一 client_ref**：组件按下标对齐，重签一批时若调用方换了新的
   * client_ref，响应项仍按下标对齐不会错位，但 `client_ref` 就对不上日志 / 业务侧的
   * 二次匹配了。
   */
  getUploadIntents: GetUploadIntents;
  /**
   * 是否走 hash 阶段（默认 false）。开启时 item 状态会经历 'hashing'，进度分段为
   * hash 0-30% / PUT 30-100%。
   *
   * ⚠️ 本组件**不自己算 hash**：签发 intent 必须带 `content_sha256`（后端的秒传判据
   * 与 confirm 的登记依据），而算 hash 天然属于「拼 intent 入参」那一步 ⇒ 它发生在
   * 调用方的 `getUploadIntents` 内部。本开关只控制**进度分段与状态标签**：开启时
   * 先显示 'hashing'，让 300MB 大文件那 1-2 秒的哈希期不看起来像卡死。
   */
  computeHash?: boolean;
  /** 最大并发文件数；默认 3。传入 0 / 负数会被兜底提升为 1（否则整批静默不传）。 */
  concurrency?: number;
}

export interface UseCosUploaderReturn {
  /** items ref（暴露给消费侧做模板绑定）。 */
  items: Ref<CosUploaderItem[]>;
  /**
   * 启动上传：所有 status='pending' 的项并行跑（受 concurrency 限制），其余状态不动。
   * 返回的 Promise 在所有项进入终态（done / error）后 resolve。
   */
  startUpload: () => Promise<void>;
  /**
   * 单项重试：把 status='error' 复位为 pending 后重跑。
   * - 已 done：忽略（重试一次已成功的上传没意义）；
   * - hashing / uploading 中：忽略（等当前这次跑完）。
   */
  retryItem: (clientRef: string) => Promise<void>;
  /** 计算属性：所有项都已进入终态（done 或 error）。空列表为 false。 */
  allDone: ComputedRef<boolean>;
  /** 计算属性：所有项都 done。空列表为 false。 */
  allOk: ComputedRef<boolean>;
}

export function useCosUploader(opts: UseCosUploaderOptions): UseCosUploaderReturn {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const { items, getUploadIntents, computeHash = false } = opts;

  /**
   * 上传单个 item。失败 → status='error' 并写 error 文案；成功 → status='done'。
   *
   * URL 过期重试：PUT 撞 403 且命中「签名 / 过期」标记时，**自动重签一次 + 重试
   * 一次**；仍失败转 error。**不做第二次重签** —— 见 `utils/directUpload.ts` 文件头
   * 「只重试一次」的理由。
   */
  async function uploadOne(idx: number): Promise<void> {
    const it = items.value[idx];
    // 并发期间可能被调用方移除；或同一项被并发 startUpload 多次触发（只 pending 进）。
    if (!it || it.status !== 'pending') return;

    // ---- 秒传短路：不发 PUT、不发 confirm，直接以 existing_file 收口 ----
    if (it.already_exists) {
      if (!it.existing_file) {
        it.status = 'error';
        it.progress = 0;
        it.error = '秒传命中但服务端未返回已有文件项，请重新上传';
        return;
      }
      it.status = 'done';
      it.progress = 100;
      return;
    }

    if (!it.upload_url || !it.content_type) {
      it.status = 'error';
      it.progress = 0;
      it.error = '缺少上传地址或内容类型，请重新选择文件';
      return;
    }

    if (computeHash) {
      it.status = 'hashing';
      it.progress = 0;
      it.error = undefined;
    }

    it.status = 'uploading';
    if (!computeHash) it.error = undefined;

    const putOnce = async (url: string, contentType: string): Promise<void> => {
      await xhrPut({ url, contentType }, it.file, (p) => {
        it.progress = mapPutProgress(p, computeHash);
      });
    };

    try {
      await putOnce(it.upload_url, it.content_type);
      it.status = 'done';
      it.progress = 100;
    } catch (e) {
      // URL 过期 → 重签一次再试一次；其它失败直接落 error（不做无界重试）。
      if (isPresignExpiredError(e)) {
        console.warn('[CosUploader] 预签 URL 失效，重新签发后重试：', (e as Error).message);
        try {
          const fresh = await getUploadIntents([it.file]);
          const next = fresh[0];
          if (!next) throw new Error('重新签发未返回对应项（响应异常）');
          if (next.already_exists) {
            // 重签期间后端发现已有文件（秒传）—— 同样不必再发 PUT。
            if (!next.existing_file) {
              throw new Error('秒传命中但服务端未返回已有文件项');
            }
            it.existing_file = next.existing_file;
            it.already_exists = true;
            it.status = 'done';
            it.progress = 100;
            return;
          }
          if (!next.upload_url || !next.content_type) {
            throw new Error('重新签发的上传参数不完整');
          }
          it.upload_url = next.upload_url;
          it.content_type = next.content_type;
          it.object_key = next.object_key;
          await putOnce(next.upload_url, next.content_type);
          it.status = 'done';
          it.progress = 100;
          return;
        } catch (retryErr) {
          it.status = 'error';
          it.progress = 0;
          it.error = (retryErr as Error).message ?? '上传失败';
          return;
        }
      }
      it.status = 'error';
      it.progress = 0;
      it.error = (e as Error).message ?? '上传失败';
    }
  }

  /** 简易信号量：限制并发上限为 `concurrency`（N=20 个文件同时发 PUT 会打爆浏览器连接池）。 */
  async function runWithConcurrency(targets: number[], limit: number): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    async function worker(): Promise<void> {
      while (cursor < targets.length) {
        const i = targets[cursor]!;
        cursor += 1;
        await uploadOne(i);
      }
    }
    const workerCount = Math.min(limit, targets.length);
    for (let w = 0; w < workerCount; w += 1) workers.push(worker());
    await Promise.all(workers);
  }

  async function startUpload(): Promise<void> {
    const targets: number[] = [];
    items.value.forEach((it, idx) => {
      if (it.status === 'pending') targets.push(idx);
    });
    if (targets.length === 0) return;
    await runWithConcurrency(targets, concurrency);
  }

  async function retryItem(clientRef: string): Promise<void> {
    const idx = items.value.findIndex((it) => it.client_ref === clientRef);
    if (idx === -1) return;
    const it = items.value[idx]!;
    // 已 done 不重试；hashing / uploading 中不打断（等当前这次跑完）。
    if (it.status !== 'error') return;
    it.status = 'pending';
    it.error = undefined;
    it.progress = 0;
    await uploadOne(idx);
  }

  const allDone = computed<boolean>(
    () =>
      items.value.length > 0 &&
      items.value.every((it) => it.status === 'done' || it.status === 'error'),
  );

  const allOk = computed<boolean>(
    () => items.value.length > 0 && items.value.every((it) => it.status === 'done'),
  );

  return { items, startUpload, retryItem, allDone, allOk };
}
