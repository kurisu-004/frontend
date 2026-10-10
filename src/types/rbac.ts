// src/types/rbac.ts
//
// 2026-10-14 新增：RBAC 控制面板（角色 / 授权 / 菜单树 / 权限点）的 wire 契约类型。
//
// 本文件是**纯类型声明**（零运行期代码），对应后端 iam 域的 8 个 RBAC 端点
// （`backend-rust/docs/api/iam.md` 的 RBAC 一节）：
//   GET  /api/v2/iam/roles                 → RoleDef[]
//   POST /api/v2/iam/roles                 → RoleDef
//   POST /api/v2/iam/roles/{id}/update     → RoleDef
//   POST /api/v2/iam/roles/{id}/deactivate → { affected_user_count }
//   GET  /api/v2/iam/roles/{id}/grants     → RoleGrants
//   POST /api/v2/iam/roles/{id}/grants     → RoleGrants
//   GET  /api/v2/iam/permissions           → PermissionGroup[]
//   GET  /api/v2/iam/menus                 → MenuTreeNode[]
//
// 三条贯穿全文件的 wire 约定：
//   1. **雪花 ID 一律 JSON string**（后端 `serialize_i64`），19 位 ID 在 JS `number` 下
//      丢精度 ⇒ 全链路 `string`，禁止 `Number(id)`；
//   2. `version` 是 number（乐观锁 / OCC 锚）。三个写端点（update / deactivate / grants）
//      **必收**，缺省是后端 422 纯文本而不是业务信封；
//   3. 角色 code 是**大写字符串**且不封闭枚举：内置角色是 `ADMIN` / `MANAGER` /
//      `CLERK` / `INSPECTOR` / `CNC_PROGRAMMER` / `SHELF_ACCOUNT`，管理员还能在面板里
//      自建任意 code（如 `QC_LEAD`）⇒ 一律按 `string` 表达，不写联合类型。

/** 角色定义（`GET /api/v2/iam/roles` 的行 / 新建 / 编辑的返回值）。
 *
 *  后端排序契约：`is_system DESC` 置顶（ADMIN 排第一），其余按 `code ASC`。
 *  前端左列表**直接消费后端给的顺序**，不二次排序（见 `useRolesStore` 的注释）。 */
export interface RoleDef {
  /** 雪花 ID 字符串。 */
  id: string;
  /** 角色 code：大写字符串，内置 6 个 + 管理员自建（`QC_LEAD` 等）。全局唯一、不可改
   *  （update 的 body 里 `code?` 只在新建角色首改时用）。 */
  code: string;
  /** 中文展示名（面板左列表与下拉显示的就是它）。 */
  name: string;
  /** 备注；`None` ⇒ JSON null，故 nullable 而非 optional（写 optional 会让「后端漏发
   *  该键」静默通过守门）。 */
  description: string | null;
  /** 系统内置角色（ADMIN 是元角色）。**只读**：内置角色的授权走后端全量语义，前端
   *  面板对选中 ADMIN 的那一行做 readonly 渲染，且不渲染写操作按钮。 */
  is_system: boolean;
  /** 已停用（软删）。停用后不能再被授予新账号，但已授的旧授权保留。 */
  is_active: boolean;
  /** OCC 锚：`update` / `deactivate` / `grants` 三个写端点必填。 */
  version: number;
  /** 当前有多少账号持有该角色（后端聚合列，面板左列表显示）。 */
  user_count: number;
}

/** 单个权限点（`GET /api/v2/iam/permissions` 的 `items[]` 元素）。
 *
 *  code 是**稳定业务键**（如 `part.drawing.print`），前端闸门按它判
 *  （`auth.hasPermission(code)`），不是按中文名。 */
export interface PermissionDef {
  code: string;
  name: string;
  /** 用途说明；可空（同 RoleDef.description 的 nullable 口径）。 */
  description: string | null;
  is_active: boolean;
}

/** 权限点分组（`GET /api/v2/iam/permissions` 的行）。
 *
 *  `domain` 是分组键（`part` / `queue` / `delivery_note` …），面板右区按它把权限点
 *  分组渲染成多个勾选块。 */
export interface PermissionGroupData {
  domain: string;
  items: PermissionDef[];
}

/** 单个角色的授权快照（`GET|POST /api/v2/iam/roles/{id}/grants`）。
 *
 *  **整包替换语义**（POST 的 body 就是这两个数组的全量，不是增量）：前端勾选树必须提交
 *  「当前勾上的全集」，后端直接覆盖。ADMIN（`role_code === 'ADMIN'`）返回的是**全量**
 *  菜单与权限点，前端按只读渲染、不提供提交按钮（后端也会对 ADMIN 返 400）。 */
export interface RoleGrants {
  /** 雪花 ID 字符串（与 RoleDef.id 同值，冗余返一份让面板不必 join）。 */
  role_id: string;
  role_code: string;
  is_system: boolean;
  /** OCC 锚：`POST .../grants` 必填。 */
  version: number;
  /** 已授权的菜单 code 全集（`roles_list` / `shelves_list` …，与 `MenuNode.code` 同一套
   *  取值域）。 */
  menu_codes: string[];
  /** 已授权的权限点 code 全集。 */
  permission_codes: string[];
}

/** RBAC 面板的菜单树节点（`GET /api/v2/iam/menus`）。
 *
 *  ⚠️ 与 `CurrentUser.menus` **逐字段同形**（后端同一个 `MenuNodeOut` VO），但两者是
 *  两个不同的用途：`CurrentUser.menus` 是「这个账号能看见什么菜单」（登录时随 `/iam/me`
 *  一起下发、驱动侧栏与路由守卫），本类型是「系统里一共有哪些菜单节点」（面板勾选树的
 *  数据源，ADMIN 账号恒可见）。
 *
 *  ⚠️ 守门 schema 是**同一个** `menuNodeSchema`（`@/views/auth/sessionSchema`），不要写
 *  第二份 —— 两边字段漂移会让「树能勾出来的菜单」与「侧栏实际认的菜单」分叉。 */
export interface MenuTreeNode {
  id: string;
  version: number;
  parent_id: string | null;
  /** 稳定业务键（如 `roles_list`）；与 router 的 `meta.menuCode` 同一套取值域。 */
  code: string;
  title: string;
  /** null = 分组节点（渲染成 el-sub-menu，不是一个可勾选的叶子）。 */
  path: string | null;
  icon: string | null;
  sort_order: number;
  children: MenuTreeNode[];
}
