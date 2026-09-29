// useCosUploader.ts —— 通用 COS 上传 composable（领域无关版本）
//
// 2026-09-17 新增：通用 COS 上传 composable。
// 2026-09-28 整改：见 CosUploader.vue 文件头注释（2026-09-28 整改要点）。
// 2026-09-28 迁移：从 src/composables/useCosUploader.ts 整体迁入
//   src/components/CosUploader/useCosUploader.ts（CLAUDE.md composable 归属判别：
//   跨域共享约束收紧到组件包内）。
// 2026-09-28 重命名：requestUpload → refetchGrant、sessionCache → grantCache、
//   applyFreshSession → applyFreshGrant、initialSession → initialGrant；
//   返回类型 CosUploadSession → CosUploadGrant、items 元素类型 →
//   CosUploadGrantItem。语义澄清：composable 完全不感知 Redis session。

import COS from 'cos-js-sdk-v5';
import { computed, type ComputedRef, type Ref } from 'vue';
import { computeSha256 } from '@/utils/fileHash';
import type {
  CosCredentials,
  CosUploadedItem,
  CosUploaderItem,
  CosUploaderStatus,
  CosUploadGrant,
} from './types';

// re-export 契约类型，方便 caller 从 composable 模块单点导入
export type {
  CosCredentials,
  CosUploadedItem,
  CosUploaderItem,
  CosUploaderStatus,
  CosUploadGrant,
};

/** 内部状态机的类型别名（直接复用 CosUploaderItem['status']）。 */
export type CosUploaderPhase = CosUploaderItem['status'];

/** 凭证过期提前量：到期前 5 分钟触发 refetchGrant。 */
const EXPIRY_AHEAD_MS = 5 * 60_000;
/** 上传进度取整（百分制）。SDK 给的是 0-1 的小数 percent。 */
const PROGRESS_ROUND = Math.round;

// 2026-09-29 新增：CORS 错误特判（与 useCosUpload.ts:isCorsLikeError 同款独立副本，
// 不抽公共以保持"composable 自治"惯例）
const CORS_ERROR_PATTERNS: RegExp[] = [
  /No ['"]?Access-Control-Allow-Origin['"]? header is present/i,
  /CORS policy:/i,
  /cross-origin/i,
  /Failed to load resource.*status of 403/i,
  /XMLHttpRequest failed/i,
  /NetworkError/i,
  /Access to .* has been blocked by CORS policy/i,
];

function isCorsLikeError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: string; status?: number; message?: string };
  if (err.status === 0) return true;
  if (typeof err.code === 'string' && /network|cors/i.test(err.code)) return true;
  const msg = String(err.message ?? '');
  return CORS_ERROR_PATTERNS.some((re) => re.test(msg));
}

/**
 * 生成稳定的 client_ref。
 *
 * 优先 crypto.randomUUID（现代浏览器 + happy-dom 都支持），回退到
 * Date+随机串的临时方案——避免在 jsdom/happy-dom 老版本或非安全上下文下抛错。
 */
function generateClientRef(idx: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 输入项构造器：caller 把 File 列表转成内部 item 数组。
 *
 * 契约：
 * - `files.length === grant.items.length`：caller 必须保证二一一对应（多余
 *   或缺失都被截断 / 视为非法，由 caller 保证；本函数不抛错仅按短端处理）。
 * - 每个 item 初始 status='pending', progress=0, error=undefined。
 * - client_ref 由 composable 内部生成，**不**复用 grant.items[i].client_ref
 *   （useCosUpload 的 part-file 域专用版会复用，因为 caller 用 sha+filename
 *   做 dedup；通用版不强假设 caller 的去重语义，让 composable 自己生成即可，
 *   grant.items[i].tmp_key 与 item 仍按数组下标一一对应）。
 *
 * 2026-09-28 迁移：从 buildCosUploadItems 改名为 buildCosUploaderItems —— 更准确
 * 地表达「构造 uploader 内部 item」的语义（不是构造上传 upload 行为）。
 */
export function buildCosUploaderItems(
  files: File[],
  grant: CosUploadGrant,
  opts?: { computeHash?: boolean },
): CosUploaderItem[] {
  const computeHash = opts?.computeHash ?? false;
  const len = Math.min(files.length, grant.items.length);
  const items: CosUploaderItem[] = [];
  for (let i = 0; i < len; i += 1) {
    const file = files[i]!;
    const it = grant.items[i]!;
    items.push({
      client_ref: generateClientRef(i),
      tmp_key: it.tmp_key,
      etag: undefined,
      file,
      sha256: undefined,
      status: 'pending',
      progress: 0,
      error: undefined,
    });
  }
  // suppress unused-var lint：computeHash 仅是构造期开关，状态机阶段会读
  // opts.computeHash 决定是否走 hash 阶段（构造时不强写，避免与 caller 的
  // useCosUploader opts.computeHash 不一致）。
  void computeHash;
  return items;
}

export interface UseCosUploaderOptions {
  /** 待上传文件项列表。composable 会原地修改 status / progress / etag / error。 */
  items: Ref<CosUploaderItem[]>;
  /**
   * 凭证过期 / tmp_key 变化时调用，重新申请 STS + tmp_key。
   * 实现示例：
   * ```ts
   * refetchGrant: async () => {
   *   const { credentials, items } = await api.post('/upload/intents', { files: ... })
   *   return { credentials, bucket, region, items }
   * }
   * ```
   * 约定：
   * - 返回的 grant.items[i].client_ref 由 caller 决定，但**与 items.value 中
   *   的 client_ref 不必一致**——本 composable 按数组下标对齐 tmp_key，不按
   *   client_ref 索引（与 useCosUpload 不同，更通用）。
   *
   * 2026-09-28 重命名：refetchSession → refetchGrant。语义不变：拿一次性 grant。
   */
  refetchGrant: () => Promise<CosUploadGrant>;
  /**
   * 2026-09-17 新增：可选"初始 grant"，由 caller 在 buildCosUploaderItems
   * 之后、startUpload 之前传入。composable 把它作为"批级凭证源"——首次
   * 上传前用其判断凭证过期、构造 COS 实例；只有凭证真正过期时才会调
   * refetchGrant 重签。
   *
   * 不传：composable 首次 startUpload / retryItem 时会调一次 refetchGrant
   * 拿当前 grant（与 useCosUpload 行为略有差异；caller 若希望"凭证健康
   * 时不调 refetchGrant"必须传 initialGrant）。
   *
   * 推荐用法（caller 主动持 grant，让 composable 不主动查 STS）：
   * ```ts
   * const grant = await refetchGrant()
   * const items = buildCosUploaderItems(files, grant)
   * const uploader = useCosUploader({ items: ref(items), refetchGrant, initialGrant: grant })
   * ```
   *
   * 2026-09-28 重命名：initialSession → initialGrant。
   */
  initialGrant?: CosUploadGrant;
  /**
   * 是否对每个 item 先跑 computeSha256（默认 false）。
   * - true：item 状态会经历 'hashing'（hash 进度映射 0%-30%）→ 'uploading'
   *   （上传进度映射 30%-100%）→ 'done' / 'error'；
   * - false：item 状态直接 pending → uploading → done / error。
   */
  computeHash?: boolean;
  /**
   * 最大并发文件数；默认 3（对齐 SDK 默认 FileParallelLimit）。
   *
   * 2026-09-17 复审加固：caller 必须传 `≥ 1`；`undefined` / `0` / 负数都会被 composable
   * 入口 `Math.max(1, ?? 3)` 兜底提升，避免 `runWithConcurrency` 推出 0 worker 导致
   * `Promise.all([])` 立即 resolve、整批上传静默全空。
   */
  concurrency?: number;
}

export interface UseCosUploaderReturn {
  /** items ref（暴露给消费侧做模板绑定）。 */
  items: Ref<CosUploaderItem[]>;
  /**
   * 启动上传：所有 status='pending' 的项会并行跑（concurrency 限制），
   * 已 uploading / done / error 的不动。返回 Promise，所有项进入终态
   * （done 或 error）后 resolve。
   */
  startUpload: () => Promise<void>;
  /**
   * 单项重试：把 status='error' 复位为 'pending' 后再次走上传流程。
   * - 已 done 的项：忽略（重试一个已成功的上传没意义）。
   * - uploading 中的项：忽略（让当前完成后再触发）。
   */
  retryItem: (clientRef: string) => Promise<void>;
  /**
   * 2026-09-28 新增：caller 拿到新 grant 后立即喂给 composable（等价构造后补
   * `initialGrant`）。组件 onPick 流程在每次拿到 grant 后调本方法，避免
   * 后续 startUpload 兜底 refetch 导致重复申请凭证 / tmp_key。
   */
  updateGrant: (grant: CosUploadGrant) => void;
  /** 计算属性：所有项都已进入终态（done 或 error）。 */
  allDone: ComputedRef<boolean>;
  /** 计算属性：所有项都 done（没有任何 error / pending / uploading / hashing）。 */
  allOk: ComputedRef<boolean>;
}

/**
 * 构造 COS 实例（每批/每次 refresh 重新 new，避免跨批次串味）。
 *
 * 与 useCosUpload 一致：`Protocol: 'https:'` 必填；`SdkAppid` / `Region` 字段
 * 省略——region 在每次 uploadFile 时传。
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

export function useCosUploader(opts: UseCosUploaderOptions): UseCosUploaderReturn {
  // 2026-09-17 复审加固：concurrency 必须 ≥ 1；undefined 默认 3，0 / 负数兜底提升为 1。
  // 见 UseCosUploaderOptions.concurrency 注释。
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const { items, refetchGrant, initialGrant, computeHash = false } = opts;

  /**
   * 当前批的共享凭证 / bucket / region。
   *
   * 通用版与 useCosUpload 的差异：useCosUpload 把 credentials / bucket / region
   * 直接挂在每个 item 上（part-file 域签名回的对象就这么给的）；通用版只把
   * 这些"批级元数据"放在 grant 顶层、item 上只挂 tmp_key，所以 composable
   * 必须额外持一份 grant 引用。
   *
   * 初始化：caller 通过 `initialGrant` 显式传入（推荐）；不传则首次
   * startUpload / retryItem 时由 ensureFreshCredentials 主动调一次 refetchGrant
   * 兜底。
   *
   * 2026-09-28 重命名：sessionCache → grantCache。
   */
  let grantCache: CosUploadGrant | null = initialGrant ?? null;

  /**
   * 把整批 items 的 tmp_key / 等价"批级元数据"刷成新签发的。
   *
   * 2026-09-17 复审 Blocker 兜底（来自 useCosUpload M3-A 复审经验）：
   * - tmp_key 不变：仅刷 credentials / bucket / region，不动 status；
   * - tmp_key 变化：强制 reset pending，清 progress / etag / error；
   * - uploading 中撞到 tmp_key 变化：mark error，避免 in-flight 写到旧 key；
   * - fresh.tmp_key 为空（旧有 → 新无）：mark error「STS 重签后 tmp_key 缺失」。
   *
   * 2026-09-28 强化：done 项**永不动** — tmp_key 重签不影响已上传对象，避免静默重传。
   * 之前版本会把 done 项 reset pending 然后被 targets 重传，导致 COS 桶里多一份
   * orphan tmp_key + 浪费 sha256 / upload 流量。
   *
   * 与 useCosUpload.applyFreshIntents 的差异：
   * - 本函数按**数组下标**对齐（useCosUpload 按 client_ref 索引 Map）；
   * - 本函数不写 credentials / bucket / region 到 item（item 上没有这些字段），
   *   仅更新 grantCache。
   *
   * 2026-09-28 重命名：applyFreshSession → applyFreshGrant。
   */
  function applyFreshGrant(fresh: CosUploadGrant): void {
    grantCache = fresh;
    const freshItems = fresh.items;
    items.value.forEach((it, idx) => {
      // 2026-09-28：done 项永不动 — tmp_key 重签不影响已上传对象，避免静默重传
      if (it.status === 'done') return;
      const fItem = freshItems[idx];
      if (!fItem) {
        // caller 没给对应下标的 fresh item → 该 item 仍持旧 tmp_key，不动
        return;
      }
      if (fItem.tmp_key && fItem.tmp_key !== it.tmp_key) {
        it.tmp_key = fItem.tmp_key;
        if (it.status === 'error') {
          // 之前上传失败的项拿到新 tmp_key → 重置 pending 等 caller 重试
          it.status = 'pending';
          it.progress = 0;
          it.error = undefined;
          it.etag = undefined;
        } else if (it.status === 'uploading' || it.status === 'hashing') {
          // 理论上不该撞到；撞到就强制 error，避免 in-flight 写到旧 key
          it.status = 'error';
          it.error = '重签时上传进行中（tmp_key 已变），请重新发起';
          it.progress = 0;
        }
      } else if (!fItem.tmp_key && it.tmp_key) {
        // 极端：之前有 tmp_key 现在空了
        it.status = 'error';
        it.error = 'STS 重签后 tmp_key 缺失，请重新发起';
        it.progress = 0;
      }
    });
  }

  /**
   * 必要时刷新凭证，返回是否实际触发了刷新。
   *
   * 判定逻辑：
   * 1. items 为空 → 不刷；
   * 2. grantCache 为空（caller 未传 initialGrant）→ 调一次 refetchGrant
   *    兜底拿批级凭证（这是与 useCosUpload 的差异点；useCosUpload 直接从
   *    item.credentials 读，无需首次 refetch）；
   * 3. grantCache 非空 + 凭证即将过期（< 5 min 余量）→ 调 refetchGrant 重签；
   * 4. grantCache 非空 + 凭证健康 → 不调。
   */
  async function ensureFreshCredentials(): Promise<boolean> {
    const list = items.value;
    if (list.length === 0) return false;
    const creds = grantCache?.credentials;
    if (!creds) {
      // 还没缓存过 grant → 调一次 refetchGrant 拿当前批级凭证
      const fresh = await refetchGrant();
      applyFreshGrant(fresh);
      return true;
    }
    const nowMs = Date.now();
    if (!isCredentialExpiring(creds, nowMs)) return false;
    const fresh = await refetchGrant();
    applyFreshGrant(fresh);
    return true;
  }

  /**
   * 上传单个 item（内部使用，不暴露）。失败 → status=error；成功 → status=done, etag。
   *
   * computeHash=true 时：先 await computeSha256（hash 进度映射 0%-30%），
   * 再走 uploadOne（上传进度映射 30%-100%）；hash 失败直接 status='error'。
   */
  async function uploadOne(idx: number): Promise<void> {
    const it = items.value[idx];
    if (!it) return; // 并发期间被 caller 删了
    // 2026-09-28：纵深防御 — 同一 item 可能被并发 startUpload 多次触发，
    // 仅 status='pending' 才进上传路径；retryItem 已先把 error 置 pending 再调本函数，兼容。
    if (it.status !== 'pending') return;
    if (!grantCache) {
      // 极端：没缓存 grant 就走到上传路径。理论上 ensureFreshCredentials 已
      // 兜底，此处再调一次 refetchGrant 兜底。
      const fresh = await refetchGrant();
      applyFreshGrant(fresh);
    }
    const creds = grantCache!.credentials;
    const bucket = grantCache!.bucket;
    const region = grantCache!.region;

    // 可选 hash 阶段
    if (computeHash) {
      it.status = 'hashing';
      it.error = undefined;
      try {
        const sha = await computeSha256(it.file, ({ bytesHashed, totalBytes }) => {
          if (totalBytes > 0) {
            // hash 阶段占用 0-30% 进度区间
            it.progress = PROGRESS_ROUND((bytesHashed / totalBytes) * 30);
          }
        });
        it.sha256 = sha;
      } catch (err) {
        it.status = 'error';
        it.progress = 0;
        const rawMsg = err instanceof Error ? err.message : String(err);
        console.warn('[COS] hash failed:', rawMsg, err);
        it.error = rawMsg || '哈希计算失败';
        return;
      }
    }

    it.status = 'uploading';
    if (!computeHash) it.error = undefined;
    const cos = buildCos(creds);
    try {
      const data = await cos.uploadFile({
        Bucket: bucket,
        Region: region,
        Key: it.tmp_key,
        Body: it.file,
        onProgress: (p) => {
          const raw = PROGRESS_ROUND(p.percent * 100);
          // 上传阶段占用 30-100% 进度区间（hash 完成后）；无 hash 时直接 0-100%
          it.progress = computeHash ? 30 + Math.round(raw * 0.7) : raw;
        },
      });
      it.status = 'done';
      it.progress = 100;
      const etag = (data as { ETag?: string }).ETag ?? data.headers?.ETag;
      if (etag) it.etag = etag;
    } catch (err) {
      it.status = 'error';
      it.progress = 0;
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (isCorsLikeError(err)) {
        it.error = '上传失败：COS 桶未配置跨域或网络异常，请联系运维检查 CORS 设置';
        console.warn('[COS] CORS-like upload failure:', rawMsg, err);
      } else {
        it.error = rawMsg || '上传失败';
        console.warn('[COS] upload failed:', rawMsg, err);
      }
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
    // 已 done 不重试；hashing / uploading 中不打断（让当前完成后再触发）。
    if (it.status === 'done') return;
    if (it.status === 'hashing' || it.status === 'uploading') return;
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

  /**
   * 2026-09-28 新增：caller 拿到新 grant 后立即喂给 composable，等价于构造后
   * 补 `initialGrant`。组件 onPick 流程会调本方法，使 `ensureFreshCredentials`
   * 看到 warm cache 后跳过兜底 refetch，根除「首次 onPick 调一次 getUploadGrant +
   * 首次 startUpload 兜底又调一次」的双调浪费（300MB PDF sha256 重算 +
   * 后端 allocate 双份 tmp_key）。
   *
   * 与 `applyFreshGrant` 区别：
   * - updateGrant 写的是「本次 onPick 拿到的全新 batch grant」，item 列表
   *   已知一一对应，**不动 item 状态**（tmp_key 已由 buildCosUploaderItems 写好）；
   * - applyFreshGrant 写的是「凭证过期后 refetchGrant 的结果」，按下标对齐
   *   + 处理 tmp_key 变化 + 跳过 done 项。
   *
   * 2026-09-28 重命名：updateSession → updateGrant。
   */
  function updateGrant(grant: CosUploadGrant): void {
    grantCache = grant;
  }

  return {
    items,
    startUpload,
    retryItem,
    updateGrant,
    allDone,
    allOk,
  };
}