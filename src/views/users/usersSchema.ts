// src/views/users/usersSchema.ts
//
// 2026-10-10 新增：账号管理域的 Zod schema（守门 + 表单校验两组），与主查询 hook
// （composables/useUsersQuery.ts）同居域根。形态照
// `src/views/inspection/composables/inspectionSchema.ts`。
//
// 两组用途：
//   1. **守门**：`userListResultSchema`（列表分页信封）、`wxIdentitySchema`（单账号的
//      企微绑定）。主查询的守门点在 queryFn（`useUsersQuery`）；企微绑定的守门点也在
//      queryFn（store 内的 `useQuery`），**不在 api 层** —— parse 返回深拷贝，多一层
//      等于每屏数据被校验并克隆两遍（CLAUDE.md 硬约束）。
//   2. **表单校验**：`userFormSchema`（新增 / 编辑合一）、`wxBindFormSchema`（企微绑定
//      单输入框）。替掉旧版 el-form 的内联校验规则。
//
// 本文件另有一处**非 Zod** 声明：`RoleOptionData`（角色下拉候选形状）。它服务的
// `usersConstants.ts::ROLE_OPTIONS` 是源码字面量、没有 wire 边界，运行期 parse 无消费方，
// 故只留类型、由常量用 `satisfies` 在编译期对齐。
//
// ⚠️ **必填字段必须显式声明**：Zod 默认 strip 会静默丢掉后端漏发的键，前端照样「通过」
// 校验、那一列整列失效。所以下面每个键都显式写出，且行 / 信封层用 `.strict()`
// （多一个键即抛 unrecognized_keys，后端加字段时会被这里挡住、需要同步决策）。

import { z } from 'zod';

// ============================================================
// 账号行 + 分页信封（`GET /api/v2/iam/users`）
//
// 行是后端 `UserOut`（10 字段），`roles[]` 内联在行上（角色管理走独立的
// `GET /users/{id}/roles`，但列表行的角色 tag 直接用行里的这份）。
//
// 契约要点：
//   - `id` 是**雪花 ID 字符串**（后端 serialize_i64），禁 `z.number()`（19 位 ID 在 JS
//     Number 下丢精度）；`version` / `is_active` 是 i32 / bool ⇒ number / boolean；
//   - `phone` / `last_login_at` 后端都挂 `skip_serializing_if`？—— **没有**，两个键恒在、
//     DB NULL → JSON null，故一律 `.nullable()` 而非 `.optional()`（写 `.optional()` 会让
//     「后端漏发该键」静默通过）；
//   - `created_at` / `updated_at` 是后端 naive timestamp（无时区后缀）⇒ 字符串直取。
// ============================================================

export const userRoleOutSchema = z
  .object({
    id: z.string(),
    /** `t_user_role.version`：移除角色端点的 OCC 锚（与 `t_user.version` 是两个计数器）。 */
    version: z.number(),
    role: z.string(),
    scope_type: z.string().nullable(),
    scope_id: z.string().nullable(),
    shelf_code: z.string().nullable(),
    shelf_name: z.string().nullable(),
  })
  .strict();

export type UserRoleOutData = z.infer<typeof userRoleOutSchema>;

export const userOutSchema = z
  .object({
    id: z.string(),
    /** `t_user.version`：编辑 / 停用两个写端点的 OCC 锚。 */
    version: z.number(),
    username: z.string(),
    full_name: z.string(),
    phone: z.string().nullable(),
    is_active: z.boolean(),
    /** 后端 naive timestamp 字符串；从未登录过为 null。 */
    last_login_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    roles: z.array(userRoleOutSchema),
  })
  .strict();

export type UserOutData = z.infer<typeof userOutSchema>;

/** 分页计数（`total` / `limit` / `offset`）：后端 `UserListOut` 三个字段是**裸 `i64`**
 *  ⇒ wire 上就是 JSON number（同一 VO 里挂 `serialize_i64` 的是雪花 ID 字段，不是这三个
 *  计数）。归一点在 `api/iam.ts::listUsers` 的 `normalizeListResult`（无条件 `Number()`），
 *  本 schema 只按 number 守门，不做第二次归一。
 *  ⚠️ 键必须显式声明（漏发即 parse 失败），不要用 `.optional()` 糊过去。 */
const pageCountSchema = z.number();

export const userListResultSchema = z
  .object({
    items: z.array(userOutSchema),
    total: pageCountSchema,
    limit: pageCountSchema,
    offset: pageCountSchema,
  })
  .strict();

/** 分页信封（三个计数已是 number，可直接塞进 el-pagination）。 */
export type UserListResultData = z.infer<typeof userListResultSchema>;

// ============================================================
// 企业微信绑定（`GET /api/v2/iam/users/{id}/wx-bind`）
//
// ⚠️ **未绑定时信封 data 是 `null`，不是 `[]`** —— 消费侧（企微绑定对话框）必须能
// 处理 null。下面单独导一个接受 null 的 schema，让 queryFn 一次守门覆盖两态。
// ============================================================

export const wxIdentitySchema = z
  .object({
    /** `t_wx_identity.id`：雪花 ID 字符串。 */
    id: z.string(),
    /** 企业 ID：后端只认配置值 `WECOM_CORPID`，绑定请求不接受它（后端已删该入参）。 */
    corp_id: z.string(),
    /** 企微通讯录成员 UserID（后端已 trim + 转小写）。 */
    wx_user_id: z.string(),
    /** 被绑定的系统账号 id（雪花字符串）。 */
    user_id: z.string(),
    /** 解绑端点的 OCC 锚。 */
    version: z.number(),
    created_at: z.string(),
  })
  .strict();

export type WxIdentityData = z.infer<typeof wxIdentitySchema>;

/** 绑定查询的守门 schema：绑定态 = 对象，未绑定态 = `null`。 */
export const wxIdentityOrNullSchema = wxIdentitySchema.nullable();

/** 角色下拉候选的形状（`usersConstants.ts::ROLE_OPTIONS` 用 `satisfies` 对齐它，
 *  编译期即校验，不需要运行期守门）。
 *  ⚠️ 刻意**不**用 Zod 表达：`ROLE_OPTIONS` 是源码里的字面量、没有 wire 边界，
 *  `.parse()` 在生产路径上零调用 —— 挂一个只有单测在用的 schema 是死导出。 */
export interface RoleOptionData {
  /** 后端 `UserRole` 枚举原文。 */
  value: string;
  label: string;
}

// ============================================================
// 表单 schema（替掉旧版 el-form 的内联校验规则）
// ============================================================

/** 账号表单（新增 / 编辑合一）。
 *
 *  - `username` / `full_name`：**trim 在前**（链式顺序硬约束：先 min(1) 的话「全空格」
 *    能绕过必填），长度上限 50 与后端 `users.username` / `full_name` 的列宽对齐；
 *  - `password`：**不 trim**（前后空格可能是真实凭据），编辑态**留空 = 不改密码** ⇒
 *    本 schema 从不要求 password 非空；新增态留空由调用方回落默认口令 `changeme`
 *    （沿用旧版行为，见 `usersConstants.ts::DEFAULT_PASSWORD`）。
 *  - 编辑态 username 禁用（后端不允许改用户名），禁用只是 UI 层的表达，schema 照常校验。 */
export const userFormSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(50, '用户名长度不能超过 50 个字符'),
  full_name: z.string().trim().min(1, '请输入姓名').max(50, '姓名长度不能超过 50 个字符'),
  password: z.string().max(128, '密码长度不能超过 128 个字符'),
});

export type UserFormInput = z.infer<typeof userFormSchema>;
export type UserFormFieldErrors = Partial<Record<keyof UserFormInput, string>>;

/** 企微绑定表单（单输入框）。绑定基数双向一对一 ⇒ 一次只绑一个 userid。 */
export const wxBindFormSchema = z.object({
  wx_user_id: z
    .string()
    .trim()
    .min(1, '请输入企业微信成员 UserID')
    .max(64, 'UserID 长度不能超过 64 个字符'),
});

export type WxBindFormInput = z.infer<typeof wxBindFormSchema>;
export type WxBindFormFieldErrors = Partial<Record<keyof WxBindFormInput, string>>;

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条
 *  （沿 `views/auth/loginSchema.ts` 的同款 helper）。 */
export function toFieldErrors<T extends Record<string, unknown>>(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): Partial<Record<keyof T, string>> {
  const out: Partial<Record<keyof T, string>> = {};
  for (const issue of issues) {
    const key = issue.path[0] as keyof T | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
