// src/api/rbac.ts
//
// 2026-10-14 新增：RBAC 控制面板的 8 个端点（角色 CRUD / 授权 / 权限点 / 菜单树）。
//
// 本文件**只发请求 + 用类型标注返回类型，不做 Zod 校验**（CLAUDE.md 硬约束）：
// 守门点在 query hook 的 queryFn（`@/views/iam/roles/composables/useRolesQuery`），
// Zod 的 parse 入口返回**深拷贝**，在 api 层再走一遍等于每屏数据被校验并克隆两遍；
// 而且 api 层一旦 parse，queryFn 那次就变成纯浪费，两处校验点还会随字段增删各自漂移。
// 负向守卫见 `src/api/__tests__/rbac.spec.ts`（断言 8 个函数对坏响应**原样返回**）。
//
// ⚠️ **部署顺序：后端必须先上**。`/iam/me` 新增了必填字段 `permissions`（见
// `@/types/user`），新前端的会话守门 schema 显式声明它 ⇒ 旧后端不返该键时每次
// `/iam/me` 复核抛 ZodError，表现为全员被踢回登录页循环。

import { api } from '@/api/http';
import type { MenuTreeNode, PermissionGroupData, RoleDef, RoleGrants } from '@/types/rbac';

/** 角色列表的排序由**后端**负责（`is_system DESC` 置顶、其余 `code ASC`），
 *  前端不再二次排序。 */
export async function listRoles(): Promise<RoleDef[]> {
  const resp = await api.get<RoleDef[]>('/iam/roles');
  return resp.data;
}

export interface CreateRolePayload {
  /** 大写 code，全局唯一。 */
  code: string;
  name: string;
  description?: string | null;
}

/**
 * 新建角色（`POST /api/v2/iam/roles`）。
 *
 * **无 `version`**：新建时行还不存在，无 OCC 锚可传（与账号管理的 `createUser` 同口径）。
 * 失败抛 `ApiError`：20602 角色 code 重复、40001 参数校验失败。
 */
export async function createRole(payload: CreateRolePayload): Promise<RoleDef> {
  const resp = await api.post<RoleDef>('/iam/roles', payload);
  return resp.data;
}

export interface UpdateRolePayload {
  /**
   * 角色 code。
   *
   * 可选：**省略 = 不改**（留空即不传该键，不是传空串）。改 code 会让已持有旧 code 的
   * 授权失去指向，前端只在「该角色当前无任何账号持有」（`user_count === 0`）时才允许改。
   */
  code?: string;
  name: string;
  description?: string | null;
  /** OCC 锚，`t_role.version`，**必填**（缺省是 HTTP 422 纯文本）。 */
  version: number;
}

/** 编辑角色（`POST /api/v2/iam/roles/{id}/update`）。
 *
 * 失败抛 `ApiError`：20601 角色不存在 / 20602 code 重复 / 40901 OCC 冲突 / 40001 参数校验失败。 */
export async function updateRole(id: string, payload: UpdateRolePayload): Promise<RoleDef> {
  const resp = await api.post<RoleDef>(`/iam/roles/${id}/update`, payload);
  return resp.data;
}

export interface DeactivateRolePayload {
  /** OCC 锚，`t_role.version`，**必填**。 */
  version: number;
  /** true = 软删（delete）、false = 仅停用（deactivate）。 */
  delete: boolean;
}

export interface DeactivateRoleResult {
  /** 受影响的账号数：停用/删除后有多少账号不再持有该角色。面板据此提示管理员
   *  「有 N 个账号将失去该角色」。 */
  affected_user_count: number;
}

/** 停用 / 删除角色（`POST /api/v2/iam/roles/{id}/deactivate`）。
 *
 *  一个端点两种语义，由 body 的 `delete` 布尔分流（沿用账号管理 `deactivateUser` 的形态）。
 * 失败抛 `ApiError`：20601 角色不存在 / 40901 OCC 冲突 / 40001 参数校验失败。 */
export async function deactivateRole(
  id: string,
  payload: DeactivateRolePayload,
): Promise<DeactivateRoleResult> {
  const resp = await api.post<DeactivateRoleResult>(`/iam/roles/${id}/deactivate`, payload);
  return resp.data;
}

/**
 * 读单个角色的授权快照（`GET /api/v2/iam/roles/{id}/grants`）。
 *
 * ADMIN（`role_code === 'ADMIN'`）返回**全量**菜单与权限点 —— 前端据此把右区渲染成
 * 全勾选 + 只读（提交按钮不渲染），与后端拒写 ADMIN 形成双端兜底。
 */
export async function getRoleGrants(id: string): Promise<RoleGrants> {
  const resp = await api.get<RoleGrants>(`/iam/roles/${id}/grants`);
  return resp.data;
}

export interface SaveRoleGrantsPayload {
  /** 菜单 code **全量**（整包替换，不是增量）。 */
  menu_codes: string[];
  /** 权限点 code **全量**（整包替换，不是增量）。 */
  permission_codes: string[];
  /** OCC 锚：取 `RoleGrants.version`，**必填**。 */
  version: number;
}

/** 保存单个角色的授权（`POST /api/v2/iam/roles/{id}/grants`）。
 *
 * ⚠️ **整包替换**：两个数组就是提交时的全集，后端直接覆盖，不做 diff。
 * 失败抛 `ApiError`：20601 角色不存在 / 40901 OCC 冲突 / 40001 参数校验失败 /
 * 对 ADMIN 返 400（前端对 ADMIN 根本不渲染提交按钮，这是第二道闸）。 */
export async function saveRoleGrants(
  id: string,
  payload: SaveRoleGrantsPayload,
): Promise<RoleGrants> {
  const resp = await api.post<RoleGrants>(`/iam/roles/${id}/grants`, payload);
  return resp.data;
}

/** 权限点全集，按 domain 分组（`GET /api/v2/iam/permissions`）。 */
export async function listPermissions(): Promise<PermissionGroupData[]> {
  const resp = await api.get<PermissionGroupData[]>('/iam/permissions');
  return resp.data;
}

/** 系统菜单树全集（`GET /api/v2/iam/menus`），面板右区勾选树的数据源。
 *
 * 与 `/iam/me` 的 `menus` 逐字段同形（同一个后端 VO），故守门 schema 复用
 * `menuNodeSchema`（`@/views/auth/sessionSchema`），不写第二份。 */
export async function listMenus(): Promise<MenuTreeNode[]> {
  const resp = await api.get<MenuTreeNode[]>('/iam/menus');
  return resp.data;
}
