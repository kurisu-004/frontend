/** 与后端 enum UserRole 对齐 */
export type UserRole = 'MANAGER' | 'SHELF_ACCOUNT' | 'CLERK' | 'INSPECTOR' | 'CNC_PROGRAMMER';

import type { MenuNode } from './menu';

export interface UserOut {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  username: string;
  full_name: string;
  phone: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  roles: UserRoleOut[];
}

export interface UserRoleOut {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增 */
  version: number;
  role: string;
  scope_type: string | null;
  scope_id: string | null;
  shelf_code: string | null;
  shelf_name: string | null;
}

/** 2026-10-10 新增：企业微信账号绑定（`GET|POST /api/v2/iam/users/{id}/wx-bind`）。
 *
 *  绑定基数是**双向一对一**（后端业务层限制，不加 DB 约束）：一个企微 userid 只能绑
 *  一个系统账号（撞了 40108），一个系统账号只能绑一个企微 userid（撞了 40110）⇒
 *  前端 UI 退化成「单输入框 + 一个绑定 / 一个解绑」，不做多绑定列表。
 *
 *  - `id` / `user_id` 是**雪花 ID 字符串**（后端 serialize_i64），全链路保持 string，
 *    禁止 `Number(id)`（19 位 ID 在 JS Number 下丢精度）；
 *  - `version` 是解绑端点（`POST /{id}/wx-bind/unbind`）的 OCC 锚，取值是本行的；
 *  - `corp_id` 只读：后端只认配置值 `WECOM_CORPID`，绑定请求不接受它（后端已删字段）。 */
export interface WxIdentity {
  id: string;
  /** 企业 ID（后端 WECOM_CORPID 配置值，前端只展示）。 */
  corp_id: string;
  /** 企微通讯录成员 UserID（后端已 trim + 转小写）。 */
  wx_user_id: string;
  /** 被绑定的系统账号 id（雪花字符串）。 */
  user_id: string;
  /** 乐观锁版本号；解绑的 OCC 锚。 */
  version: number;
  created_at: string;
}

/** 2026-10-10：`POST /api/v2/iam/users/{id}/update` 请求体。
 *  `version` **必填**（`t_user.version` 乐观锁锚，后端无 `#[serde(default)]` ⇒
 *  缺省是 axum 的 HTTP 422 纯文本而不是业务信封）。 */
export interface UpdateUserPayload {
  version: number;
  full_name?: string;
  phone?: string;
  password?: string;
  is_active?: boolean;
}

/** 2026-10-10：`POST /api/v2/iam/users/{id}/deactivate` 请求体。
 *  该端点原本无 body，后端改为收 `{ version }`（同样是 422 缺省档）。 */
export interface DeactivateUserPayload {
  version: number;
}

/** 2026-10-10：`POST /api/v2/iam/users/{id}/roles/{role_id}/remove` 请求体。
 *  `version` 取 **`UserRoleOut.version`**（`t_user_role` 的计数器，与
 *  `t_user.version` 是两个互不相关的数，混用必 40901）。 */
export interface RemoveUserRolePayload {
  version: number;
}

/** 2026-10-10：`POST /api/v2/iam/users/{id}/wx-bind` 请求体。
 *  刻意**不含** `corp_id`（后端已删该入参，只认配置值）。 */
export interface BindWxIdentityPayload {
  wx_user_id: string;
}

/** 2026-10-10：`POST /api/v2/iam/users/{id}/wx-bind/unbind` 请求体。
 *  `version` 取 `WxIdentity.version`。 */
export interface UnbindWxIdentityPayload {
  version: number;
}

export interface CurrentUser {
  id: string;
  username: string;
  full_name: string;
  is_active: boolean;
  roles: string[]; // 字符串数组，如 ["MANAGER"]
  shelf_ids: string[]; // SHELF_ACCOUNT 时非空
  menus: MenuNode[]; // 登录时拉回，渲染侧边栏 + 路由守卫用
}

export interface UserListResult {
  items: UserOut[];
  total: number;
  limit: number;
  offset: number;
}
