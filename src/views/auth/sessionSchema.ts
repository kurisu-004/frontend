// src/views/auth/sessionSchema.ts
//
// 2026-10-14 新增：**认证链路**的 Zod 守门 schema（登录响应 / 当前用户 / 菜单节点）。
//
// 这份 schema 与 `views/iam/roles/composables/rbacSchema.ts`（RBAC 面板的**写侧**守门）
// 构成一组刻意对照，**分工是「读侧 vs 写侧」**：
//
//   | 本文件（会话，读侧）                     | rbacSchema（面板，写侧）        |
//   |----------------------------------------|-------------------------------|
//   | **不接 `.strict()`**（未知键 strip 掉）  | **接 `.strict()`**（多键即抛）  |
//   | 后端加一个派生字段 ⇒ 照常通过            | 后端加字段 ⇒ 立刻红，要决策    |
//   | 守门失败 = 全站不可用                    | 守门失败 = 面板这一屏不可用    |
//
// 口径：**认证链路守门失败 = 全站不可用**。`currentUserSchema` 的消费方是
// `/iam/me` 复核（路由守卫）与登录响应 —— 一次 parse 失败会把**所有人**踢回登录页循环
// （`refreshOrLogout` 的 catch 分支直接 `forceLogout`）。所以这里刻意不 `.strict()`：
// 后端哪天给 `CurrentUser` 加一个派生字段（头像、最后登录时间之类），不应该让所有人
// 登不进去。未知键由 Zod 默认的 strip 静默丢掉（沿 `views/cnc/composables/
// pendingProgrammingSchema.ts` 的既有先例）。
//
// ⚠️ 但**必填键一律显式声明**：Zod 默认 strip 会静默丢字段，前端照样「通过」校验 ⇒
// 漏声明 = 那一列整列失效（消费侧拿到 undefined 却毫无察觉）。所以下面每个键都写出来。
//
// 唯一的部署顺序硬约束：`permissions` 是**必填**（2026-10-14 起 `/iam/me` 新增字段）。
// 旧后端不返该键 ⇒ 每次 `/iam/me` 复核抛 ZodError ⇒ 全员被踢登录页循环。
// ⇒ **后端必须先上**（后端多返字段旧前端无感，反序则是全站不可用）。

import { z } from 'zod';

/** 菜单节点（与 `@/types/menu` 的 `MenuNode` **逐字段同形**，后端同一个 `MenuNodeOut` VO）。
 *
 *  **双消费方**（不要写第二份）：
 *   ① `currentUserSchema.menus` —— 登录时随 `/iam/me` 下发的「这个账号能看见什么菜单」，
 *      驱动侧栏渲染与路由守卫的 `treeContainsCode`；
 *   ② `GET /api/v2/iam/menus` —— RBAC 面板右区勾选树的「系统里一共有哪些菜单」。
 *  两边字段漂移会让「能在面板里勾出来的菜单」与「侧栏实际认的菜单」分叉。
 *
 *  递归 schema（`children` 的元素同形），故用 `z.lazy` + 显式类型标注打断 TS 的
 *  自引用推断。
 *
 *  ⚠️ 刻意**不**接 `.strict()`：理由见文件头（认证链路，后端加派生字段不该全员登出）。
 *  未知键被 strip 掉（Zod 默认行为），下面第 4 条验收用例守的就是这一条。 */
export interface MenuNodeShape {
  id: string;
  version: number;
  parent_id: string | null;
  /** 稳定业务键（如 `roles_list`）；与 router 的 `meta.menuCode` 同一套取值域。 */
  code: string;
  title: string;
  /** null = 分组节点（渲染成 el-sub-menu）。 */
  path: string | null;
  icon: string | null;
  sort_order: number;
  children: MenuNodeShape[];
}

export const menuNodeSchema: z.ZodType<MenuNodeShape> = z.lazy(() =>
  z
    .object({
      /** 雪花 ID 字符串（后端 serialize_i64，19 位在 JS Number 下丢精度）。 */
      id: z.string(),
      version: z.number(),
      parent_id: z.string().nullable(),
      code: z.string(),
      title: z.string(),
      path: z.string().nullable(),
      icon: z.string().nullable(),
      sort_order: z.number(),
      children: z.array(menuNodeSchema),
    })
    .strip(),
) as z.ZodType<MenuNodeShape>;

export type MenuNodeData = z.infer<typeof menuNodeSchema>;

/** 当前用户（`GET /api/v2/iam/me` 与登录响应里嵌的那一份）。
 *
 *  - `roles` 是**原始大写字符串数组**：内置 6 个角色之外，管理员在 RBAC 面板自建的
 *    角色（如 `QC_LEAD`）也会出现在这里。写死枚举会让自定义角色在编译期就「不存在」，
 *    而运行时后端照发 ⇒ 角色面板 / 用户详情里全部消失且**静默**。
 *  - `permissions` **必填**：权限点 code 全集，前端闸门按它判（`auth.hasPermission`）。
 *    ⚠️ 旧 localStorage 里的用户对象没有该键 —— 那条路径由 `stores/auth.ts` 的
 *    `loadFromStorage` 先补 `?? []` 默认再 `safeParse` 处理（迁移补丁，见该函数注释）；
 *    **wire 响应不靠这个兜底**。 */
export const currentUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    full_name: z.string(),
    is_active: z.boolean(),
    roles: z.array(z.string()),
    shelf_ids: z.array(z.string()),
    menus: z.array(menuNodeSchema),
    /** 2026-10-14 新增必填字段（后端按账号角色展开后的权限点全集）。 */
    permissions: z.array(z.string()),
  })
  .strip();

export type CurrentUserData = z.infer<typeof currentUserSchema>;

/** 登录响应信封（`POST /api/v2/iam/login` 与 `POST /api/v2/iam/refresh` 的 `data`）。
 *
 *  两个端点共用同一形状：后端 refresh 成功时会把完整的 user 一并回传（access token
 *  里的货架范围变了，前端要立刻看到），所以 `refreshTokens` 的守门与登录是同一个 schema
 *  —— `api/iam.ts::refreshTokens` 在那里接它（该守卫点是「没有 queryFn / mutationFn
 *  承载」的特殊形态，理由见该函数注释）。 */
export const loginResponseSchema = z
  .object({
    token: z.string(),
    /** refresh token（7d TTL，type="refresh"）。 */
    refresh_token: z.string(),
    user: currentUserSchema,
  })
  .strip();

export type LoginResponseData = z.infer<typeof loginResponseSchema>;
