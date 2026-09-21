// 统一 HTTP 客户端（axios 封装）。
//
// 五件事：
// 1) 业务 `api` baseURL = `/api/v2`：2026-09-15 Phase 5 一次性切 v2（backend-rust 主仓）；
//    v1 Python FastAPI 仅保留 4 个打印端点（见下文 `apiPrint`）。
// 2) 请求拦截：自动从 localStorage['auth_session'] 取 token，挂 `Authorization: Bearer <token>`。
// 3) 响应拦截：
//    a) 解 `{code, message, data}` 信封 → 调用方拿到的是原始 data。
//    b) token 自动刷新：
//       - reactive：收到 40102（access 过期）→ 调 /iam/refresh 换新 token → 重试原请求；
//       - proactive：每次成功响应都看一眼 exp，剩余 < 5min 就后台 fire-and-forget 刷新。
//    c) 雪崩防御：模块级 refreshPromise 队列，并发 40102 只触发一次 /iam/refresh。
//    d) code !== 0 → 抛 `ApiError(code, message)`，调用方用 try/catch 即可拿到业务错误码。
//
// 4) `refreshClient`：无任何拦截器的裸 axios 实例（baseURL `/api/v2`），专门给
//    /api/v2/iam/refresh 用，避免响应拦截器里的 40102 → refresh 链路递归触发。
//    失败兜底：refresh 失败 → dispatchEvent('auth:logout')，由 main.ts 监听后
//    router.replace('/login')。session 失效的统一入口。
//
// 5) 【2026-09-15 新增】`apiPrint`（baseURL `/api/v1`）：v1 Python FastAPI 上 4 个
//    打印端点的专用客户端，**与业务 `api` 共享同一组拦截器**——token / refresh / 信封
//    解封 / 40102 自动 refresh 全套复用。
//    - POST /delivery-notes/{id}/print           ← printNote
//    - POST /delivery-notes/{id}/print-labels    ← printNoteLabels
//    - GET  /parts/{id}/print-drawing            ← printPartDrawing
//    - POST /parts/print-drawing-batch           ← printPartDrawingBatch
//    业务端点全部走 `api`（v2），仅这 4 个打印端点走 `apiPrint`（v1）。
//
// 【历史迁移】
// - 2026-08-21：首次引入 `apiV2`（baseURL `/api/v2`），与 `api` 并存（v1 业务为主，少量 v2）。
// - 2026-09-14：auth 域切 v2（`apiV2` / `refreshClientV2`）。
// - 2026-09-15 Phase 5：业务全切 v2 → 删除 `apiV2` / `refreshClientV2`，合入 `api` /
//   `refreshClient`（baseURL `/api/v2`）；新增 `apiPrint`（baseURL `/api/v1`）专供
//   4 个打印端点。
// - 2026-09-15 hotfix：Phase 5 误合并 `serializeParamsV2` 引入 regression——v2 端点
//   `GET /api/v2/parts?statuses=...` 用重复 key 形式后端 axum 解析失败返 400。
//   恢复 2026-08-29 的 CSV 白名单拆分：`api` / `refreshClient` 绑 `serializeParamsV2`
//   （白名单 `statuses` 等数组 → CSV 单值）；`apiPrint` 维持 `serializeParamsV1`
//   （FastAPI 期望重复 key）。
//
// 【2026-08-29 拆分 → Phase 5 误合并 → 2026-09-15 hotfix 还原】
//   - v1 FastAPI 期望所有数组 → 重复 key 形式 `?k=a&k=b`；
//   - v2 Rust axum `statuses`（Vec<String>）期望 CSV 单值 `?statuses=a,b`（axum 的
//     Query 反序列化器对 Vec<T> 默认按 `,` 分隔，对 `?k=a&k=b` 行为依赖实现）。
//   两边语义不一致，**不能合并**——CSV 白名单机制恢复（ARRAY_AS_CSV_KEYS 白名单 +
//   serializeParamsWith 共用实现 + serializeParamsV1/V2 两条具名导出）。
// - 2026-09-17 PR-4 同步：backend-rust PartListQuery 加 `locations` / `holder_ids`
//   两个 `Option<String>`（逗号分隔单值）。前端 wire-format 必须同步：把这两个
//   key 加入 `ARRAY_AS_CSV_KEYS` 白名单，编码 `?locations=A%2CB&holder_ids=X%2CY`。
//   与 `statuses` 同走 CSV 单值路径。详见 `ARRAY_AS_CSV_KEYS` 注释。

import type { AxiosError } from 'axios';
import axios, {
  type AxiosInstance,
  type AxiosRequestHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { decodeJwt } from '@/utils/jwt';
import { refreshTokens, type LoginResponse } from '@/api/iam';

// 2026-09-21 params 收紧：serializeParamsWith / serializeParamsV1 / serializeParamsV2 /
// serializeParams 别名的 params 由 `any` 收紧为 `Record<string, unknown>`，与 axios 自身
// `paramsSerializer: (params: any) => string` 的契约解耦（axios 是 JS 不查，
// 但 TS 端能收窄就收窄）。Array.isArray 后 val 仍是 unknown，需要逐元素 `as string`
// 才能喂 encodeURIComponent——集中在这条注释提示，不再每处重复。
//
// cleanParams 是已知例外：泛型 `<T extends Record<string, unknown>>` 会让
// ListPartsParams / AssemblyListQuery / ListUsersParams / ListShelvesParams /
// ListWorkersParams 这类 interface 形参在调用处报 TS2345（interface 缺字符串 index
// signature，不满足 `Record<string, unknown>` 约束）。原注释已说明，保留
// `<T extends Record<string, any>>` 不动；本轮统一收紧跳过此函数。

/**
 * v2 后端期望多值筛选走 CSV 单值形式（`?statuses=A,B`）的 key 白名单。
 *
 * 2026-09-15 Phase 5 误合并后回归：原 `serializeParamsV2`（CSV 白名单）被删除，
 * 统一用 `serializeParamsV1`（数组重复 key）→ 前端 `GET /api/v2/parts?statuses=A&statuses=B`
 * 后端 axum 解析失败返 400 Bad Request，UI 打开 /parts 直接白屏。本 hotfix 恢复 CSV
 * 白名单机制：`statuses`（及未来其它 v2 多值筛选字段）数组 → CSV 单值，
 * 其它数组仍走重复 key（v1 端点 + v2 未列入白名单的数组字段都靠这条分支）。
 *
 * 2026-09-17 PR-4 同步：backend-rust PartListQuery 加 `locations` + `holder_ids`
 * 两个 `Option<String>`（逗号分隔字符串，与 `statuses` 同形）。前端不加入白名单会
 * 触发 backend axum 解析失败：`?locations=A&locations=B` → Query<String> 单值
 * 解析失败（axum::extract::Query<Option<String>> 只取第一个值或报错）；CSV
 * 编码 `?locations=A%2CB` 才是正确 wire-format。`holder_ids` 同理（后端
 * service 层把 CSV 拆 Vec<i64>，parse 失败 → 40001 VALIDATION_ERROR）。
 *
 * 历史脉络（不要回退）：
 * - 2026-08-29 拆分原因：v1 Python FastAPI 期望所有数组 → 重复 key，v2 Rust axum 的
 *   `statuses` 期望 CSV 单值（axum Query 反序列化器对 Vec<T> 默认按 `,` 分隔，对 `?k=a&k=b`
 *   形式的反序列化行为依赖实现，可能只取首元素或报错，必须按后端期望的格式发）。
 * - 当前 v2 schema 决定保留 `statuses` 为多值（Vec<String>），所以 CSV 白名单机制恢复。
 * - 2026-09-17 PR-4：locations / holder_ids 加入白名单，wire-format 与 backend
 *   PartListQuery 单值 String 解析对齐。
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
        // 重复 key：每个元素独立 push（v1 端点 / v2 非白名单数组字段）
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

/** v1 专用 query 序列化器：所有数组走重复 key 形式 `?k=a&k=b`。
 *  专供 `apiPrint`（baseURL `/api/v1`）使用，匹配 Python FastAPI Query 解析语义。 */
export function serializeParamsV1(params: Record<string, unknown>): string {
  return serializeParamsWith(params, new Set());
}

/** v2 专用 query 序列化器：白名单内 key（`statuses` / `locations` / `holder_ids`
 *  等）走 CSV 单值 `?k=a%2Cb`，其它数组维持重复 key。专供 `api` / `refreshClient`
 *  （baseURL `/api/v2`）使用，匹配 Rust axum Query 反序列化对 Vec<T> 的 CSV 期望。
 *
 *  2026-09-17 PR-4 同步：locations / holder_ids 加入 `ARRAY_AS_CSV_KEYS`，与
 *  backend-rust `PartListQuery`（`Option<String>` 逗号分隔）解析对齐。 */
export function serializeParamsV2(params: Record<string, unknown>): string {
  return serializeParamsWith(params, ARRAY_AS_CSV_KEYS);
}

/** @deprecated 等价于 serializeParamsV1。2026-08-29 起作为 alias 保留，供历史
 *  import 不至于崩；新代码请用具名 V1 / V2。 */
export const serializeParams: (params: Record<string, unknown>) => string = serializeParamsV1;

const STORAGE_KEY = 'auth_session';

// ===== 业务客户端（v2，2026-09-15 起为默认）=====
export const api = axios.create({
  baseURL: '/api/v2',
  // 不显式设 Content-Type：axios 会按 body 类型自动选 application/json / multipart/form-data。
  // paramsSerializer 走 V2：白名单 key（statuses 等）数组 → CSV 单值；其它数组 → 重复 key。
  // 2026-09-15 Phase 5 曾误用 V1，导致 v2 axum 反序列化 `?statuses=A&statuses=B` 失败返 400。
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
  // 业务 v2 客户端，与 `api` 保持一致序列化策略（虽然 /iam/refresh 通常无 query，
  // 但万一 future 加 query 参数就走 V2 不踩坑）
  paramsSerializer: serializeParamsV2,
});

// ===== 打印专用客户端（v1，2026-09-15 Phase 5 新增）=====
/**
 * 打印 4 端点专用客户端（baseURL `/api/v1`）：与业务 `api` 共享同一组拦截器
 * （token / refresh / 信封解封 / 40102 自动 refresh）。仅 4 个打印端点走它：
 *   - POST /delivery-notes/{id}/print           ← printNote
 *   - POST /delivery-notes/{id}/print-labels    ← printNoteLabels
 *   - GET  /parts/{id}/print-drawing            ← printPartDrawing
 *   - POST /parts/print-drawing-batch           ← printPartDrawingBatch
 *
 * 为什么不并入 `api`：v1 Python 仍维护这 4 端点；后续若打印也迁 v2 再统一。
 * 为什么不另外写一份拦截器：与 `api` 共用模块单例 `refreshPromise`，并发撞 40102
 * 只触发一次 /iam/refresh；打印流与业务流是同 token / 同 user，refresh 共享无副作用。
 */
export const apiPrint = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
  paramsSerializer: serializeParamsV1,
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
 * 把新一对 token 写回 localStorage，并通知 useAuthSession 更新 module-level refs。
 * 不直接 import useAuthSession（会引入循环依赖），走 CustomEvent 解耦。
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

// ===== 拦截器（具名，api / apiPrint 复用）=====

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
 * 用工厂 + 闭包持有 client，是为了让 api / apiPrint 各自 `client.request(retryCfg)`
 * 在自己实例上重试，不被另一实例的拦截器链干扰。refreshPromise 等雪崩状态
 * 仍是模块单例，两实例并发撞 40102 只触发一次 /iam/refresh。
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

    // 40105 SESSION_REVOKED（v2 才有）：JWT 签名仍有效，但 Redis session:tok:<sha256>
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
      // 用闭包持有的 client 重试——api 实例回到 api.request，apiPrint 回到 apiPrint.request
      return await client.request(retryCfg);
    } catch (refreshErr) {
      // refresh 失败：触发全局登出事件，main.ts 监听后 router.replace('/login')
      window.dispatchEvent(new CustomEvent('auth:logout'));
      throw refreshErr;
    }
  };
}

// 业务 v2 与打印 v1 共享同一组拦截器（refreshPromise 模块单例防雪崩）
api.interceptors.request.use(authRequestInterceptor);
api.interceptors.response.use(envelopeResponseInterceptor, makeEnvelopeErrorInterceptor(api));
apiPrint.interceptors.request.use(authRequestInterceptor);
apiPrint.interceptors.response.use(
  envelopeResponseInterceptor,
  makeEnvelopeErrorInterceptor(apiPrint),
);

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
