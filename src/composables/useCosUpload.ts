// 2026-09-16 新增：COS 直传 composable（前端 cos-js-sdk-v5 + STS 临时凭证链路）。
//
// 背景：M3 重构后，图纸 / 3D 模型等大文件不再走 multipart 由后端代理上传 COS，
// 改为：后端签发 STS 临时凭证 + tmp_key → 前端 cos-js-sdk-v5 直传 COS tmp 区
// → 业务端点（建单 / 补传）携带 tmp_key + sha 由后端 head + copy 到正式 CAS key。
//
// 设计要点：
// - 输入只接收「上传项 + 重签回调」两项。`items` 是 Ref，每项已携带
//   client_ref / tmp_key / credentials / bucket / region / tmp_prefix（由
//   上游 `createUploadIntents` 拿回后组装）；composable 只维护 status / progress /
//   etag / error 这些运行时状态，原地 mutate（Vue 3 ref 数组 reactive 追踪）。
// - 凭证过期检测：`(Date.now() + 5 * 60_000) >= expired_time * 1000` 触发
//   `refetchIntents()` 重新申请；M3 假设后端对同一 `(client_ref, sha)` 重签会
//   保持 tmp_key 不变（STS policy resource 已写入 tmp_key 的资源限制，凭证换了
//   也能继续上传到原 key）。
// - 并发：每文件独立 `cos.uploadFile()` 调用，composable 用简单信号量限制
//   最大并发 3（与 SDK 默认 `FileParallelLimit` 一致）；单文件由 SDK 自动切片。
// - 失败重试：`retryItem(clientRef)` 把该 item 的 status 复位为 pending，
//   再走一遍正常 upload 流程（progress 保留原值，仅当再次成功时覆盖 etag）。
// - 不依赖 Vue 组件实例：模块级 setup + 闭包，与 `useApplicantSearch` 等
//   composable 一致——可以脱离组件直接调用（单测、批量上传脚本）。
//
// 已知约束：
// - COS SDK 用 XHR，**只能在浏览器环境跑**；vitest 单测用 happy-dom + mock。
// - 单测不发起真实 HTTP：mock COS 类（不能真传 COS 桶）；mock 凭证过期时间
//   用 `vi.useFakeTimers()` + `vi.setSystemTime()`。
//
// COS 桶 CORS 约束（2026-09-16 M3-C 联调发现，运维必读）：
// - 前端 cos-js-sdk-v5 直连 COS 桶域名（`{bucket}-{appid}.cos.{region}.myqcloud.com`），
//   **不走** frontend nginx，因此 nginx 配置（仅反代 /api/*）不生效；CORS 必须
//   在 COS 控制台「存储桶 → 权限管理 → 跨域访问 CORS 设置」显式开启：
//   - 来源 Origin：`http://localhost:8080`（dev）/ staging 域名 / 生产域名
//   - 操作 Methods：`PUT, POST, GET, HEAD, DELETE`（SDK 上传主要用 PUT）
//   - 允许 Headers：`*`
//   - 暴露 Headers：`ETag, x-cos-*`（上传完成后 SDK 要读 ETag）
//   - 超时秒数：建议 ≥ 300（大文件分块耗时）
// - 没配 CORS → 浏览器报 `No 'Access-Control-Allow-Origin' header is present`，
//   PUT 预检 403；M4 联调首日必踩。已在 docs/06-data-and-excel/pdf-and-file.md
//   同步此约束。
//
// STS policy resource 对齐（2026-09-16 M3-C）：
// - 后端 `tmp_sub_prefix = "{cfg_tmp_prefix}{Uuid::new_v4()}"`（场景 A）或
//   `"{cfg_tmp_prefix}part/{owner_id}"`（场景 B）；前端 useCosUpload 直传时 key
//   必须以 `tmp/` 开头（实际是 `tmp/batch_uuid/seq_filename` 或
//   `tmp/part/{owner_id}/...`），与服务端 STS policy resource `tmp_prefix/*` 匹配。
// - 重签场景：tmp_key 由 caller 重排 seq 时会变 → 上文 `applyFreshIntents`
//   兜底 reset pending 强制重传，不会让鬼状态穿透到 commit / confirm。

import COS from 'cos-js-sdk-v5';
import { computed, type ComputedRef, type Ref } from 'vue';
import type { CosCredentials, UploadIntentsOut } from '@/types/part_file';

/** 终端状态判断用：上传已经走到 done / error，无法再推进。 */
export type CosUploadStatus = 'pending' | 'uploading' | 'done' | 'error';

/**
 * 单文件上传项（composable 唯一 mutable 容器）。
 *
 * 字段来源：
 * - 由 caller 从 `UploadIntentsOut.items` 反查 File 拼装；
 * - credentials / tmp_key 由 createUploadIntents 拿回后立即写入；
 * - status / progress / etag / error 由 composable 在 startUpload / retryItem 内维护。
 */
export interface CosUploadItem {
  /** 唯一键（来自 caller 传入或 generate）。 */
  client_ref: string;
  /** 待上传文件对象。 */
  file: File;
  /** COS tmp 区 key；composable 直接 `cos.uploadFile({ Key: tmp_key })`。 */
  tmp_key: string;
  /** 目标桶（来自 UploadIntentsOut.bucket）。 */
  bucket: string;
  /** 目标地域（来自 UploadIntentsOut.region）。 */
  region: string;
  /** STS policy resource 限定前缀（展示用；实际 key 已自含）。 */
  tmp_prefix: string;
  /** 当前持有的 STS 凭证；过期时由 refetchIntents 刷新。 */
  credentials: CosCredentials;
  /** 运行时状态（composable 维护）。 */
  status: CosUploadStatus;
  /** 进度 0-100 整数（composable 维护）。 */
  progress: number;
  /** 上传成功后 COS 返回的 ETag。 */
  etag?: string;
  /** 失败信息（composable 维护）。 */
  error?: string;
}

export interface UseCosUploadOptions {
  /** 待上传文件项列表。composable 会原地修改 status / progress / etag / error。 */
  items: Ref<CosUploadItem[]>;
  /**
   * 凭证过期时调用，重新申请 STS + tmp_key。
   * 实现示例：`async () => createUploadIntents({ files: items.value.map(toIntentItem) })`。
   * 约定：返回的 UploadIntentsOut 必须保持各 `items[i].tmp_key` 不变（由 caller
   * 在组装 `files` 时复用 client_ref 实现）；composable 拿到新结果后覆盖所有
   * item 的 credentials / bucket / region。
   */
  refetchIntents: () => Promise<UploadIntentsOut>;
  /** 最大并发文件数；默认 3（对齐 SDK 默认 FileParallelLimit）。 */
  concurrency?: number;
}

/** 凭证过期提前量：到期前 5 分钟触发 refetchIntents。 */
const EXPIRY_AHEAD_MS = 5 * 60_000;
/** 上传进度取整（百分制）。SDK 给的是 0-1 的小数 percent。 */
const PROGRESS_ROUND = Math.round;

export interface UseCosUploadReturn {
  /** items ref（暴露给消费侧做模板绑定）。 */
  items: Ref<CosUploadItem[]>;
  /**
   * 启动上传：所有 status='pending' 的项会并行跑（concurrency 限制），
   * 已 uploading / done / error 的不动。返回 Promise，所有项进入终态
   * （done 或 error）后 resolve。
   */
  startUpload: () => Promise<void>;
  /**
   * 单项重试：把 status='error' 复位为 'pending' 后再次走上传流程。
   * - 如果该项正在 uploading 中：忽略，等当前完成后再触发重试（用
   *   `item.status = 'pending'` 让下一次 startUpload 拉起）。
   * - 已 done 的项：忽略（重试一个已成功的上传没意义）。
   */
  retryItem: (clientRef: string) => Promise<void>;
  /** 计算属性：所有项都已进入终态（done 或 error）。 */
  allDone: ComputedRef<boolean>;
  /** 计算属性：所有项都 done（没有任何 error / pending / uploading）。 */
  allOk: ComputedRef<boolean>;
}

/**
 * 构造 COS 实例（每批/每次 refresh 重新 new，避免跨批次串味）。
 *
 * STS 临时凭证场景下 `Protocol: 'https:'` 是必须的（COS 默认走 https）；
 * `SdkAppid` / `Region` 字段省略——region 在每次 uploadFile 时传。
 */
function buildCos(credentials: CosCredentials): COS {
  return new COS({
    SecretId: credentials.tmp_secret_id,
    SecretKey: credentials.tmp_secret_key,
    SecurityToken: credentials.session_token,
    XCosSecurityToken: credentials.session_token,
    Protocol: 'https:',
  });
}

/**
 * 是否需要刷新凭证：`now + EXPIRY_AHEAD_MS >= expired_time*1000`。
 * expired_time 后端以 i64 秒数序列化，JSON 解析为 number；前端 Date.now() 是毫秒。
 */
function isCredentialExpiring(c: CosCredentials, nowMs: number): boolean {
  return nowMs + EXPIRY_AHEAD_MS >= c.expired_time * 1000;
}

export function useCosUpload(opts: UseCosUploadOptions): UseCosUploadReturn {
  const { items, refetchIntents, concurrency = 3 } = opts;

  /**
   * 把整批 items 的 credentials / bucket / region 替换成新签发的。
   *
   * 2026-09-16 M3-A 复审 Blocker 兜底（M3-C T3.4 集成时发现）：
   * 原实现只覆盖 credentials / bucket / region + 在 `fresh.tmp_key` 存在时无脑覆盖
   * `it.tmp_key`，但**已 done/error 状态**没被复位——会出现「重签后凭证是新的、tmp_key
   * 也变了，但 status 仍是 done」的鬼状态（实际上传已被旧 STS 写到了旧 key，
   * 后续 commit / confirm 拿新 tmp_key 去 head 必 404）。
   *
   * 正确语义：
   * - tmp_key 不变（场景 B dedup 命中 / 重签保持一致）：仅刷 credentials / bucket / region。
   * - tmp_key 变了（场景 A 重签时 server 重新分配 seq / 跨批次漂移）：**强制 reset pending**，
   *   清 progress / etag / error，下一次 startUpload / retryItem 拉起重传。
   * - 上传中（status='uploading'）+ tmp_key 变化：理论上 ensureFreshCredentials 只在
   *   pending/error 上触发，不应撞到 uploading；万一撞到（caller race），强制 mark error
   *   让重试可见（不让 in-flight 写旧 key）。
   * - fresh.tmp_key 为空（旧实现只覆盖存在的 tmp_key，留下旧的）：极端情况，让 status=error
   *   显式提示「STS 重签后 tmp_key 缺失，请重新发起」。
   */
  function applyFreshIntents(intents: UploadIntentsOut): void {
    // 按 client_ref 索引映射
    const byRef = new Map(intents.items.map((it) => [it.client_ref, it]));
    for (const it of items.value) {
      const fresh = byRef.get(it.client_ref);
      if (!fresh) {
        // caller 没把这个 client_ref 放进新签发的 items 里 → 跳过；该 item 仍持有旧凭证
        continue;
      }
      it.credentials = intents.credentials;
      it.bucket = intents.bucket;
      it.region = intents.region;
      it.tmp_prefix = intents.tmp_prefix;
      // tmp_key 分支处理（见函数 doc）
      if (fresh.tmp_key && fresh.tmp_key !== it.tmp_key) {
        // tmp_key 真的变了 → 强制该 item 走重传
        it.tmp_key = fresh.tmp_key;
        if (it.status === 'done' || it.status === 'error') {
          it.status = 'pending';
          it.progress = 0;
          it.error = undefined;
          it.etag = undefined;
        } else if (it.status === 'uploading') {
          // 理论上不该撞到；撞到就强制 error，避免 in-flight 写到旧 key
          it.status = 'error';
          it.error = '重签时上传进行中（tmp_key 已变），请重新发起';
          it.progress = 0;
        }
      } else if (!fresh.tmp_key && it.tmp_key) {
        // 旧实现漏分支：之前有 tmp_key 现在空了（极端，不应发生）→ 强制 retry 可见
        it.status = 'error';
        it.error = 'STS 重签后 tmp_key 缺失，请重新发起';
        it.progress = 0;
      }
      // 其他两种情况（都为空 = dedup 命中；都一致 = 普通重签）：不动 status。
    }
  }

  /**
   * 必要时刷新凭证，返回是否实际触发了刷新。
   */
  async function ensureFreshCredentials(): Promise<boolean> {
    const list = items.value;
    if (list.length === 0) return false;
    // 任意一个 item 的凭证即将过期 → 整批重签（M3 P0 简化）
    const nowMs = Date.now();
    const anyExpiring = list.some((it) => isCredentialExpiring(it.credentials, nowMs));
    if (!anyExpiring) return false;
    const fresh = await refetchIntents();
    applyFreshIntents(fresh);
    return true;
  }

  /**
   * 上传单个 item（内部使用，不暴露）。失败 → status=error；成功 → status=done, etag。
   * 拿到的是当前 items 数组的索引（ref 数组中途可能变长，但 useCosUpload 通常
   * 在 startUpload 全程固定，故按下标拿没问题；万一 caller 中途 push 新项，
   * 由 caller 自行管理并发）。
   */
  async function uploadOne(idx: number): Promise<void> {
    const it = items.value[idx];
    if (!it) return; // 并发期间被 caller 删了
    it.status = 'uploading';
    it.error = undefined;
    const cos = buildCos(it.credentials);
    try {
      const data = await cos.uploadFile({
        Bucket: it.bucket,
        Region: it.region,
        Key: it.tmp_key,
        Body: it.file,
        onProgress: (p) => {
          // SDK 给的 percent 是 0-1；覆盖进度但不重置初值
          it.progress = PROGRESS_ROUND(p.percent * 100);
        },
      });
      it.status = 'done';
      it.progress = 100;
      // ETag 在响应 headers 里有；不同 SDK 版本可能直接在 data.ETag 或 data.headers
      const etag = (data as { ETag?: string }).ETag ?? data.headers?.ETag;
      if (etag) it.etag = etag;
    } catch (err) {
      it.status = 'error';
      it.progress = 0;
      it.error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * 简易信号量：限制并发上限为 `concurrency`。
   * 不用 Promise.all(items.map(uploadOne)) 是因为 N=20 会同时跑 20 个 cos 实例。
   */
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
    for (let w = 0; w < workerCount; w += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  async function startUpload(): Promise<void> {
    // 必要时刷新整批凭证
    await ensureFreshCredentials();
    // 收集 pending 下标
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
    // 已 done 不重试（语义上没必要）；uploading 中不打断（让当前完成后再触发）。
    if (it.status === 'done') return;
    if (it.status === 'uploading') return;
    // error / pending：先刷新凭证再单独跑
    await ensureFreshCredentials();
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

  return {
    items,
    startUpload,
    retryItem,
    allDone,
    allOk,
  };
}
