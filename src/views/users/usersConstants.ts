// src/views/users/usersConstants.ts
//
// 2026-10-10 新增：账号管理域的角色候选与口令常量。单域专用文件，与页面主组件
// （UserList.vue）同层放域根 —— `src/utils/` 只放跨域通用工具。
//
// 为什么从 UserList.vue 提出来：旧版把 `ROLE_OPTIONS` 内联在 SFC 的 `<script setup>`
// 里，角色下拉与「加完 SHELF_ACCOUNT 要重新登录才生效」的分支都读它。内联导致列定义 /
// 角色对话框 / 单测三处各写一份字面量（改中文 label 要改三处）。
//
// `satisfies` 是这里的守卫：候选的形状由 `RoleOptionData` 单点定义，改字面量时形状漂移
// 会在 `vue-tsc` 阶段报错（`vue-tsc --noEmit` 是本仓 gate 之一）。

import type { RoleOptionData } from './usersSchema';

/** 5 个角色的下拉候选（value = 后端 `UserRole` 枚举原文，label = 中文展示）。
 *  全量暴露：SHELF_ACCOUNT 之外的角色不绑货架，scope 必须为 null（见 RoleDialog）。 */
export const ROLE_OPTIONS = [
  { value: 'MANAGER', label: '管理员' },
  { value: 'CLERK', label: '文员' },
  { value: 'SHELF_ACCOUNT', label: '货架一体机账号' },
  { value: 'INSPECTOR', label: '品检员' },
  { value: 'CNC_PROGRAMMER', label: 'CNC 编程员' },
] satisfies ReadonlyArray<RoleOptionData>;

/** 需要绑货架范围的角色（其余角色加的时候 scope 恒为 null）。 */
export const SHELF_SCOPED_ROLE = 'SHELF_ACCOUNT';

/** 默认口令：新增时密码留空 = 用它；重置密码端点也重置成它（与后端同源）。 */
export const DEFAULT_PASSWORD = 'changeme';

/** 操作列「重置密码」的二次确认文案（与旧版逐字一致）。
 *  唯一消费方是 `usersColumnDefs.ts` 的操作列 `ElPopconfirm` —— 改文案只改这里一处。 */
export const RESET_PASSWORD_CONFIRM_TEXT = '确认重置为默认密码 changeme？';
