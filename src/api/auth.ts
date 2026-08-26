// 账号登录 / 会话 / 当前账号 API。
//
// 2026-08-26 切 v2（已回滚）：v1 FastAPI 无 Redis，session 不可靠 → 登录反复出错；
// v2 Rust 后端（~/Code/hsh-erp-rust/docs/api/auth.md）用 Redis 维护
// session:tok:<sha256>。v1 / v2 字段完全一致（已校验），仅 v2 新增错误码 40105
// SESSION_REVOKED，由 http.ts 拦截器统一处理（不 refresh，直接 dispatch auth:logout）。
//
// 2026-08-26 回滚到 v1：v2 session 表（session:tok:<sha256>）v1 无对应索引，
// v2 颁发的 JWT 在 v1 的 get_current_user 处失败。业务仍依赖 v1 FastAPI（其他业务
// 域未迁移），统一 v1 session 才能让 refresh 流跑通；后续 v1 业务端点迁完再切回 v2。
// 已知 trade-off：v2 业务端点（deliveryNote / deliveryGroup / parts/scanInspect）
// 仍走 apiV2，拿到 v1 JWT 会在 get_current_user 处 40101，由 auth:logout 兜底重登。
//
// 端点（全部经 api / refreshClient）：
//   POST   /auth/login            → login()
//   GET    /auth/me               → me()
//   POST   /auth/logout           → logout()
//   POST   /auth/change-password  → changeMyPassword()
//   POST   /auth/refresh          → refreshTokens()（refreshClient，无拦截器）
//
// 错误码：BIZ_AUTH_INVALID=40101 / TOKEN_EXPIRED=40102 /
// REFRESH_INVALID=40103 / OLD_PASSWORD_MISMATCH=40104。
// 40105 SESSION_REVOKED 是 v2 专属码，http.ts 拦截器分支保留为 dead code（v1 不触发）。
//
// 走 @/api/http 的统一 axios 客户端：
// - /auth/login 公开（localStorage 里没 token 时请求拦截器 no-op）
// - /auth/me / /auth/logout 自动挂 Authorization
//
// 2026-07-10 起 LoginResponse 多一个 refresh_token 字段；refreshTokens()
// 用专门的非拦截 axios 实例（refreshClient）调 /auth/refresh，避免递归触发
// 拦截器内的刷新逻辑。

import { api, refreshClient, ApiError } from '@/api/http'
import type { CurrentUser } from '@/types/user'

export interface LoginResponse {
  token: string
  /** 2026-07-10 新增：refresh token（7d TTL，type="refresh"）。 */
  refresh_token: string
  user: CurrentUser
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const resp = await api.post<LoginResponse>('/auth/login', { username, password })
  return resp.data
}

export async function me(): Promise<CurrentUser> {
  const resp = await api.get<CurrentUser>('/auth/me')
  return resp.data
}

export async function logout(): Promise<void> {
  // no-op：客户端丢 token 即可。这里容忍失败（不清 localStorage 也不抛）。
  // v1 后端 logout 是 no-op（仅返回 {"ok": true}），客户端吞失败的兜底语义不变。
  try {
    await api.post('/auth/logout')
  } catch {
    /* noop */
  }
}

export interface ChangePasswordPayload {
  old_password: string
  new_password: string
}

/**
 * 修改自己的密码：校验旧密码后写新密码。
 *
 * 成功后后端会轮转 refresh token（其他设备旧 refresh 立即失效），
 * 调用方应清 session 并跳登录页。
 *
 * 失败抛 ApiError：code === 40104 (BIZ_AUTH_OLD_PASSWORD_MISMATCH) → 旧密码错误。
 */
export async function changeMyPassword(payload: ChangePasswordPayload): Promise<void> {
  await api.post('/auth/change-password', payload)
}

/**
 * 用 refresh token 换新一对 token。
 *
 * 用 refreshClient（无拦截器）调，避免响应拦截器里的"40102 → refresh"链路
 * 二次触发本函数造成递归。
 *
 * 失败抛 ApiError：
 * - code === 40103 (BIZ_AUTH_REFRESH_INVALID) → 刷新失败，客户端应清 session 跳登录；
 * - code === 0 / 其它 → 见后端 envelope 语义。
 */
export async function refreshTokens(refresh_token: string): Promise<LoginResponse> {
  const resp = await refreshClient.post<{ code: number; message: string; data: LoginResponse | null }>(
    '/auth/refresh',
    { refresh_token },
  )
  const env = resp.data
  if (env.code !== 0 || !env.data) {
    throw new ApiError(env.code, env.message || 'refresh failed')
  }
  return env.data
}
