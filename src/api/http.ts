// 统一 HTTP 客户端（axios 封装）。
//
// 全站只有一条 API 前缀 `/api/v2`（backend-rust），所有端点都走 `api` 实例。Python
// 只在 compose 内网经 rust 转发触达，浏览器不再直连任何 Python 端口（nginx 也不暴露）。
//
// 1) 请求拦截：自动从 localStorage['auth_session'] 取 token，挂 `Authorization: Bearer <token>`。
// 2) 响应拦截：
//    a) 解 `{code, message, data}` 信封 → 调用方拿到的是原始 data。
//    b) token 自动刷新：
//       - reactive：收到 40102（access 过期）→ 调 /iam/refresh 换新 token → 重试原请求；
//       - proactive：每次成功响应都看一眼 exp，剩余 < 5min 就后台 fire-and-forget 刷新；
//       - keepalive（2026-10-09 新增）：模块级 setTimeout 链，按 storage 里 token 的
//         exp 自续期，覆盖 proactive 覆盖不到的「零 HTTP 流量」场景（空闲大屏）。
//    c) 雪崩防御：标签页内用模块级 refreshPromise 队列，并发 40102 只触发一次
//       /iam/refresh；跨标签页用 Web Locks（`hsh-erp:token-refresh`）互斥，因为后端
//       refresh token 一次性轮转 + reuse detection 会连带清掉该用户所有会话。
//    d) code !== 0 → 抛 `ApiError(code, message)`，调用方用 try/catch 即可拿到业务错误码。
//    e) blob 错误体分支：`responseType: 'blob'` 的端点（4 个打印端点）错误 body 也是
//       Blob，必须先读成文本再 JSON.parse，否则 isEnvelope 判 false → 打印端点的 40102
//       自动 refresh 静默失效（直接抛 network error）。
//
// 3) `refreshClient`：无任何拦截器的裸 axios 实例（baseURL `/api/v2`），专门给
//    /api/v2/iam/refresh 用，避免响应拦截器里的 40102 → refresh 链路递归触发。
//    失败兜底：refresh 失败 → dispatchEvent('auth:logout')，由 main.ts 监听后
//    router.replace('/login')。session 失效的统一入口。
//    2026-10-02 补注：`auth:logout` 有**两个**订阅方、职责不同 —— main.ts 只做
//    导航，stores/auth.ts 清会话状态 + queryClient.clear()。本文件是**派发方**，
//    详见 CLAUDE.md「`auth:logout` 是订阅点不是派发点」条目。
//
// 4) 打印端点（2 个，2026-10-03 起由 rust 鉴权后转发 python，前端路径与调用签名不变）：
//    - GET  /parts/{id}/print-drawing            ← printPartDrawing
//    - POST /parts/print-drawing-batch           ← printPartDrawingBatch
//    响应是文件 blob（不是信封），且**不读 `Content-Disposition`**：单件走 iframe 内联
//    渲染、批量直接进打印对话框，都不落盘。
//    送货单那 2 条打印端点（`/delivery-notes/{id}/print` / `/print-labels`）已随
//    2026-10-08 的送货单域重构整体下线：打印改由前端本地渲染（见
//    views/com/delivery/utils/deliveryNoteWorkbook.ts），后端不再经手。
//    这 2 条路径在 rust 侧放宽了读超时（打印档 660s，批量拼接 PDF 耗时可达分钟级），
//    前端批量端点的 axios timeout 必须严格大于它，理由见 api/parts/file.ts。

import type { AxiosError } from 'axios';
import axios, {
  type AxiosInstance,
  type AxiosRequestHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { decodeJwt } from '@/utils/jwt';
import { refreshTokens, type LoginResponse } from '@/api/iam';
import type { CurrentUser } from '@/types/user';

// 2026-09-21 params 收紧：serializeParamsWith / serializeParamsV2 的 params 由 `any`
// 收紧为 `Record<string, unknown>`，与 axios 自身 `paramsSerializer: (params: any) =>
// string` 的契约解耦（axios 是 JS 不查，但 TS 端能收窄就收窄）。Array.isArray 后 val
// 仍是 unknown，需要逐元素 `as string` 才能喂 encodeURIComponent——集中在这条注释
// 提示，不再每处重复。
//
// cleanParams 是已知例外：泛型 `<T extends Record<string, unknown>>` 会让
// ListPartsParams / AssemblyListQuery / ListUsersParams / ListShelvesParams /
// ListWorkersParams 这类 interface 形参在调用处报 TS2345（interface 缺字符串 index
// signature，不满足 `Record<string, unknown>` 约束）。原注释已说明，保留
// `<T extends Record<string, any>>` 不动；本轮统一收紧跳过此函数。

/**
 * 后端期望多值筛选走 CSV 单值形式（`?statuses=A,B`）的 key 白名单。
 *
 * 依据是 rust axum 的 Query 反序列化：`statuses` / `locations` / `holder_ids` 在
 * `PartListQuery` 里是逗号分隔的单值字段（`statuses` 为 Vec<String>，另两个为
 * `Option<String>`）。发重复 key（`?statuses=A&statuses=B`）时 axum 取不到期望形态，
 * 直接返 400（40001 VALIDATION_ERROR），UI 打开 /parts 会白屏。CSV 编码
 * `?statuses=A%2CB` / `?locations=A%2CB` / `?holder_ids=X%2CY` 才是正确 wire-format。
 *
 * 白名单外的数组字段仍走重复 key（后端按 Vec 参数解析时兼容 `?k=a&k=b`）。
 */
const ARRAY_AS_CSV_KEYS = new Set<string>(['statuses', 'locations', 'holder_ids']);

function serializeParamsWith(params: Record<string, unknown>, csvKeys: Set<string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params)) {
    const val = params[key];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (csvKeys.has(key)) {
        // CSV 单值：数组 → "a,b,c"，单个元素 → "a"。空数组已在 cleanParams 阶段
        // 剥掉，这里再保险一次。
        // 用 `%2C`（逗号转义）拼接而不是字面 `,`：encodeURIComponent 不会编码 `,`，
        // 但 RFC 3986 规定 query 里的分隔符需要百分号转义，避免后端/中间件误判。
        if (val.length === 0) continue;
        parts.push(
          `${encodeURIComponent(key)}=${val.map((v) => encodeURIComponent(v as string)).join('%2C')}`,
        );
      } else {
        // 重复 key：每个元素独立 push（未列入 CSV 白名单的数组字段）
        for (const v of val) {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v as string)}`);
        }
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val as string)}`);
    }
  }
  return parts.join('&');
}

/** v2 query 序列化器：白名单内 key（`statuses` / `locations` / `holder_ids`）数组
 *  → CSV 单值 `?k=a%2Cb`，其它数组维持重复 key。`api` / `refreshClient`
 *  （baseURL `/api/v2`）都用它，匹配 rust axum Query 反序列化的 CSV 期望。 */
export function serializeParamsV2(params: Record<string, unknown>): string {
  return serializeParamsWith(params, ARRAY_AS_CSV_KEYS);
}

/**
 * 把后端 list 响应统一规整成 number 类型的分页字段（2026-09-25 新增）。
 *
 * 后端 v2 各域 list 端点的分页字段类型不统一，本函数是唯一的收口点，调用处一律
 * 拿 number 用：
 * - `PartListOut`（part 域）的 `total` / `limit` / `offset` 是裸 i64 → JSON number
 *   （backend-rust `vo/part.rs::PartListOut` 三个字段无 `serialize_with`；同 VO 里
 *   走 `serialize_i64` 的是雪花 ID 字段，不是这三个计数）；
 * - `InspectionQueueListOut`（待品检）等端点的同名计数是 `serialize_i64` → JSON 字符串；
 * - `UserListOut` / `WorkerListOut` / `CustomerListOut` / `OutsourceCompanyListOut` /
 *   `OutsourceQuoteListOut` / `ShelfListOut` / `DeliveryNoteListOut` /
 *   `DeliveryGroupListOut` / `ProcessListOut` 用裸 i64 number。
 *
 * 因此三个计数**无条件**过 `Number()`：对 number 是恒等，对 string 是兜底归一。
 * 调用方拿到响应后用本函数包一层，调用处就能稳定用 `Number` 比较 / 算术运算
 * 而不必关心后端实际是 string 还是 number。**不修改 schema 类型本身**，仅
 * 在响应包装层做归一化（`items` 保持原样）。
 */
export function normalizeListResult<T>(resp: {
  items: T[];
  total: string | number;
  limit: string | number;
  offset: string | number;
}): { items: T[]; total: number; limit: number; offset: number } {
  return {
    items: resp.items,
    total: Number(resp.total),
    limit: Number(resp.limit),
    offset: Number(resp.offset),
  };
}

const STORAGE_KEY = 'auth_session';

// ===== 业务客户端（v2）=====
export const api = axios.create({
  baseURL: '/api/v2',
  // 不显式设 Content-Type：axios 会按 body 类型自动选 application/json / multipart/form-data。
  // paramsSerializer 走 V2：白名单 key（statuses 等）数组 → CSV 单值；其它数组 → 重复 key。
  timeout: 30_000,
  paramsSerializer: serializeParamsV2,
});

/**
 * 专用 refresh 客户端（v2）：无任何拦截器，仅给 /api/v2/iam/refresh 用。
 *
 * 为什么独立一份：响应拦截器里"40102 → 调 refreshTokens"如果走 `api` 实例，
 * refreshTokens 失败 → 抛 ApiError → 又进响应拦截器 → 又触发 refresh 逻辑 → 递归。
 * 用裸实例把 /iam/refresh 隔离在拦截器之外。
 */
export const refreshClient = axios.create({
  baseURL: '/api/v2',
  timeout: 30_000,
  // 与 `api` 保持一致序列化策略（虽然 /iam/refresh 通常无 query，
  // 但万一 future 加 query 参数就走 V2 不踩坑）
  paramsSerializer: serializeParamsV2,
});

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

function isEnvelope(v: unknown): v is ApiEnvelope<unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as ApiEnvelope<unknown>).code === 'number' &&
    'message' in (v as ApiEnvelope<unknown>) &&
    'data' in (v as ApiEnvelope<unknown>)
  );
}

// ===== storage helpers =====
function readToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { token?: string };
    return s?.token ?? null;
  } catch {
    return null;
  }
}

function readRefreshToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { refresh_token?: string | null };
    return s?.refresh_token ?? null;
  } catch {
    return null;
  }
}

/** 读 localStorage 里**完整**的一对 token（登录 / refresh 写盘的三个字段）。
 *
 *  供跨标签页互斥的「早退复用」用（见 withRefreshLock 上方注释）：返回形状与
 *  `/iam/refresh` 的响应（`LoginResponse`）逐字段对齐，调用方不必区分「这是网络来的
 *  新 token」还是「这是别的标签页刚写进去的 token」，也不会因为早退返回 null 让调用方
 *  炸掉。`user` 是登录时的快照，早退路径只用来取 token 字段。 */
function readStoredSession(): LoginResponse | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<LoginResponse>;
    if (!s.token || !s.refresh_token) return null;
    return { token: s.token, refresh_token: s.refresh_token, user: s.user as CurrentUser };
  } catch {
    return null;
  }
}

/**
 * 把新一对 token 写回 localStorage，并通知 useAuthStore 更新 state。
 * 不直接 import useAuthStore（会引入循环依赖），走 CustomEvent 解耦。
 * 2026-09-26：监听器从 useAuthSession 模块级 listener 迁到 useAuthStore 的 setup
 * 回调里；行为一致（refresh 成功后 store 自动同步 user/token/refreshToken）。
 */
function persistTokens(pair: LoginResponse): void {
  let cur: { token: string; refresh_token: string | null; user: unknown } = {
    token: '',
    refresh_token: null,
    user: null,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) cur = { ...cur, ...JSON.parse(raw) };
  } catch {
    /* 损坏的 storage 当空对象处理 */
  }
  cur.token = pair.token;
  cur.refresh_token = pair.refresh_token;
  cur.user = pair.user;
  // 2026-10-09：写盘包 try/catch。隐私模式 / 存储被站点策略禁用时 setItem 抛
  // SecurityError，原来会把整条 refresh 链（含 getOrCreateRefresh 的 finally）炸掉，
  // 连 WS 的 'auth:session-changed' 都发不出去 —— 长连接会一直握着一枚已被 rotation
  // 拉黑的旧 token 反复握手。写失败只丢「跨标签页共享」这一份内存态，不影响本标签页。
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  } catch {
    /* 存储不可用：见上方注释 */
  }
  window.dispatchEvent(new CustomEvent('auth:tokens-refreshed', { detail: pair }));
  // 长连接层（api/dashboard.ts 的 WS 单例）的 auth 转换事件。
  // 刷新后 WS URL 里的 token 必须换成新的，否则下一次重连会拿刚被 refresh
  // rotation 拉黑的旧 jti 去握手 → 40105 死循环。
  // 与上面的 'auth:tokens-refreshed' 并存、职责不同：后者给 useAuthStore 同步自身
  // state（token / user / refreshToken），本事件只给 WS 层重算 URL。
  window.dispatchEvent(new CustomEvent('auth:session-changed', { detail: { token: pair.token } }));
  // 2026-10-09 新增：起 access token 保活定时器。**顺序敏感** —— 必须排在上面那句
  // localStorage.setItem 之后，armKeepalive() 现读 storage 里的 exp 才拿得到新值。
  ensureAccessTokenKeepalive();
}

// ===== token 自动刷新状态 =====
let refreshPromise: Promise<LoginResponse> | null = null;
let cachedAccessExp: number | null = null;
let lastProactiveFireMs = 0;

/** 剩余寿命 < 该秒数就触发 proactive 刷新。 */
const REFRESH_AHEAD_SECONDS = 5 * 60;
/** proactive 节流：30s 内最多触发一次（避免短时间内连续刷新）。 */
const PROACTIVE_THROTTLE_MS = 30_000;

/**
 * 实际执行 refresh：读 localStorage 里的 refresh_token，调 /iam/refresh，
 * 把新一对 token 写回 storage（persistTokens）。
 *
 * 失败抛 ApiError；调用方（拦截器）负责 dispatch auth:logout。
 */
async function doRefresh(): Promise<LoginResponse> {
  const rt = readRefreshToken();
  if (!rt) {
    throw new ApiError(40103, 'no refresh token');
  }
  const fresh = await refreshTokens(rt);
  persistTokens(fresh);
  cachedAccessExp = decodeJwt(fresh.token)?.exp ?? null;
  return fresh;
}

/**
 * 跨标签页互斥锁名：把「读 storage → 发 refresh → 写回」整段圈成临界区。
 *
 * 2026-10-09 变更缘由（这是必须**互斥**、不是「缩小窗口」的原因）：
 *   - 后端 refresh token 是**一次性轮转**：`complete_refresh()` 会把刚用掉的 refresh jti
 *     写进黑名单；
 *   - 任何一处再拿**已用过的那枚 refresh jti** 去 refresh，后端命中 reuse detection ⇒
 *     返 40105 **并连带 `delete_all_user_sessions(user_id)`**，即该用户**所有标签页 +
 *     所有设备**一起登出。
 *   - 窗口必然存在：新加的 access token 保活定时器按 `exp − 300s` 这个**确定性时刻**
 *     排期，同一账号的多个标签页共享同一份 `localStorage.auth_session` 与同一个 exp
 *     ⇒ 定时器落在同一时刻（双屏同时可见时相差几毫秒；后台标签页被冻结后一起解冻更是
 *     同时触发）。而 `refreshPromise` 只是**标签页内**的模块变量，跨标签页没有任何互斥
 *     ⇒ A、B 几乎同时用同一枚 R0 发起 `/iam/refresh`，后到者撞黑名单 → 全端登出。
 *     窗口宽度 = 一次 `/iam/refresh` 的 RTT，与两定时器的触发抖动同量级，这不是低概率
 *     竞态而是常规路径。
 *
 *  锁内两道闸（第二道是「白跑一趟」而不是「撞黑名单」）：
 *   ① `navigator.locks` 的排他锁由浏览器在**同源 browsing context 之间**强制，第二个
 *      标签页的回调在第一个释放前根本不会执行 ⇒ 结构上不存在「两个标签页同时持有同一枚
 *      refresh token」；
 *   ② 拿到锁后**先现读 storage**：access token 剩余寿命已大于 REFRESH_AHEAD_SECONDS 时
 *      说明别的标签页刚轮转过，直接复用 storage 里那对新 token 返回、不发请求。
 *
 *  覆盖范围：互斥包在 `getOrCreateRefresh()` 这一层 ⇒ reactive 40102 重试、proactive
 *  刷新、保活定时器三条触发路径一并被覆盖（此前只有标签页内的 `refreshPromise` 雪崩
 *  队列，跨标签页无保护）。
 *
 *  浏览器支持：Web Locks API 自 Safari 15.4 / Chrome 69 / Firefox 96 起可用，2026 年的
 *  基线浏览器都可依赖，但只在**安全上下文**（https / localhost）可用 —— 纯 http 的局域网
 *  部署上 `navigator.locks` 是 undefined，走下面的降级分支（直接执行，**降级只是尽力**，
 *  仍存在上面那个并发窗口，不要当成等价路径）。
 *  **部署前提（给运维判断用）**：本保护在非安全上下文下形同虚设。`nginx.conf` 同时
 *  `listen 80` 与 `listen 443 ssl`（443 需人工配证书），现场若以
 *  `http://192.168.x.x:8080` 这类纯 http 地址访问，`navigator.locks` 为 undefined ⇒ 保护
 *  退化为「尽力」，跨标签页并发 refresh 的窗口仍然存在（表现为偶发的「该用户所有设备
 *  一起登出」）。要让保护真正生效，现场必须走 https（或 localhost）。
 *
 *  代价：拿到锁之前调用方要等（reactive 40102 路径会 await 这条 promise），最坏是别的标签页
 *  那一次 `/iam/refresh` 的 RTT。换来的是「不会把该用户所有设备一起踢下线」，划算。
 */
const REFRESH_LOCK_NAME = 'hsh-erp:token-refresh';

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.request) {
    // 降级：无跨标签页互斥（安全上下文之外 / 老浏览器，见上方注释里的部署前提）。
    return fn();
  }
  // 类型参数显式给 `Promise<T>`：lib.dom 把 LockGrantedCallback<T> 的返回类型声明成
  // 单纯的 T（漏了 PromiseLike<T>），而真实 API 会 await 回调返回的 promise —— 交给
  // 本函数的 `await` 摊平这一层。
  return await locks.request<Promise<T>>(REFRESH_LOCK_NAME, { mode: 'exclusive' }, () => fn());
}

/** 临界区内的 refresh：先现读 storage，别的标签页刚轮转过就直接复用（不发请求）。 */
async function doRefreshUnderLock(): Promise<LoginResponse> {
  const stored = readStoredSession();
  if (stored) {
    const exp = decodeJwt(stored.token)?.exp ?? null;
    if (exp !== null && exp - Math.floor(Date.now() / 1000) > REFRESH_AHEAD_SECONDS) {
      // storage 里的 access token 还很新 ⇒ 另一个标签页已经轮转过了。复用它，避免
      // 拿可能已进黑名单的旧 refresh jti 去撞 reuse detection。
      cachedAccessExp = exp;
      return stored;
    }
  }
  return doRefresh();
}

/**
 * 雪崩队列（**标签页内**）：第一个 40102 触发 refresh，后续 40102 复用同一个 promise；
 * 完成后清空（setTimeout 让微任务队列里的消费者先看到结果）。
 *
 *  标签页内的去重**不能**替代跨标签页互斥 —— 后者的理由见 withRefreshLock 上方注释。
 */
function getOrCreateRefresh(): Promise<LoginResponse> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        return await withRefreshLock(doRefreshUnderLock);
      } finally {
        setTimeout(() => {
          refreshPromise = null;
        }, 0);
      }
    })();
  }
  return refreshPromise;
}

/** Proactive：每次成功响应后检查 exp，剩余 < 5min 就 fire-and-forget 刷新。
 *  **它只在成功响应拦截器里被调**，因此天然依赖 HTTP 流量 —— 空闲页面（大屏零轮询、
 *  无操作无请求）一次都不会跑。access token 保活由下面的 armKeepalive 定时器兜。 */
function maybeProactiveRefresh(): void {
  if (cachedAccessExp === null) {
    const t = readToken();
    if (!t) return;
    cachedAccessExp = decodeJwt(t)?.exp ?? null;
    if (cachedAccessExp === null) return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedAccessExp - nowSec > REFRESH_AHEAD_SECONDS) return;
  if (Date.now() - lastProactiveFireMs < PROACTIVE_THROTTLE_MS) return;
  lastProactiveFireMs = Date.now();
  void getOrCreateRefresh().catch(() => {
    /* reactive 路径会兜底；这里只 fire-and-forget */
  });
}

// ===== access token 保活定时器（2026-10-09 新增）=====
//
// 为什么必须有它：`maybeProactiveRefresh()` 的唯一调用点是成功响应拦截器
// （envelopeResponseInterceptor），也就是**只有 HTTP 流量才会续命**。而空闲的大屏
// 零 HTTP 流量（3 个 dashboard query 都没有 refetchInterval；staleTime 只决定
// 「下次取数是否放行」，不产生任何定时器），用户放在一边的 HMI 屏会静静看着 access
// token（默认 TTL 900s）过期：随后 dashboard WS 的周期性 re-auth 用这枚旧 token
// 重跑 verify_session_token 拿到 TOKEN_EXPIRED，被 reauth_close_code 映射成关闭码
// 4001 ⇒ 曾被前端当成「会话被吊销」直接踢回登录页（4001 的 reason 细分已让它不再
// 直接踢人，但 WS 仍会停连，正确做法是压根别让 token 过期）。
//
// 排期语义（每轮都现读 localStorage 的当前 token 的 exp）：
//   - storage 无 token / exp 解不出 ⇒ **不排期**。登出后自然停摆，不留悬挂定时器。
//   - 剩余寿命 ≤ REFRESH_AHEAD_SECONDS ⇒ 立刻 getOrCreateRefresh()；**仅成功**时按
//     新 exp 重排；已有 refresh 在飞则只重排。
//   - 否则按「剩余寿命 − REFRESH_AHEAD_SECONDS + 余量」重排，在提前量边界上留一点
//     缓冲，避免定时器早到几十毫秒、剩余寿命仍 > 阈值而空转一轮。
//
// 2026-10-09 补：失败改成**有界重试**（KEEPALIVE_RETRY_DELAYS_MS）。取舍：
//   - 不重排 ⇒ 一次网络抖动就让整条保活链对本会话永久失效，直到下一次 HTTP 流量
//     （reactive 40102）或 WS 4001 兜底；空闲大屏恰好没有前者。而 `/iam/refresh` 走
//     `refreshClient`（**无拦截器**）⇒ 40105 不会派发 `auth:logout`，这条失败路径在前端
//     完全静默，用户只会在很久之后撞上一次「莫名其妙被踢下线」。
//   - 无限重排 ⇒ 后端持续不可用时变成请求风暴。故取 2 次退避重试后彻底放弃（放弃时打
//     一行 warn，让「保活链已死」在控制台可见），后续仍由 reactive 40102 / WS 4001 兜底。
//
// 测试环境安全：本仓 vitest 默认 environment: 'node'，模块级 setTimeout 若不处理会拖慢
// 甚至挂住 `vitest run` 进程。排期后对句柄做可选 unref()（Node Timeout 有 unref，
// 浏览器返回 number 没有，故用可选调用）+ 导出 resetKeepaliveForTest() 供 spec 拆表。

/** 提前量之外的缓冲：定时器早到也不至于落在阈值内空转。 */
const KEEPALIVE_SLACK_SECONDS = 5;
/** 已有 refresh 在飞时的重排间隔：沿用 proactive 节流档，避免保活跟着抢跑。 */
const KEEPALIVE_BUSY_RETRY_MS = 30_000;
/** 刷新失败后的退避重试间隔（用尽即放弃，见上方取舍说明）。 */
const KEEPALIVE_RETRY_DELAYS_MS = [30_000, 120_000];

/** 当前挂着的保活定时器句柄；null = 没排期。 */
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
/** 已消耗的重试次数；只在 `ensureAccessTokenKeepalive()`（新一轮链）时归零。 */
let keepaliveRetryCount = 0;

function cancelKeepalive(): void {
  if (keepaliveTimer === null) return;
  clearTimeout(keepaliveTimer);
  keepaliveTimer = null;
}

/** 挂一轮保活定时器；node 环境下顺带 unref（不阻塞 vitest 进程退出）。 */
function scheduleKeepalive(delayMs: number): void {
  keepaliveTimer = setTimeout(() => {
    keepaliveTimer = null;
    armKeepalive();
  }, delayMs);
  (keepaliveTimer as { unref?: () => void }).unref?.();
}

/** 刷新失败后的退避重试；次数用尽则放弃并打一行 warn。 */
function scheduleKeepaliveRetry(): void {
  const delay = KEEPALIVE_RETRY_DELAYS_MS[keepaliveRetryCount];
  if (delay === undefined) {
    console.warn(
      '[auth] access token 保活刷新连续失败，已放弃自动续期；后续靠 HTTP 40102 reactive 刷新或 WS 4001 兜底',
    );
    return;
  }
  keepaliveRetryCount += 1;
  scheduleKeepalive(delay);
}

/** 排一轮保活；无有效 token 时什么都不做（自然停摆）。 */
function armKeepalive(): void {
  cancelKeepalive();
  const token = readToken();
  const exp = token === null ? null : (decodeJwt(token)?.exp ?? null);
  if (token === null || exp === null) return;

  const remainSec = exp - Math.floor(Date.now() / 1000);
  if (remainSec <= REFRESH_AHEAD_SECONDS) {
    // 已有 refresh 在飞（reactive 40102 或本保活自己触发的）就只重排、不抢跑。
    // 必须挡这道：persistTokens 是在 doRefresh 内部被调的，它会重入本函数；若此处
    // 再发一次 getOrCreateRefresh，在 refreshPromise 被清空前拿到的是同一条在飞的
    // promise，链式排下去就是一段不产生网络请求的自旋。
    if (refreshPromise !== null) {
      scheduleKeepalive(KEEPALIVE_BUSY_RETRY_MS);
      return;
    }
    void getOrCreateRefresh().then(
      () => {
        // 成功：persistTokens 已写入新 token 并重新起表，这里只需按新 exp 再排一轮
        //（persistTokens 内部其实已经起过一次，本轮是幂等重排，多余的一次无害）。
        armKeepalive();
      },
      () => {
        scheduleKeepaliveRetry();
      },
    );
    return;
  }

  // 提前量边界上留一点缓冲，避免定时器早到几十毫秒、剩余寿命仍 > 阈值而空转一轮。
  scheduleKeepalive((remainSec - REFRESH_AHEAD_SECONDS + KEEPALIVE_SLACK_SECONDS) * 1000);
}

/**
 * 确保 access token 保活定时器在跑（幂等：每次都先拆旧表再按当前 exp 重排）。
 *
 * 起表点共 **4** 个，判据是「本会话的 access token 从哪来」—— 每条把 token 落到
 * localStorage（或把它作废）的路径都要覆盖，漏一条就有一种会话静默失去保活：
 *   1. `persistTokens()`（本文件）—— refresh 成功后写盘，紧接着起表；
 *   2. `stores/auth.ts` 的 `saveToStorage()` —— 登录成功写盘后起表。**登录不经过
 *      persistTokens**（那条只在 doRefresh 里被调），故必须单列一个起表点；
 *   3. `stores/auth.ts` 的 `loadFromStorage()` —— 刷新浏览器恢复会话。这条路径只读
 *      storage、同样不经过 persistTokens，只由 app 启动时读 storage 恢复 session；
 *   4. `stores/auth.ts` 的 `teardownSession()` —— 会话终止后调它**拆表**（storage 里
 *      已无 token ⇒ armKeepalive 走「不排期」分支，幂等且不留悬挂定时器；否则登出后
 *      最多还有一枚定时器挂着直到 TTL 结束，约 10 分钟）。
 *
 * `stores/auth.ts` 的 `initDummyAuth()` 不在此列：它只写内存、刻意不写 localStorage
 * （避免下次非 dummy 启动时被 loadFromStorage 复活），没有 token 落盘就没有起表对象。
 *
 * 起表即视为「新一轮链」⇒ 重试计数归零；退避重试走的是 scheduleKeepalive，不经过
 * 本函数，故不会把重试序列自己清掉。
 */
export function ensureAccessTokenKeepalive(): void {
  keepaliveRetryCount = 0;
  armKeepalive();
}

/** 测试专用：拆掉当前保活定时器（spec 在 afterEach 调用，避免跨用例泄漏）。 */
export function resetKeepaliveForTest(): void {
  cancelKeepalive();
  keepaliveRetryCount = 0;
}

// ===== 拦截器（具名）=====

/** 请求拦截：挂 Authorization。 */
function authRequestInterceptor(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const token = readToken();
  if (token) {
    // 用 .set 避免某些 axios 版本对 headers 直接赋值的 readonly 警告。
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
}

/**
 * 响应拦截：解 `{code, message, data}` 信封 → 调用方拿到的是裸 data；
 * 非标准响应（如文件 blob / 文本）原样返回。每次成功响应都触发
 * maybeProactiveRefresh（剩余寿命 < 5min 后台 fire-and-forget 刷新）。
 */
function envelopeResponseInterceptor(response: AxiosResponse): AxiosResponse {
  const payload = response.data;
  if (isEnvelope(payload)) {
    if (payload.code !== 0) {
      throw new ApiError(payload.code, payload.message, response);
    }
    // 直接把 response.data 替换成解封后的 data，保持 `api.get<T>()` 的 .data 语义。
    response.data = payload.data;
  }
  // 非标准响应（如文件 blob / 文本）原样返回
  maybeProactiveRefresh();
  return response;
}

/**
 * 错误拦截工厂：blob body 解析 → 40102 自动 refresh + 重试 → refresh 失败
 * dispatch auth:logout。
 *
 * 用工厂 + 闭包持有 client，是为了让重试走 `client.request(retryCfg)` 而不是模块级
 * `api`，调用方即使换实例接线也不会让重试落到另一条拦截器链上。
 */
function makeEnvelopeErrorInterceptor(client: AxiosInstance) {
  return async (error: AxiosError) => {
    // blob 响应的 error body 也是 Blob；isEnvelope(blob) 返回 false 会让
    // 401 自动刷新失效。先把 Blob body 读成文本再尝试 JSON parse。
    let payload: unknown = error.response?.data;
    if (payload instanceof Blob) {
      try {
        const text = await payload.text();
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
    }
    if (!isEnvelope(payload)) {
      throw new ApiError(
        error.response?.status ?? 0,
        error.message || 'network error',
        error.response,
      );
    }

    const apiErr = new ApiError(payload.code, payload.message, error.response);
    const cfg = error.config as
      (InternalAxiosRequestConfig & { _isRetryAfterRefresh?: boolean }) | undefined;

    // 40105 SESSION_REVOKED：JWT 签名仍有效，但 Redis session:tok:<sha256>
    // 已被吊销（其它设备 logout / 改密 / 管理员停用）。refresh 也救不回（同一 session
    // 索引会被连带清掉），直接 dispatch auth:logout 跳登录，不再走下方 40102 的
    // reactive refresh 分支。
    if (apiErr.code === 40105) {
      window.dispatchEvent(new CustomEvent('auth:logout'));
      throw apiErr;
    }

    // 仅在 access 过期且非 refresh 重试时触发自动刷新。
    const shouldRefresh = apiErr.code === 40102 && cfg && !cfg._isRetryAfterRefresh;

    if (!shouldRefresh) throw apiErr;

    try {
      const fresh = await getOrCreateRefresh();
      // 用新 token 重试原请求；标记 _isRetryAfterRefresh 防递归
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- cfg.headers 是 AxiosHeaders 实例不能 spread 成普通对象，断言为带 _isRetryAfterRefresh 标记的 InternalAxiosRequestConfig
      const retryCfg = {
        ...cfg,
        headers: {
          ...((cfg.headers as AxiosRequestHeaders | undefined) ?? {}),
          Authorization: `Bearer ${fresh.token}`,
        },
        _isRetryAfterRefresh: true,
      } as InternalAxiosRequestConfig & { _isRetryAfterRefresh?: boolean };
      // 用闭包持有的 client 重试，避免递归回本拦截器
      return await client.request(retryCfg);
    } catch (refreshErr) {
      // refresh 失败：触发全局登出事件，main.ts 监听后 router.replace('/login')
      // 2026-10-02 补注：另有第二个订阅方 stores/auth.ts（清会话状态 + queryClient.clear()），
      // 详见 CLAUDE.md「`auth:logout` 是订阅点不是派发点」条目。
      window.dispatchEvent(new CustomEvent('auth:logout'));
      throw refreshErr;
    }
  };
}

// 全站唯一带拦截器的实例（refreshPromise 模块单例防雪崩）
api.interceptors.request.use(authRequestInterceptor);
api.interceptors.response.use(envelopeResponseInterceptor, makeEnvelopeErrorInterceptor(api));

/** 业务异常：code !== 0 时抛出；调用方用 try/catch + (e as ApiError).code 取错误码。 */
export class ApiError extends Error {
  public readonly code: number;
  public readonly response: unknown;

  public constructor(code: number, message: string, response?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.response = response;
  }

  /** 是否为"未登录 / token 失效"——由调用方决定如何处理（路由跳转 / 重新登录）。 */
  public get isAuthError(): boolean {
    // 40105 SESSION_REVOKED：JWT 签名有效但 Redis session 已被吊销。语义上等同
    // "未登录"，调用方应清 session 跳登录；拦截器内已经 dispatch auth:logout，
    // 这里只是让业务侧可以分支识别这一类。
    return this.code === 40101 || this.code === 40102 || this.code === 40103 || this.code === 40105;
  }
}

/**
 * 移除值为 undefined / null / 空字符串 / 空数组的 query 字段；保留数字 0 和布尔 false。
 *
 * 给 list 类接口（GET /xxx?a=1）用——后端对 '' 会做 LIKE '%%'（导致全量匹配），
 * axios 默认只 strip undefined / null，不 strip '' / []。把这一步抽到统一的
 * api/http.ts 里，9 个 list API 共享一份行为（2026-08-25 refactor）。
 *
 * 2026-09-21：本轮参数收紧**未动**本函数。泛型约束 `<T extends Record<string, any>>`
 * 不能改为 `Record<string, unknown>` —— ListPartsParams / AssemblyListQuery /
 * ListUsersParams / ListShelvesParams / ListWorkersParams 这类 interface 形参
 * 缺字符串 index signature，不满足 `Record<string, unknown>` 约束，5 处调用点会
 * 全报 TS2345（已在 2026-08-25 refactor 注释里记录原因）。`Record<string, any>`
 * 实际等价于任意 object 字面量 / interface，是 TS 在此场景下唯一不破坏调用方的
 * 收窄档位。
 */

export function cleanParams<T extends Record<string, any>>(obj?: T): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}
