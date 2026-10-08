// IAM（账号 + 会话 + 当前账号 + 账号管理）API。
//
// 2026-09-19 合并：原 `src/api/auth.ts`（login / me / logout / refreshTokens /
// changeMyPassword）+ `src/api/users.ts`（listUsers / createUser / updateUser /
// deactivateUser / resetUserPassword / listUserRoles / addUserRole /
// removeUserRole）合并为单一 `src/api/iam.ts`。13 个函数名保持不变，消费方
// （`useAuthStore` / `LoginView.vue` / `UserList.vue` / `http.ts` / `MainLayout.vue`）
// 仅改 import 路径。
//
// 2026-09-26：消费方 `useAuthSession` → `useAuthStore`（Pinia setup store 迁移）。
// IAM 函数本身签名不变。
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
//   GET    /iam/users/{id}/wx-bind           → getWxIdentity()（前端 2026-10-10 首次接入）
//   POST   /iam/users/{id}/wx-bind           → bindWxIdentity()
//   POST   /iam/users/{id}/wx-bind/unbind    → unbindWxIdentity()
//
// 2026-10-10 账号写端点全部改为**必收乐观锁 version**（body 里的 `version` 字段）：
//   POST /iam/users/{id}/update            ← 必填 version
//   POST /iam/users/{id}/deactivate        ← 由「无 body」改为 `{ version }`
//   POST /iam/users/{id}/roles/{rid}/remove← 由「无 body」改为 `{ version }`
// 三个入参都没有 `#[serde(default)]` ⇒ 漏传是 axum 的 HTTP 422 纯文本（不是业务信封），
// 前端必须无条件带上，别用「读-再-比」式隐式 OCC 代替。
// `POST /iam/users/{id}/reset-password` 仍是**无 body、无 OCC**（重置是幂等的管理动作，
// 没有可被并发覆盖的字段）。
//
// 2026-10-10 企业微信绑定的两点形态（写前端时按这两个来，勿按 REST 直觉猜）：
//   1. 解绑从 `DELETE` 改成 `POST .../wx-bind/unbind` —— 后端全站只允许 GET 与 POST
//      两种方法。本仓的 axios 客户端至今零 DELETE 调用，本次也保持零使用。
//   2. `GET /iam/users/{id}/wx-bind` 未绑定时信封 `data` 是 **`null`**（不是 `[]`），
//      消费侧必须能处理 null。

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
import type {
  BindWxIdentityPayload,
  DeactivateUserPayload,
  RemoveUserRolePayload,
  UnbindWxIdentityPayload,
  UpdateUserPayload,
  WxIdentity,
} from '@/types/user';

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

/**
 * 账号分页列表（`GET /api/v2/iam/users`）。
 *
 * @param params `username_like`（ILIKE 子串）/ `is_active`（三态：缺省不过滤）/ `limit` / `offset`。
 * @returns 分页信封；`total` / `limit` / `offset` 经 `normalizeListResult` 统一成 number。
 *
 * 失败抛 `ApiError`：20601 账号不存在（单账号端点）、40001 参数校验失败。
 */
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

/**
 * 新建账号（`POST /api/v2/iam/users`，成功返 201 + UserOut）。
 *
 * 失败抛 `ApiError`：
 * - 20602 用户名重复（表单侧把焦点送回 username 字段）；
 * - 40001 参数校验失败（HTTP 422）。
 */
export async function createUser(payload: CreateUserPayload): Promise<UserOut> {
  const resp = await api.post<UserOut>('/iam/users', payload);
  return resp.data;
}

/**
 * 编辑账号（`POST /api/v2/iam/users/{id}/update`）。
 *
 * @param payload `version` **必填**（`t_user.version`，OCC 锚；缺省是 HTTP 422 纯文本）。
 *   `password` 省略 = 不改密码（留空即不传该键，不是传空串）。
 *
 * 失败抛 `ApiError`：
 * - 20601 账号不存在；
 * - 20602 用户名重复；
 * - 40901 OCC 版本冲突（数据已被他人改动，UI 提示刷新后重试）；
 * - 40001 参数校验失败。
 */
export async function updateUser(id: string, payload: UpdateUserPayload): Promise<UserOut> {
  const resp = await api.post<UserOut>(`/iam/users/${id}/update`, payload);
  return resp.data;
}

/**
 * 停用账号（`POST /api/v2/iam/users/{id}/deactivate`）。
 *
 * @param payload `{ version }` —— 2026-10-10 起必填，该端点原本无 body。
 *
 * 失败抛 `ApiError`：20601 账号不存在 / 40901 OCC 版本冲突 / 40001 参数校验失败。
 */
export async function deactivateUser(id: string, payload: DeactivateUserPayload): Promise<UserOut> {
  const resp = await api.post<UserOut>(`/iam/users/${id}/deactivate`, payload);
  return resp.data;
}

/**
 * 管理员重置指定账号密码为默认口令 changeme（后端会轮转其 refresh token）。
 *
 * **无 body、无 OCC**（重置是幂等管理动作，没有可被并发覆盖的字段），与本文件另外三个
 * 改为必收 version 的写端点不同。
 *
 * 失败抛 `ApiError`：20601 账号不存在。
 */
export async function resetUserPassword(id: string): Promise<UserOut> {
  const resp = await api.post<UserOut>(`/iam/users/${id}/reset-password`);
  return resp.data;
}

/**
 * 账号已授角色列表（`GET /api/v2/iam/users/{id}/roles`）。
 *
 * 失败抛 `ApiError`：20601 账号不存在。
 */
export async function listUserRoles(userId: string): Promise<UserRoleOut[]> {
  const resp = await api.get<UserRoleOut[]>(`/iam/users/${userId}/roles`);
  return resp.data;
}

export interface AddUserRolePayload {
  role: string;
  scope_type?: string | null;
  scope_id?: string | null;
}

/**
 * 给账号加角色（`POST /api/v2/iam/users/{id}/roles`，成功返 201）。
 *
 * 纯 INSERT、无 version；重复绑同一个货架由后端唯一键兜住（20604 角色重复）。
 *
 * 失败抛 `ApiError`：20601 账号不存在 / 20604 角色重复 / 20605 角色不存在 /
 * 40001 参数校验失败。
 */
export async function addUserRole(
  userId: string,
  payload: AddUserRolePayload,
): Promise<UserRoleOut> {
  const resp = await api.post<UserRoleOut>(`/iam/users/${userId}/roles`, payload);
  return resp.data;
}

/**
 * 移除账号的某个角色（`POST /api/v2/iam/users/{id}/roles/{role_id}/remove`）。
 *
 * @param payload `{ version }` —— 2026-10-10 起必填（该端点原本无 body）。**`version`
 *   取 `UserRoleOut.version`（`t_user_role` 的计数器）**，不是 `t_user.version` —— 两个
 *   是互不相关的计数器，混用必 40901。
 *
 * 失败抛 `ApiError`：20601 账号不存在 / 20605 角色不存在 / 40901 OCC 版本冲突 /
 * 40001 参数校验失败。
 */
export async function removeUserRole(
  userId: string,
  roleId: string,
  payload: RemoveUserRolePayload,
): Promise<void> {
  await api.post(`/iam/users/${userId}/roles/${roleId}/remove`, payload);
}

// ===== 企业微信账号绑定（前端 2026-10-10 首次接入；后端端点早已实装）=====

/**
 * 查账号的企业微信绑定（`GET /api/v2/iam/users/{id}/wx-bind`）。
 *
 * ⚠️ **未绑定时信封 `data` 是 `null`，不是 `[]`** —— 消费侧（企微绑定对话框）必须能
 * 处理 null，不要直接 `.map` / `.length`。
 *
 * 失败抛 `ApiError`：20601 账号不存在 / 40101 未登录。
 */
export async function getWxIdentity(userId: string): Promise<WxIdentity | null> {
  const resp = await api.get<WxIdentity | null>(`/iam/users/${userId}/wx-bind`);
  return resp.data;
}

/**
 * 绑定企业微信账号（`POST /api/v2/iam/users/{id}/wx-bind`）。
 *
 * @param payload 只有 `wx_user_id`（企微通讯录成员 UserID）。**不传 `corp_id`**（后端
 *   已删该入参，只认配置值 `WECOM_CORPID`）。
 *
 * 绑定基数双向一对一，两个撞车方向的错误码不同、文案也不同：
 * - 40108 该企微 userid 已被**别的系统账号**绑定（HTTP 409）；
 * - 40110 该系统账号已绑了**别的企微 userid**（HTTP 409，需先解绑）；
 * - 40109 服务端未配置 `WECOM_CORPID`（联系管理员）；
 * - 20601 账号不存在 / 40001 参数校验失败。
 */
export async function bindWxIdentity(
  userId: string,
  payload: BindWxIdentityPayload,
): Promise<WxIdentity> {
  const resp = await api.post<WxIdentity>(`/iam/users/${userId}/wx-bind`, payload);
  return resp.data;
}

/**
 * 解绑企业微信账号（`POST /api/v2/iam/users/{id}/wx-bind/unbind`）。
 *
 * ⚠️ **不是 `DELETE`** —— 后端全站只允许 GET 与 POST 两种方法，解绑从 DELETE 改成了
 * POST。本仓的 axios 客户端至今零 DELETE 调用，本次也保持零使用。
 *
 * @param payload `{ version }` 必填，取 `WxIdentity.version`。
 * 存量数据可能有 >1 行绑定，解绑软删该账号的**全部**绑定行。
 *
 * 失败抛 `ApiError`：20601 账号不存在 / 40901 OCC 版本冲突 / 40001 参数校验失败。
 */
export async function unbindWxIdentity(
  userId: string,
  payload: UnbindWxIdentityPayload,
): Promise<void> {
  await api.post(`/iam/users/${userId}/wx-bind/unbind`, payload);
}
