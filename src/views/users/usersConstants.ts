// src/views/users/usersConstants.ts
//
// 2026-10-10 新增：账号管理域的角色候选与口令常量。单域专用文件，与页面主组件
// （UserList.vue）同层放域根 —— `src/utils/` 只放跨域通用工具。
//
// 2026-10-14（RBAC 控制面板）：**`ROLE_OPTIONS` 已删除**。角色下拉的候选改由
// `GET /api/v2/iam/roles`（`qk.rolesList()`）动态供给 —— 角色不再封闭在后端 enum 里，
// 管理员可以在面板自建任意 code（如 `QC_LEAD`）。写死字面量的症状不是「多了几个角色
// 没显示」，而是**自定义角色根本无法授予给任何账号**，且界面上一片正常。
// 消费方：`composables/useUsersListStore.ts` 的 `options.roleOptions`（共享
// `useRolesQuery`，与 RBAC 面板左列表同一条 queryKey ⇒ 同屏去重）。
//
// 负向守卫见 `composables/__tests__/usersSchema.spec.ts`：断言本文件不再出现
// 角色候选字面量（`ROLE_OPTIONS` 已被删除，任何「复活」都应改成走 API）。

/** 需要绑货架范围的角色（其余角色加的时候 scope 恒为 null）。
 *
 *  ⚠️ 它是**业务分支判据**、不是角色候选清单：SHELF_ACCOUNT 之外的加法一律 scope=null，
 *  且新增角色时前端要判断「这个角色要不要绑货架」。角色清单本身走 API。 */
export const SHELF_SCOPED_ROLE = 'SHELF_ACCOUNT';

/** 默认口令：新增时密码留空 = 用它；重置密码端点也重置成它（与后端同源）。 */
export const DEFAULT_PASSWORD = 'changeme';

/** 操作列「重置密码」的二次确认文案（与旧版逐字一致）。
 *  唯一消费方是 `usersColumnDefs.ts` 的操作列 `ElPopconfirm` —— 改文案只改这里一处。 */
export const RESET_PASSWORD_CONFIRM_TEXT = '确认重置为默认密码 changeme？';
