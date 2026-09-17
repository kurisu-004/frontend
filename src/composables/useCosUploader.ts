// composables/useCosUploader.ts
//
// 2026-09-17 新增：通用 COS 上传 composable（领域无关版本）。
//
// 背景：
// M3（2026-09-16）落地的 `useCosUpload` 是 part-file 域专用 composable —— 它
// 输入 `UploadIntentsOut`（part_file.ts 域类型，绑死 tmp_prefix / dedup_hit /
// kind / filename / file_size / content_sha256 等 part-file 字段）。后续若其它
// 域（delivery-notes / cnc / assembly 等）也要走"前端 → COS 直传 + 后端
// head+copy"的同款链路，复用 useCosUpload 就会反向耦合 part-file 域类型，
// 污染 caller 的领域契约。
//
// 本文件抽象出"通用领域无关"的 cos-uploader 状态机：
// - 输入只接收 `requestUpload: (files) => Promise<CosUploadSession>` 一个
//   回调，由 caller 自己实现「拿 File 列表 → 调后端 STS 端点 → 拼
//   CosUploadSession」，composable 不感知任何域字段；
// - 内部状态机（pending / hashing / uploading / done / error）、并发信号量、
//   凭证过期重签、tmp_key 变化兜底、retryItem 等策略沿用 useCosUpload 的成熟
//   实现，避免重复踩坑。
//
// 与 useCosUpload 的关系：
// - useCosUpload（part-file 专用）：保留，内部仍被 parts-form 等 part-file 视图
//   消费，并保留 part_file.ts 类型契约；
// - useCosUploader（通用，**并存而非替代**）：面向未来其它域的通用上传底座，
//   也将驱动 `src/components/cos-uploader/*` 系列组件；
// - 二者状态机 / 重签 / 重试策略一致，差异仅在输入契约（通用 session vs part
//   域 intents）。
//
// 设计要点清单：
// 1. 构造器 `buildCosUploadItems(files, session, opts?)` 把 File[] + session.items
//    对齐成 `CosUploaderItem[]`，client_ref 由 composable 内部生成（用
//    crypto.randomUUID 或回退 Date+随机串）—— caller 不必关心。
// 2. 凭证过期检测：`(Date.now() + 5 * 60_000) >= c.expired_time * 1000` 触发
//    `refetchSession()` 重签（与 useCosUpload 一致）。
// 3. applyFreshSession（对应 useCosUpload.applyFreshIntents，函数名改为更普适
//    的"Session"）：
//    - tmp_key 不变：仅刷 credentials / bucket / region；
//    - tmp_key 变化：强制 reset pending（清 progress / etag / error / status=
//      pending），避免"旧 STS 写旧 key + 新 tmp_key 拿去 confirm"的鬼状态；
//    - uploading 中撞到 tmp_key 变化：mark error，避免 in-flight 写到旧 key；
//    - fresh.tmp_key 为空：mark error「STS 重签后 tmp_key 缺失」。
// 4. COS 实例每批重新 new（避免跨批次串味），与 useCosUpload 同样的
//    `Protocol: 'https:'` 配置。
// 5. 并发：简易信号量 `runWithConcurrency(targets, limit)`，worker 函数闭包内
//    cursor 自增；默认上限 3，对齐 cos-js-sdk-v5 默认 FileParallelLimit。
// 6. hash 阶段（computeHash=true）：先 await computeSha256 把进度映射到 item
//    progress 前 30%，再走 uploadOne 把 30%-100% 进度映射给上传；hash 失败
//    直接 status='error'。
// 7. 模块级 setup + 闭包，不依赖 Vue 组件实例（与 useCosUpload /
//    useApplicantSearch 等一致），可脱离组件直接调用（单测、批量上传脚本）。
//
// 已知约束：
// - COS SDK 走 XHR，**只能在浏览器环境跑**；vitest 单测用 mock（不发起真实
//   HTTP），具体见 src/composables/__tests__/useCosUploader.spec.ts。
// - 单测环境：vitest 默认 node 环境即可跑（Node 24+ 内置 File / Blob /
//   crypto.randomUUID），不需要 happy-dom；mock 凭证过期时间用
//   `vi.useFakeTimers()` + `vi.setSystemTime()`。
// - COS 桶 CORS 必须配（详见 useCosUpload.ts 注释 / docs/06-data-and-excel/
//   pdf-and-file.md）；本 composable 不直接读取相关 env，仅复述约束。
//
// 类型契约来源：本 composable 完全依赖 `src/types/cos_upload.ts`（2026-09-17
// commit b9956a5 新增）。该文件与 `src/types/part_file.ts` 的同名词字段完全
// 一致，但通用组件不反向依赖 part-file 域类型，避免循环依赖。

import COS from 'cos-js-sdk-v5';
import { computed, type ComputedRef, type Ref } from 'vue';
import { computeSha256 } from '@/utils/fileHash';
import type {
  CosCredentials,
  CosUploadedItem,
  CosUploaderItem,
  CosUploaderStatus,
  CosUploadSession,
} from '@/types/cos_upload';

// re-export 契约类型，方便 caller 从 composable 模块单点导入
export type {
  CosCredentials,
  CosUploadedItem,
  CosUploaderItem,
  CosUploaderStatus,
  CosUploadSession,
};

/** 内部状态机的类型别名（直接复用 CosUploaderItem['status']）。 */
export type CosUploaderPhase = CosUploaderItem['status'];

/** 凭证过期提前量：到期前 5 分钟触发 refetchSession。 */
const EXPIRY_AHEAD_MS = 5 * 60_000;
/** 上传进度取整（百分制）。SDK 给的是 0-1 的小数 percent。 */
const PROGRESS_ROUND = Math.round;

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
 * - `files.length === session.items.length`：caller 必须保证二一一对应（多余
 *   或缺失都被截断 / 视为非法，由 caller 保证；本函数不抛错仅按短端处理）。
 * - 每个 item 初始 status='pending', progress=0, error=undefined。
 * - client_ref 由 composable 内部生成，**不**复用 session.items[i].client_ref
 *   （useCosUpload 的 part-file 域专用版会复用，因为 caller 用 sha+filename
 *   做 dedup；通用版不强假设 caller 的去重语义，让 composable 自己生成即可，
 *   session.items[i].tmp_key 与 item 仍按数组下标一一对应）。
 */
export function buildCosUploadItems(
  files: File[],
  session: CosUploadSession,
  opts?: { computeHash?: boolean },
): CosUploaderItem[] {
  const computeHash = opts?.computeHash ?? false;
  const len = Math.min(files.length, session.items.length);
  const items: CosUploaderItem[] = [];
  for (let i = 0; i < len; i += 1) {
    const file = files[i]!;
    const it = session.items[i]!;
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
   * refetchSession: async () => {
   *   const { credentials, items } = await api.post('/upload/intents', { files: ... })
   *   return { credentials, bucket, region, items }
   * }
   * ```
   * 约定：
   * - 返回的 session.items[i].client_ref 由 caller 决定，但**与 items.value 中
   *   的 client_ref 不必一致**——本 composable 按数组下标对齐 tmp_key，不按
   *   client_ref 索引（与 useCosUpload 不同，更通用）。
   */
  refetchSession: () => Promise<CosUploadSession>;
  /**
   * 2026-09-17 新增：可选"初始 session"，由 caller 在 buildCosUploadItems
   * 之后、startUpload 之前传入。composable 把它作为"批级凭证源"——首次
   * 上传前用其判断凭证过期、构造 COS 实例；只有凭证真正过期时才会调
   * refetchSession 重签。
   *
   * 不传：composable 首次 startUpload / retryItem 时会调一次 refetchSession
   * 拿当前 session（与 useCosUpload 行为略有差异；caller 若希望"凭证健康
   * 时不调 refetchSession"必须传 initialSession）。
   *
   * 推荐用法（caller 主动持 session，让 composable 不主动查 STS）：
   * ```ts
   * const session = await refetchSession()
   * const items = buildCosUploadItems(files, session)
   * const uploader = useCosUploader({ items: ref(items), refetchSession, initialSession: session })
   * ```
   */
  initialSession?: CosUploadSession;
  /**
   * 是否对每个 item 先跑 computeSha256（默认 false）。
   * - true：item 状态会经历 'hashing'（hash 进度映射 0%-30%）→ 'uploading'
   *   （上传进度映射 30%-100%）→ 'done' / 'error'；
   * - false：item 状态直接 pending → uploading → done / error。
   */
  computeHash?: boolean;
  /** 最大并发文件数；默认 3（对齐 SDK 默认 FileParallelLimit）。 */
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
  const { items, refetchSession, initialSession, computeHash = false, concurrency = 3 } = opts;

  /**
   * 当前批的共享凭证 / bucket / region。
   *
   * 通用版与 useCosUpload 的差异：useCosUpload 把 credentials / bucket / region
   * 直接挂在每个 item 上（part-file 域签名回的对象就这么给的）；通用版只把
   * 这些"批级元数据"放在 session 顶层、item 上只挂 tmp_key，所以 composable
   * 必须额外持一份 session 引用。
   *
   * 初始化：caller 通过 `initialSession` 显式传入（推荐）；不传则首次
   * startUpload / retryItem 时由 ensureFreshCredentials 主动调一次 refetchSession
   * 兜底。
   */
  let sessionCache: CosUploadSession | null = initialSession ?? null;

  /**
   * 把整批 items 的 tmp_key / 等价"批级元数据"刷成新签发的。
   *
   * 2026-09-17 复审 Blocker 兜底（来自 useCosUpload M3-A 复审经验）：
   * - tmp_key 不变：仅刷 credentials / bucket / region，不动 status；
   * - tmp_key 变化：强制 reset pending，清 progress / etag / error；
   * - uploading 中撞到 tmp_key 变化：mark error，避免 in-flight 写到旧 key；
   * - fresh.tmp_key 为空（旧有 → 新无）：mark error「STS 重签后 tmp_key 缺失」。
   *
   * 与 useCosUpload.applyFreshIntents 的差异：
   * - 本函数按**数组下标**对齐（useCosUpload 按 client_ref 索引 Map）；
   * - 本函数不写 credentials / bucket / region 到 item（item 上没有这些字段），
   *   仅更新 sessionCache。
   */
  function applyFreshSession(fresh: CosUploadSession): void {
    sessionCache = fresh;
    const freshItems = fresh.items;
    items.value.forEach((it, idx) => {
      const fItem = freshItems[idx];
      if (!fItem) {
        // caller 没给对应下标的 fresh item → 该 item 仍持旧 tmp_key，不动
        return;
      }
      if (fItem.tmp_key && fItem.tmp_key !== it.tmp_key) {
        it.tmp_key = fItem.tmp_key;
        if (it.status === 'done' || it.status === 'error') {
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
   * 2. sessionCache 为空（caller 未传 initialSession）→ 调一次 refetchSession
   *    兜底拿批级凭证（这是与 useCosUpload 的差异点；useCosUpload 直接从
   *    item.credentials 读，无需首次 refetch）；
   * 3. sessionCache 非空 + 凭证即将过期（< 5 min 余量）→ 调 refetchSession 重签；
   * 4. sessionCache 非空 + 凭证健康 → 不调。
   */
  async function ensureFreshCredentials(): Promise<boolean> {
    const list = items.value;
    if (list.length === 0) return false;
    const creds = sessionCache?.credentials;
    if (!creds) {
      // 还没缓存过 session → 调一次 refetchSession 拿当前批级凭证
      const fresh = await refetchSession();
      applyFreshSession(fresh);
      return true;
    }
    const nowMs = Date.now();
    if (!isCredentialExpiring(creds, nowMs)) return false;
    const fresh = await refetchSession();
    applyFreshSession(fresh);
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
    if (!sessionCache) {
      // 极端：没缓存 session 就走到上传路径。理论上 ensureFreshCredentials 已
      // 兜底，此处再调一次 refetchSession 兜底。
      const fresh = await refetchSession();
      applyFreshSession(fresh);
    }
    const creds = sessionCache!.credentials;
    const bucket = sessionCache!.bucket;
    const region = sessionCache!.region;

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
        it.error = err instanceof Error ? err.message : String(err);
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

  return {
    items,
    startUpload,
    retryItem,
    allDone,
    allOk,
  };
}
