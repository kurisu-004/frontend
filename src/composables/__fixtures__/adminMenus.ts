// src/composables/__fixtures__/adminMenus.ts
// 2026-08-26 新增：admin 角色的完整菜单树（22 个 menuCode 全集）。
// 仅 dev dummy-auth 模式使用（initDummyAuth 注入 useAuthSession.user.menus）；
// prod bundle 不引用此文件（无 dead code 风险）。
//
// menuCode 来源：`grep menuCode src/router/index.ts` 提取 + 与路由一一对齐。
// 修改 router 时（如新增 menuCode），这里必须同步更新，否则 dummy 模式下该路由被守卫降级踢走。

import type { MenuNode } from '@/types/menu'

const id = (n: number) => `99999${String(n).padStart(10, '0')}`

export const ADMIN_MENUS: MenuNode[] = [
  // 顶级：首页
  {
    id: id(1), version: 1, parent_id: null,
    code: 'home', title: '首页', path: '/dashboard',
    icon: 'House', sort_order: 1, children: [],
  },
  // 订单管理分组
  {
    id: id(2), version: 1, parent_id: null,
    code: 'orders_group', title: '订单管理', path: null,
    icon: 'Document', sort_order: 2, children: [
      { id: id(21), version: 1, parent_id: id(2), code: 'parts_list', title: '零件列表', path: '/parts', icon: 'Box', sort_order: 1, children: [] },
      { id: id(22), version: 1, parent_id: id(2), code: 'parts_new', title: '新建零件', path: '/parts/new', icon: 'Plus', sort_order: 2, children: [] },
      { id: id(23), version: 1, parent_id: id(2), code: 'inspection_pending', title: '待检零件', path: '/inspection/pending', icon: 'Search', sort_order: 3, children: [] },
      { id: id(24), version: 1, parent_id: id(2), code: 'repair_receive', title: '返修接收', path: '/repair/receive', icon: 'Tools', sort_order: 4, children: [] },
      { id: id(25), version: 1, parent_id: id(2), code: 'pending_programming', title: '待编程', path: '/cnc/pending', icon: 'Cpu', sort_order: 5, children: [] },
      { id: id(26), version: 1, parent_id: id(2), code: 'delivery_notes_manage', title: '送货单', path: '/delivery-notes', icon: 'Van', sort_order: 6, children: [] },
    ],
  },
  // 外协管理分组
  {
    id: id(3), version: 1, parent_id: null,
    code: 'outsource_group', title: '外协管理', path: null,
    icon: 'Connection', sort_order: 3, children: [
      { id: id(31), version: 1, parent_id: id(3), code: 'outsource_companies_list', title: '外协商', path: '/outsource/companies', icon: 'OfficeBuilding', sort_order: 1, children: [] },
      { id: id(32), version: 1, parent_id: id(3), code: 'outsource_quotes_list', title: '外协报价', path: '/outsource/quotes', icon: 'Money', sort_order: 2, children: [] },
      { id: id(33), version: 1, parent_id: id(3), code: 'outsource_send_receive_list', title: '外协收发', path: '/outsource/send-receive', icon: 'Promotion', sort_order: 3, children: [] },
    ],
  },
  // 权限管理分组
  {
    id: id(4), version: 1, parent_id: null,
    code: 'permissions_group', title: '权限管理', path: null,
    icon: 'Lock', sort_order: 4, children: [
      { id: id(41), version: 1, parent_id: id(4), code: 'workers_list', title: '工人一览', path: '/workers', icon: 'User', sort_order: 1, children: [] },
      { id: id(42), version: 1, parent_id: id(4), code: 'worker_queue', title: '工人队列调度', path: '/workers/queue', icon: 'Operation', sort_order: 2, children: [] },
      { id: id(43), version: 1, parent_id: id(4), code: 'users_list', title: '账号管理', path: '/users', icon: 'Key', sort_order: 3, children: [] },
    ],
  },
  // 车间
  {
    id: id(5), version: 1, parent_id: null,
    code: 'shelves_list', title: '货架管理', path: '/shelves',
    icon: 'Platform', sort_order: 5, children: [],
  },
  // 客户管理分组
  {
    id: id(6), version: 1, parent_id: null,
    code: 'customers_group', title: '客户管理', path: null,
    icon: 'Avatar', sort_order: 6, children: [
      { id: id(61), version: 1, parent_id: id(6), code: 'customers_list', title: '客户', path: '/customers', icon: 'UserFilled', sort_order: 1, children: [] },
      { id: id(62), version: 1, parent_id: id(6), code: 'applicants_list', title: '申请人', path: '/applicants', icon: 'Postcard', sort_order: 2, children: [] },
    ],
  },
  // 设置分组
  {
    id: id(7), version: 1, parent_id: null,
    code: 'settings_group', title: '设置', path: null,
    icon: 'Setting', sort_order: 7, children: [
      { id: id(71), version: 1, parent_id: id(7), code: 'work_types_list', title: '工种', path: '/settings/work-types', icon: 'CollectionTag', sort_order: 1, children: [] },
      { id: id(72), version: 1, parent_id: id(7), code: 'processes_list', title: '工序', path: '/settings/processes', icon: 'Operation', sort_order: 2, children: [] },
      { id: id(73), version: 1, parent_id: id(7), code: 'work_type_processes_list', title: '工种工序绑定', path: '/settings/work-type-processes', icon: 'Connection', sort_order: 3, children: [] },
    ],
  },
  // 顶级：统计
  {
    id: id(8), version: 1, parent_id: null,
    code: 'production_stats', title: '生产统计', path: '/statistics',
    icon: 'DataAnalysis', sort_order: 8, children: [],
  },
  // 顶级：扫码（共用 menuCode 'scan_badge'，按 router allowRoles 短路）
  {
    id: id(9), version: 1, parent_id: null,
    code: 'scan_badge', title: '工人扫码', path: '/scan',
    icon: 'PriceTag', sort_order: 9, children: [],
  },
  // 顶级：送货调度（共用 menuCode 'delivery_dispatch'）
  {
    id: id(10), version: 1, parent_id: null,
    code: 'delivery_dispatch', title: '送货调度', path: '/delivery-dispatch',
    icon: 'TakeawayBox', sort_order: 10, children: [],
  },
]
