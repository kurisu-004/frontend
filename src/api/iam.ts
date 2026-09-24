// IAM（账号 + 会话 + 当前账号 + 账号管理）API。
//
// 2026-09-19 合并：原 `src/api/auth.ts`（login / me / logout / refreshTokens /
// changeMyPassword）+ `src/api/users.ts`（listUsers / createUser / updateUser /
// deactivateUser / resetUserPassword / listUserRoles / addUserRole /
// removeUserRole）合并为单一 `src/api/iam.ts`。13 个函数名保持不变，消费方
// （`useAuthSession` / `LoginView.vue` / `UserList.vue` / `http.ts` / `MainLayout.vue`）
// 仅改 import 路径。
//
// 2026-09-14 切 v2：v1 Python FastAPI 无 Redis session，登录反复出错；
// v2 Rust 后端（backend-rust/docs/api/iam.md）用 session:tok:<sha256>
// 维护服务端 session 表。v1 / v2 字段一致 + v2 新增 40105 SESSION_REVOKED
// （其它设备 logout / 改密 / 管理员停用后 JWT 仍签名有效但 session 索引
// 已被吊销，由 http.ts 拦截器直接 dispatch auth:logout 不走 refresh）。
//
// 2026-09-15 Phase 5：业务全切 v2；`api` 与 `refreshClient` baseURL 统一改为
// `/api/v2`，原 `apiV2` / `refreshClientV2` 合并进 `api` / `refreshClient`。
//
// 2026-09-19 IAM 域路径收敛：backend-rust 把原 `auth/*` + `users/*` 两个
// 路由前缀合并为单一 `iam/*`（router 模块合并，session / refresh / 账号 CRUD
// 都在 `iam` 域下）。前端同步切换：
//   POST   /iam/login            → login()
//   GET    /iam/me               → me()
//   POST   /iam/logout           → logout()
//   POST   /iam/change-password  → changeMyPassword()
//   POST   /iam/refresh          → refreshTokens()（refreshClient，无拦截器）
//   GET    /iam/users            → listUsers()
//   POST   /iam/users            → createUser()
//   POST   /iam/users/{id}/update            → updateUser()
//   POST   /iam/users/{id}/deactivate        → deactivateUser()
//   POST   /iam/users/{id}/reset-password    → resetUserPassword()
//   GET    /iam/users/{id}/roles             → listUserRoles()
//   POST   /iam/users/{id}/roles             → addUserRole()
//   POST   /iam/users/{id}/roles/{rid}/remove → removeUserRole()
//
// 错误码：BIZ_AUTH_INVALID=40101 / TOKEN_EXPIRED=40102 /
// REFRESH_INVALID=40103 / OLD_PASSWORD_MISMATCH=40104 /
// SESSION_REVOKED=40105（v2 专属，由 http.ts 拦截器分支处理）。
//
// 走 @/api/http 的统一 axios 客户端：
// - /iam/login 公开（localStorage 里没 token 时请求拦截器 no-op）
// - /iam/me / /iam/logout 自动挂 Authorization
//
// 2026-07-10 起 LoginResponse 多一个 refresh_token 字段；refreshTokens()
// 用专门的非拦截 axios 实例（refreshClient）调 /iam/refresh，避免递归触发
// 拦截器内的刷新逻辑。

import { api, refreshClient, ApiError, cleanParams, normalizeListResult } from '@/api/http';
import type { CurrentUser, UserOut, UserRoleOut, UserListResult } from '@/types/user';

export interface LoginResponse {
  token: string;
  /** 2026-07-10 新增：refresh token（7d TTL，type="refresh"）。 */
  refresh_token: string;
  user: CurrentUser;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const resp = await api.post<LoginResponse>('/iam/login', { username, password });
  return resp.data;
}

export async function me(): Promise<CurrentUser> {
  const resp = await api.get<CurrentUser>('/iam/me');
  return resp.data;
}

export async function logout(): Promise<void> {
  // no-op：客户端丢 token 即可。这里容忍失败（不清 localStorage 也不抛）。
  // 后端 logout 是 no-op（仅返回 {"ok": true}），客户端吞失败的兜底语义不变。
  try {
    await api.post('/iam/logout');
  } catch {
    /* noop */
  }
}

export interface ChangePasswordPayload {
  old_password: string;
  new_password: string;
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
  await api.post('/iam/change-password', payload);
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
  const resp = await refreshClient.post<{
    code: number;
    message: string;
    data: LoginResponse | null;
  }>('/iam/refresh', { refresh_token });
  const env = resp.data;
  if (env.code !== 0 || !env.data) {
    throw new ApiError(env.code, env.message || 'refresh failed');
  }
  return env.data;
}

// ===== 账号管理（2026-09-19 合并自 src/api/users.ts） =====

export interface ListUsersParams {
  username_like?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export async function listUsers(params: ListUsersParams = {}): Promise<UserListResult> {
  const resp = await api.get<UserListResult>('/iam/users', { params: cleanParams(params) });
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 UserListOut 当前是 i64 number，但本 helper 兜底未来漂移到 serialize_i64 字符串的
  // 场景。schema 类型保持不变。
  return normalizeListResult(resp.data);
}

export interface CreateUserPayload {
  username: string;
  password: string;
  full_name: string;
  phone?: string;
}

export async function createUser(payload: CreateUserPayload): Promise<UserOut> {
  const resp = await api.post<UserOut>('/iam/users', payload);
  return resp.data;
}

export interface UpdateUserPayload {
  full_name?: string;
  phone?: string;
  password?: string;
  is_active?: boolean;
}

export async function updateUser(id: string, payload: UpdateUserPayload): Promise<UserOut> {
  const resp = await api.post<UserOut>(`/iam/users/${id}/update`, payload);
  return resp.data;
}

export async function deactivateUser(id: string): Promise<UserOut> {
  const resp = await api.post<UserOut>(`/iam/users/${id}/deactivate`);
  return resp.data;
}

/** 管理员重置指定账号密码为默认口令 changeme（后端会轮转其 refresh token）。 */
export async function resetUserPassword(id: string): Promise<UserOut> {
  const resp = await api.post<UserOut>(`/iam/users/${id}/reset-password`);
  return resp.data;
}

export async function listUserRoles(userId: string): Promise<UserRoleOut[]> {
  const resp = await api.get<UserRoleOut[]>(`/iam/users/${userId}/roles`);
  return resp.data;
}

export interface AddUserRolePayload {
  role: string;
  scope_type?: string | null;
  scope_id?: string | null;
}

export async function addUserRole(
  userId: string,
  payload: AddUserRolePayload,
): Promise<UserRoleOut> {
  const resp = await api.post<UserRoleOut>(`/iam/users/${userId}/roles`, payload);
  return resp.data;
}

export async function removeUserRole(userId: string, roleId: string): Promise<void> {
  await api.post(`/iam/users/${userId}/roles/${roleId}/remove`);
}
