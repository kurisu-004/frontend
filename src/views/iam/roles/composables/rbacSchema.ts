// src/views/iam/roles/composables/rbacSchema.ts
//
// 2026-10-14 新增：RBAC 控制面板的 Zod 守门 schema（角色行 / 授权包 / 权限点分组 /
// 新建-改名表单），与主查询 hook（`./useRolesQuery`）同居域内 `composables/`。
//
// ⚠️ **这里的口径与认证链路刻意相反**，两者构成一组必须成对维护的对照：
//
//   | 本文件（RBAC 面板，**写侧**）          | `views/auth/sessionSchema`（会话，读侧） |
//   |--------------------------------------|------------------------------------------|
//   | **接 `.strict()`**（多一个键即抛错）  | **不接** `.strict()`（未知键 strip 掉）   |
//   | 后端加字段 ⇒ 本 spec 立刻红，要决策   | 后端加字段 ⇒ 照常通过                   |
//   | 守门失败 = 面板这一屏不可用            | 守门失败 = **全站**不可用               |
//
// 理由：面板是**管理员在写权限**的界面，页面上呈现的每一项都对应一次真实的授权决定。
// 后端悄悄加一个字段（多授了一类菜单 / 多返一个权限点）而前端没跟进 ⇒ 管理员看着一份
// 「完整」的授权清单，实际生效的却比他以为的多/少 ⇒ 这正是必须在守门层当场炸掉的漂移。
// 认证链路相反：那里加字段是常态（派生字段天天加），炸掉的后果是全员登不进去。
//
// ⚠️ **必填字段必须显式声明**：Zod 默认 strip 会静默丢掉后端漏发的键，前端照样「通过」
// 校验、那一项整块失效（菜单树上少一个节点、权限点少一个码，且**没有任何报错**）。
//
// 菜单树守门 schema 用会话链路的 `views/auth/sessionSchema::menuNodeSchema`（**不是**
// 本文件里的第二份，也**不在本文件 re-export**）：`GET /iam/menus` 与 `/iam/me` 的
// menus 是同一个后端 VO、逐字段同形，两份 schema 各写一遍时字段漂移会让「能在面板里
// 勾出来的菜单」与「侧栏实际认的菜单」分叉 —— 而后端只认后者。消费方（
// `useRolesQuery` / `RoleGrantsPanel` / 测试）直接从会话路径 import。

import { z } from 'zod';

// ============================================================
// 角色行（`GET /api/v2/iam/roles`）
//
// 与 `views/users/usersSchema.ts` 的账号行同款口径：雪花 ID 走字符串、nullable 键显式
// 标 `.nullable()`（写 `.optional()` 会让「后端漏发该键」静默通过）。但**多一个键就抛**
// （.strict()），理由见文件头。
// ============================================================

export const roleDefSchema = z
  .object({
    /** 雪花 ID 字符串（19 位在 JS Number 下丢精度）。 */
    id: z.string(),
    /** 大写 code；内置 6 个之外，管理员可自建（`QC_LEAD` 等）⇒ 不锁枚举。 */
    code: z.string(),
    /** 中文展示名。 */
    name: z.string(),
    /** 备注；DB NULL ⇒ JSON null。 */
    description: z.string().nullable(),
    /** 系统内置角色（ADMIN 是元角色）。前端据此把该行渲染成只读。 */
    is_system: z.boolean(),
    is_active: z.boolean(),
    /** OCC 锚：update / deactivate / grants 三个写端点必填。 */
    version: z.number(),
    /** 持有该角色的账号数（后端聚合列）。 */
    user_count: z.number(),
  })
  .strict();

export type RoleDefData = z.infer<typeof roleDefSchema>;

/** 角色列表（端点一次性返全部，无分页信封）。 */
export const roleDefListSchema = z.array(roleDefSchema);

// ============================================================
// 单角色授权包（`GET|POST /api/v2/iam/roles/{id}/grants`）
// ============================================================

export const roleGrantsSchema = z
  .object({
    role_id: z.string(),
    role_code: z.string(),
    is_system: z.boolean(),
    /** OCC 锚：POST grants 必填。 */
    version: z.number(),
    /** 已授权菜单 code 全集（整包替换语义，不是增量）。 */
    menu_codes: z.array(z.string()),
    /** 已授权权限点 code 全集（整包替换语义，不是增量）。 */
    permission_codes: z.array(z.string()),
  })
  .strict();

export type RoleGrantsData = z.infer<typeof roleGrantsSchema>;

// ============================================================
// 权限点分组（`GET /api/v2/iam/permissions`）
// ============================================================

export const permissionDefSchema = z
  .object({
    /** 稳定业务键，前端闸门按它判（`auth.hasPermission(code)`）。 */
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    is_active: z.boolean(),
  })
  .strict();

export type PermissionDefData = z.infer<typeof permissionDefSchema>;

export const permissionGroupSchema = z
  .object({
    /** 分组键（`part` / `queue` / `delivery_note` …），面板右区按它分块渲染。 */
    domain: z.string(),
    items: z.array(permissionDefSchema),
  })
  .strict();

export type PermissionGroup = z.infer<typeof permissionGroupSchema>;

/** 权限点全集（按 domain 分组的裸数组，无分页信封）。 */
export const permissionGroupListSchema = z.array(permissionGroupSchema);

// ============================================================
// 表单 schema（新建 / 改名合一）
// ============================================================

/**
 * 角色表单（新建 + 改名合一）。
 *
 * - `code`：**新建时必填、改名时留空表示不改**（后端 update 的 `code?` 省略即不改；
 *   留空即不传该键，不是传空串）。chain 上 trim 在 max / transform 之前（仓内 Zod
 *   硬约束：先 min(1) 的话「全空格」能绕过必填）；trim 后统一大写再校字符集，与后端
 *   `[A-Z0-9_]` + code 长度上限（≤ 20）的归一一致 —— 前端先收窄，不让管理员提交一个
 *   必然被后端 400 拒绝的值。
 * - `name`：中英文名，长度上限 50 与后端列宽对齐。
 */
export const ROLE_CODE_MAX_LEN = 20;

/** 角色 code 的字符集：大写字母、数字、下划线（与后端约束逐字一致）。 */
const ROLE_CODE_PATTERN = /^[A-Z0-9_]*$/;

export const roleFormSchema = z.object({
  code: z
    .string()
    .trim()
    .max(ROLE_CODE_MAX_LEN, `角色代码长度不能超过 ${ROLE_CODE_MAX_LEN} 个字符`)
    .transform((v) => v.toUpperCase())
    .refine(
      (v) => ROLE_CODE_PATTERN.test(v),
      '角色代码只能包含大写字母、数字和下划线（小写会自动转大写）',
    ),
  name: z.string().trim().min(1, '请输入角色名称').max(50, '角色名称长度不能超过 50 个字符'),
  description: z.string().trim().max(200, '备注长度不能超过 200 个字符'),
});

export type RoleFormInput = z.infer<typeof roleFormSchema>;
export type RoleFormFieldErrors = Partial<Record<keyof RoleFormInput, string>>;

/** 把 ZodIssue 列表按字段聚合到字段错误表；同字段多 issue 只取第一条
 *  （沿 `views/users/usersSchema.ts` 的同款 helper）。 */
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
