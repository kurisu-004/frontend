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
//       - proactive：每次成功响应都看一眼 exp，剩余 < 5min 就后台 fire-and-forget 刷新。
//    c) 雪崩防御：模块级 refreshPromise 队列，并发 40102 只触发一次 /iam/refresh。
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
// 4) 打印端点（4 个，2026-10-03 起由 rust 鉴权后转发 python，前端路径与调用签名不变）：
//    - POST /delivery-notes/{id}/print           ← printNote
//    - POST /delivery-notes/{id}/print-labels    ← printNoteLabels
//    - GET  /parts/{id}/print-drawing            ← printPartDrawing
//    - POST /parts/print-drawing-batch           ← printPartDrawingBatch
//    响应是文件 blob（不是信封），文件名靠 `Content-Disposition`；这些路径在 rust 侧
//    放宽了读超时（批量拼接 PDF 耗时可达分钟级），前端批量端点单独把 axios timeout
//    提到 10 分钟与之对齐。

import type { AxiosError } from 'axios';
import axios, {
  type AxiosInstance,
  type AxiosRequestHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { decodeJwt } from '@/utils/jwt';
import { refreshTokens, type LoginResponse } from '@/api/iam';

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  window.dispatchEvent(new CustomEvent('auth:tokens-refreshed', { detail: pair }));
  // 2026-10-01 新增：长连接层（api/dashboard.ts 的 WS 单例）的 auth 转换事件。
  // 刷新后 WS URL 里的 token 必须换成新的，否则下一次重连会拿刚被 refresh
  // rotation 拉黑的旧 jti 去握手 → 40105 死循环。
  // 与上面的 'auth:tokens-refreshed' 并存、职责不同：后者给 useAuthStore 同步自身
  // state（token / user / refreshToken），本事件只给 WS 层重算 URL。
  window.dispatchEvent(
    new CustomEvent('auth:session-changed', { detail: { token: pair.token } }),
  );
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
 * 雪崩队列：第一个 40102 触发 doRefresh，后续 40102 复用同一个 promise；
 * 完成后清空（setTimeout 让微任务队列里的消费者先看到结果）。
 */
function getOrCreateRefresh(): Promise<LoginResponse> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        return await doRefresh();
      } finally {
        setTimeout(() => {
          refreshPromise = null;
        }, 0);
      }
    })();
  }
  return refreshPromise;
}

/** Proactive：每次成功响应后检查 exp，剩余 < 5min 就 fire-and-forget 刷新。 */
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
