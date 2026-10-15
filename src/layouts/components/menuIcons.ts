// src/layouts/components/menuIcons.ts
//
// 2026-10-14 新增：侧栏菜单图标白名单（从 `MenuTreeItem.vue` 抽到独立模块）。
// 抽出的唯一理由是**可测试性**：spec 要断言「菜单节点的 icon 在真实白名单内」——
// 白名单留在组件里时，spec 只能自己再抄一份（把组件里的图标删掉，抄来的那份照样绿，
// 断言等于自证）。
//
// ⚠️ 新增菜单图标时必须在此补充命名导入：全量 `import * as ElIcons` 会把约 300 个图标
// 拉进 bundle（tree-shaking 失效），而映射里查不到的图标在模板中 `v-if` 静默隐藏
// （不报错）—— 漏补一行的表现是侧栏图标消失而无人察觉。

import {
  House,
  Box,
  CircleCheck,
  Tools,
  Cpu,
  OfficeBuilding,
  Document,
  Promotion,
  User,
  Key,
  Platform,
  DataAnalysis,
  Connection,
  // 2026-08-22：补全侧栏 6 个缺失图标（订单管理/新建零件/送货/
  // 账号管理/设置/工序管理）。
  Tickets,
  Plus,
  Van,
  Setting,
  Operation,
  // 2026-08-26：新增 users_list 用的 List。
  List,
  // 2026-09-11：工序制定（part_process_chain）用 SetUp
  SetUp,
  // 2026-10-13：新增「定时任务/邮件」分组（Clock）与「交期汇总邮件」子菜单（Message）。
  Clock,
  Message,
  // 2026-10-14：RBAC 角色权限（roles_list）用 Lock，与生产 t_menu.icon 对齐
  // （父节点 auth_group 是 Key，两者刻意区分）。
  Lock,
  // 2026-10-17：新增「企业微信」子菜单（wecom，与定时任务下的 mail 同级）用 ChatDotRound。
  // ⚠️ 漏掉这一行的话，`MenuTreeItem.vue` 的 `ICON_MAP[icon]` 查不到 → `v-if` **静默隐藏**
  //   （不报错），表现为侧栏「企业微信」那一项没有图标而无人察觉。
  ChatDotRound,
  // 2026-10-19：新增「人事管理」分组（hr_group，用 Avatar）与「排班日历」子菜单
  // （hr_schedule_calendar，用 Calendar）。⚠️ 漏掉这两行命名导入的话，
  // `MenuTreeItem.vue` 的 `ICON_MAP[icon]` 查不到 → 模板 `v-if="iconComp"` **静默隐藏**
  // （不报错），表现为侧栏这两项没有图标而无人察觉。
  Avatar,
  Calendar,
} from '@element-plus/icons-vue';

/** 图标名 → 组件（覆盖 router `meta.icon` 与后端菜单树 `t_menu.icon` 的取值域）。 */
export const ICON_MAP: Record<string, unknown> = {
  House,
  Box,
  CircleCheck,
  Tools,
  Cpu,
  OfficeBuilding,
  Document,
  Promotion,
  User,
  Key,
  Platform,
  DataAnalysis,
  Connection,
  Tickets,
  Plus,
  Van,
  Setting,
  Operation,
  List,
  SetUp,
  Clock,
  Message,
  Lock,
  ChatDotRound,
  Avatar,
  Calendar,
};
