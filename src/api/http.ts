// 统一 HTTP 客户端（axios 封装）。
//
// 四件事：
// 1) baseURL = `/api/v1`，所有 api/*.ts 不再写前缀。
// 2) 请求拦截：自动从 localStorage['auth_session'] 取 token，挂 `Authorization: Bearer <token>`。
// 3) 响应拦截：
//    a) 解 `{code, message, data}` 信封 → 调用方拿到的是原始 data。
//    b) 【2026-07-10 新增】token 自动刷新：
//       - reactive：收到 40102（access 过期）→ 调 /auth/refresh 换新 token → 重试原请求；
//       - proactive：每次成功响应都看一眼 exp，剩余 < 5min 就后台 fire-and-forget 刷新。
//    c) 雪崩防御：模块级 refreshPromise 队列，并发 40102 只触发一次 /auth/refresh。
//    d) code !== 0 → 抛 `ApiError(code, message)`，调用方用 try/catch 即可拿到业务错误码。
//
// 4) 【2026-07-10 新增】refreshClient：无任何拦截器的裸 axios 实例，专门给
//    /auth/refresh 用，避免响应拦截器里的 40102 → refresh 链路递归触发。
//
// 失败兜底：refresh 失败 → dispatchEvent('auth:logout')，由 main.ts 监听后
// router.replace('/login')。session 失效的统一入口。
//
// 【2026-08-21 新增】apiV2（baseURL = `/api/v2`）与 api 共享同一组拦截器；
// refreshPromise 等雪崩状态保持模块单例，v1 / v2 并发撞 40102 只触发一次
// /auth/refresh。单端点的 v2 调用不该用 `api.post('/v2/...')`，会被 baseURL
// 拼成 `/api/v1/v2/...`。
// 【2026-08-26 新增】refreshClientV2：与 refreshClient 一一对应，baseURL `/api/v2`，
// 给 /api/v2/auth/refresh 用。auth 域切 v2 后两者并存：业务走 apiV2，refresh 走
// refreshClientV2，refresh 客户端与业务 client 永远对应同版本 baseURL，避免
// 串改造成"看似生效实则打 v1"的隐患。

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { decodeJwt } from '@/utils/jwt'
import { refreshTokens, type LoginResponse } from '@/api/auth'

/**
 * 这些 key 在数组形式下需要序列化为 CSV 单值字符串（?k=a,b,c）而非
 * 重复 key 形式（?k=a&k=b&k=c）。v2 后端 Rust 期望 CSV 形式。
 * 2026-08-24 新增，与 src/api/deliveryNote.ts 切 v2 同步。
 */
const ARRAY_AS_CSV_KEYS = new Set(['statuses'])

/**
 * 把 axios params 对象序列化为 query string。
 * 白名单 key（statuses）数组 → CSV 单值；其它数组 → 重复 key 形式。
 * 暴露给单测直接调用。
 */
// params 用 any：axios 自身 paramsSerializer 签名就是 (params: any) => string，
// 这里抽出来做单测没必要收窄类型，避免 Array.isArray 后续分支里 val 没法窄化
// 成 string 让 encodeURIComponent 报 TS2345。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeParams(params: any): string {
  const parts: string[] = []
  for (const key of Object.keys(params)) {
    const val = params[key]
    if (val === undefined || val === null) continue
    if (Array.isArray(val) && ARRAY_AS_CSV_KEYS.has(key)) {
      // 白名单 key（v2 后端期望 CSV 单值形式）
      const csv = val.filter((v: unknown) => v !== '' && v != null).join(',')
      if (csv.length > 0) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(csv)}`)
      }
    } else if (Array.isArray(val)) {
      for (const v of val) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`)
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
    }
  }
  return parts.join('&')
}

const STORAGE_KEY = 'auth_session'

export const api = axios.create({
  baseURL: '/api/v1',
  // 不显式设 Content-Type：axios 会按 body 类型自动选 application/json / multipart/form-data。
  timeout: 30_000,
  // FastAPI 期望数组参数格式: ?statuses=A&statuses=B（无 [] 后缀）
  paramsSerializer: serializeParams,
})

/**
 * 专用 refresh 客户端：无任何拦截器，仅给 /auth/refresh 用。
 *
 * 为什么独立一份：响应拦截器里"40102 → 调 refreshTokens"如果走 `api` 实例，
 * refreshTokens 失败 → 抛 ApiError → 又进响应拦截器 → 又触发 refresh 逻辑 → 递归。
 * 用裸实例把 /auth/refresh 隔离在拦截器之外。
 */
export const refreshClient = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
  paramsSerializer: serializeParams,
})

/**
 * v2 refresh 客户端：baseURL `/api/v2`，其它与 refreshClient 完全一致
 * （无拦截器、paramsSerializer 同步）。
 *
 * 2026-08-26 新增：与 refreshClient 一一对应；auth 域切 v2 后 /auth/refresh
 * 走它。解耦是为避免 baseURL 串改造成"看似生效实则打 v1"的隐患——refresh 客户端
 * 永远与主业务客户端同版本。
 *
 * 2026-08-26 auth 域回滚 v1 后本实例暂无消费者（refreshTokens 改走 refreshClient）；
 * 保留供未来 v2 refresh 端点回归（业务域上 v2 时配套用），不要随手删。
 */
export const refreshClientV2 = axios.create({
  baseURL: '/api/v2',
  timeout: 30_000,
  paramsSerializer: serializeParams,
})

interface ApiEnvelope<T> {
  code: number
  message: string
  data: T
}

function isEnvelope(v: unknown): v is ApiEnvelope<unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as ApiEnvelope<unknown>).code === 'number' &&
    'message' in (v as ApiEnvelope<unknown>) &&
    'data' in (v as ApiEnvelope<unknown>)
  )
}

// ===== storage helpers =====
function readToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as { token?: string }
    return s?.token ?? null
  } catch {
    return null
  }
}

function readRefreshToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as { refresh_token?: string | null }
    return s?.refresh_token ?? null
  } catch {
    return null
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
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) cur = { ...cur, ...JSON.parse(raw) }
  } catch {
    /* 损坏的 storage 当空对象处理 */
  }
  cur.token = pair.token
  cur.refresh_token = pair.refresh_token
  cur.user = pair.user
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cur))
  window.dispatchEvent(new CustomEvent('auth:tokens-refreshed', { detail: pair }))
}

// ===== token 自动刷新状态 =====
let refreshPromise: Promise<LoginResponse> | null = null
let cachedAccessExp: number | null = null
let lastProactiveFireMs = 0

/** 剩余寿命 < 该秒数就触发 proactive 刷新。 */
const REFRESH_AHEAD_SECONDS = 5 * 60
/** proactive 节流：30s 内最多触发一次（避免短时间内连续刷新）。 */
const PROACTIVE_THROTTLE_MS = 30_000

/**
 * 实际执行 refresh：读 localStorage 里的 refresh_token，调 /auth/refresh，
 * 把新一对 token 写回 storage（persistTokens）。
 *
 * 失败抛 ApiError；调用方（拦截器）负责 dispatch auth:logout。
 */
async function doRefresh(): Promise<LoginResponse> {
  const rt = readRefreshToken()
  if (!rt) {
    throw new ApiError(40103, 'no refresh token')
  }
  const fresh = await refreshTokens(rt)
  persistTokens(fresh)
  cachedAccessExp = decodeJwt(fresh.token)?.exp ?? null
  return fresh
}

/**
 * 雪崩队列：第一个 40102 触发 doRefresh，后续 40102 复用同一个 promise；
 * 完成后清空（setTimeout 让微任务队列里的消费者先看到结果）。
 */
function getOrCreateRefresh(): Promise<LoginResponse> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        return await doRefresh()
      } finally {
        setTimeout(() => {
          refreshPromise = null
        }, 0)
      }
    })()
  }
  return refreshPromise
}

/** Proactive：每次成功响应后检查 exp，剩余 < 5min 就 fire-and-forget 刷新。 */
function maybeProactiveRefresh(): void {
  if (cachedAccessExp === null) {
    const t = readToken()
    if (!t) return
    cachedAccessExp = decodeJwt(t)?.exp ?? null
    if (cachedAccessExp === null) return
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedAccessExp - nowSec > REFRESH_AHEAD_SECONDS) return
  if (Date.now() - lastProactiveFireMs < PROACTIVE_THROTTLE_MS) return
  lastProactiveFireMs = Date.now()
  void getOrCreateRefresh().catch(() => {
    /* reactive 路径会兜底；这里只 fire-and-forget */
  })
}

// ===== 拦截器（具名，api / apiV2 复用） =====

/** 请求拦截：挂 Authorization。 */
function authRequestInterceptor(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  const token = readToken()
  if (token) {
    // 用 .set 避免某些 axios 版本对 headers 直接赋值的 readonly 警告。
    config.headers.set('Authorization', `Bearer ${token}`)
  }
  return config
}

/**
 * 响应拦截：解 `{code, message, data}` 信封 → 调用方拿到的是裸 data；
 * 非标准响应（如文件 blob / 文本）原样返回。每次成功响应都触发
 * maybeProactiveRefresh（剩余寿命 < 5min 后台 fire-and-forget 刷新）。
 */
function envelopeResponseInterceptor(response: AxiosResponse): AxiosResponse {
  const payload = response.data
  if (isEnvelope(payload)) {
    if (payload.code !== 0) {
      throw new ApiError(payload.code, payload.message, response)
    }
    // 直接把 response.data 替换成解封后的 data，保持 `api.get<T>()` 的 .data 语义。
    response.data = payload.data
  }
  // 非标准响应（如文件 blob / 文本）原样返回
  maybeProactiveRefresh()
  return response
}

/**
 * 错误拦截工厂：blob body 解析 → 40102 自动 refresh + 重试 → refresh 失败
 * dispatch auth:logout。
 *
 * 用工厂 + 闭包持有 client，是为了让 api / apiV2 各自 `client.request(retryCfg)`
 * 在自己实例上重试，不被另一实例的拦截器链干扰。refreshPromise 等雪崩状态
 * 仍是模块单例，两实例并发撞 40102 只触发一次 /auth/refresh。
 */
function makeEnvelopeErrorInterceptor(client: AxiosInstance) {
  return async (error: AxiosError) => {
    // blob 响应的 error body 也是 Blob；isEnvelope(blob) 返回 false 会让
    // 401 自动刷新失效。先把 Blob body 读成文本再尝试 JSON parse。
    let payload: unknown = error.response?.data
    if (payload instanceof Blob) {
      try {
        const text = await payload.text()
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
    }
    if (!isEnvelope(payload)) {
      throw new ApiError(
        error.response?.status ?? 0,
        error.message || 'network error',
        error.response,
      )
    }

    const apiErr = new ApiError(payload.code, payload.message, error.response)
    const cfg = error.config as (InternalAxiosRequestConfig & { _isRetryAfterRefresh?: boolean }) | undefined

    // 40105 SESSION_REVOKED（v2 才有）：JWT 签名仍有效，但 Redis session:tok:<sha256>
    // 已被吊销（其它设备 logout / 改密 / 管理员停用）。refresh 也救不回（同一 session
    // 索引会被连带清掉），直接 dispatch auth:logout 跳登录，不再走下方 40102 的
    // reactive refresh 分支。
    if (apiErr.code === 40105) {
      window.dispatchEvent(new CustomEvent('auth:logout'))
      throw apiErr
    }

    // 仅在 access 过期且非 refresh 重试时触发自动刷新。
    const shouldRefresh =
      apiErr.code === 40102 && cfg && !cfg._isRetryAfterRefresh

    if (!shouldRefresh) throw apiErr

    try {
      const fresh = await getOrCreateRefresh()
      // 用新 token 重试原请求；标记 _isRetryAfterRefresh 防递归
      const retryCfg = {
        ...cfg,
        headers: { ...(cfg.headers ?? {}), Authorization: `Bearer ${fresh.token}` },
        _isRetryAfterRefresh: true,
      } as InternalAxiosRequestConfig & { _isRetryAfterRefresh?: boolean }
      // 用闭包持有的 client 重试——api 实例回到 api.request，apiV2 回到 apiV2.request
      return await client.request(retryCfg)
    } catch (refreshErr) {
      // refresh 失败：触发全局登出事件，main.ts 监听后 router.replace('/login')
      window.dispatchEvent(new CustomEvent('auth:logout'))
      throw refreshErr
    }
  }
}

api.interceptors.request.use(authRequestInterceptor)
api.interceptors.response.use(
  envelopeResponseInterceptor,
  makeEnvelopeErrorInterceptor(api),
)

/** 业务异常：code !== 0 时抛出；调用方用 try/catch + (e as ApiError).code 取错误码。 */
export class ApiError extends Error {
  public readonly code: number
  public readonly response: unknown

  constructor(code: number, message: string, response?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.response = response
  }

  /** 是否为"未登录 / token 失效"——由调用方决定如何处理（路由跳转 / 重新登录）。 */
  get isAuthError(): boolean {
    // 40105 SESSION_REVOKED：JWT 签名有效但 Redis session 已被吊销。语义上等同
    // "未登录"，调用方应清 session 跳登录；拦截器内已经 dispatch auth:logout，
    // 这里只是让业务侧可以分支识别这一类。
    return (
      this.code === 40101 ||
      this.code === 40102 ||
      this.code === 40103 ||
      this.code === 40105
    )
  }
}

// ===== v2 客户端（共享拦截器） =====

/**
 * v2 API 客户端：baseURL = `/api/v2`，与 api（v1）共享 token / refresh / 信封逻辑。
 *
 * 何时新增实例：路由前缀按版本切分时（v3 = 再加一个 apiV3）。单端点的 v2
 * 调用不该用 `api.post('/v2/...')`，会被 baseURL 拼成 `/api/v1/v2/...`。
 */
export const apiV2 = axios.create({
  baseURL: '/api/v2',
  timeout: 30_000,
  // paramsSerializer 与 api 一致——重复定义避免引用 api.defaults 后被改时牵连
  paramsSerializer: serializeParams,
})
apiV2.interceptors.request.use(authRequestInterceptor)
apiV2.interceptors.response.use(
  envelopeResponseInterceptor,
  makeEnvelopeErrorInterceptor(apiV2),
)

/**
 * 移除值为 undefined / null / 空字符串 / 空数组的 query 字段；保留数字 0 和布尔 false。
 *
 * 给 list 类接口（GET /xxx?a=1）用——后端对 '' 会做 LIKE '%%'（导致全量匹配），
 * axios 默认只 strip undefined / null，不 strip '' / []。把这一步抽到统一的
 * api/http.ts 里，9 个 list API 共享一份行为（2026-08-25 refactor）。
 *
 * 用 `<T extends object>` 而不是 `Record<string, unknown>`：前者接受任意 object
 * 字面量 / interface（包括 ListPartsParams 这种显式 interface），后者要求有
 * 显式字符串 index signature，interface 默认不带，导致调用方报 TS2345。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cleanParams<T extends Record<string, any>>(
  obj?: T,
): Record<string, unknown> {
  if (!obj) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}
