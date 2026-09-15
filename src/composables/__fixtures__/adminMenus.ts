// src/composables/__fixtures__/adminMenus.ts
// 2026-09-16 同步 backend-rust sqlx migration 025：
//   - 货架（shelves_list）从 floor_group 移到 auth_group，与 users_list / workers_list 同组
//     （sort_order 30）。业务上货架归属权限管理范畴。
//   - 扫码台（scan_badge）从 floor_group 升级为顶级菜单（sort_order 13，紧跟
//     production_stats=12 之后），path=/scan（router /scan → /scan/badge 重定向）。
//   - 车间（floor_group）软删：子项全部迁出后保留空分组节点（comment-only soft-delete，
//     与 backend-rust 025 的 `is_active=false` 等价语义；MenuNode 类型未含 is_active
//     字段故不在 TS 里表达，靠注释 + 路由层 `meta.menuCode` 缺失自然失效来兜底）。
// 2026-09-16 print_templates_designer path 修复：/print-templates/designer → /print-templates，
// 对齐 router/index.ts:359-369 单路由（router path 已统一为 /print-templates）。
// 2026-09-16 part_process_chain path 已是 /production/process-design（router 已对齐），无需改路径。
// 2026-09-14 同步自生产 DB：admin 角色的完整菜单树（11 顶级 + 21 子项 leaf + 1 新顶级 scan_badge = 33 code）。
// 2026-09-14 新增 template_management（模板管理）顶级分组（sort_order=27，production_group=26 之后），
// 含 print_templates_designer（模板编辑）。
// 2026-09-14 menuCode 改名：process_design_list → part_process_chain（对齐后端 t_menu migration 017/018/021）。
// 2026-09-14 path 对齐 router：part_process_chain.path = /production/process-design。
// 2026-09-11 新增 production_group（生产管理）顶级分组，含 part_process_chain（工序制定）+ worker_queue（从 auth_group 迁出）。
// 2026-09-12 合并 fc99d3b tabbed 页：production_group 新增 process_work_type（工序工种，/production/process-work-type）。
// settings_root 暂时保留（fc99d3b 后端 migration 已软删，但前端 fixture 仍挂 3 个旧子菜单码以兜底路由守卫，
// 待后端菜单树彻底下架 settings_root 后再移除）。
// floor_group 软删保留（2026-09-16，迁 shelves_list 后无子项；待后端彻底下架再移除 fixture 行；
// __tests__/adminMenus.spec.ts 断言 floor_group 必须存在，故暂不能删）。
// 仅 dev dummy-auth 模式使用（initDummyAuth 注入 useAuthSession.user.menus）；
// prod bundle 不引用此文件（无 dead code 风险）。
//
// 数据来源：实际生产环境登录响应（USER / 15060779955 的 /auth/login 返回 data.menus）。
// 维护纪律：每次后端菜单树（t_menu）变更，必须把生产最新响应粘到这里同步；否则 dummy
// 模式下侧栏显示与生产不一致，且 menuCode 不存在的子项会被守卫降级踢走。
//
// 注：本 fixture 的 ID 用 `id(n)` 生成的假雪花 ID，**不**复用生产真 ID——fixture 是 dev-only
// 假数据，混用真实 ID 易让后续维护者误以为是后端快照。
//
// 改动后必须验证：
//   1. 每个 MenuNode.code 是 router/index.ts 里某条路由的 meta.menuCode
//   2. 每个 MenuNode.icon 在 MenuTreeItem.vue 的 ICON_MAP 中存在
//   3. leaf 节点（path 非 null 且 children 为空）数 = 路由可点击菜单数 = 24

import type { MenuNode } from '@/types/menu';

const id = (n: number) => `99999${String(n).padStart(10, '0')}`;

export const ADMIN_MENUS: MenuNode[] = [
  // 1. home — 首页（顶级，leaf）
  {
    id: id(1),
    version: 0,
    parent_id: null,
    code: 'home',
    title: '首页',
    path: '/dashboard',
    icon: 'House',
    sort_order: 10,
    children: [],
  },
  // 2. production_stats — 生产统计（顶级，leaf）
  {
    id: id(2),
    version: 0,
    parent_id: null,
    code: 'production_stats',
    title: '生产统计',
    path: '/statistics',
    icon: 'DataAnalysis',
    sort_order: 12,
    children: [],
  },
  // 3. customer_management — 客户管理（分组，2 children）
  {
    id: id(3),
    version: 0,
    parent_id: null,
    code: 'customer_management',
    title: '客户管理',
    path: null,
    icon: 'OfficeBuilding',
    sort_order: 15,
    children: [
      {
        id: id(31),
        version: 0,
        parent_id: id(3),
        code: 'customers_list',
        title: '客户一览',
        path: '/customers',
        icon: 'Connection',
        sort_order: 10,
        children: [],
      },
      {
        id: id(32),
        version: 0,
        parent_id: id(3),
        code: 'applicants_list',
        title: '申请人一览',
        path: '/applicants',
        icon: 'User',
        sort_order: 20,
        children: [],
      },
    ],
  },
  // 4. order_group — 订单管理（分组，6 children）
  {
    id: id(4),
    version: 0,
    parent_id: null,
    code: 'order_group',
    title: '订单管理',
    path: null,
    icon: 'Tickets',
    sort_order: 20,
    children: [
      {
        id: id(41),
        version: 0,
        parent_id: id(4),
        code: 'parts_list',
        title: '零件一览',
        path: '/parts',
        icon: 'Box',
        sort_order: 10,
        children: [],
      },
      {
        id: id(42),
        version: 0,
        parent_id: id(4),
        code: 'parts_new',
        title: '新建零件',
        path: '/parts/new',
        icon: 'Plus',
        sort_order: 20,
        children: [],
      },
      {
        id: id(43),
        version: 0,
        parent_id: id(4),
        code: 'delivery_notes_manage',
        title: '送货单',
        path: '/delivery-notes',
        icon: 'Document',
        sort_order: 30,
        children: [],
      },
      {
        id: id(44),
        version: 0,
        parent_id: id(4),
        code: 'inspection_pending',
        title: '待品检',
        path: '/inspection/pending',
        icon: 'CircleCheck',
        sort_order: 50,
        children: [],
      },
      {
        id: id(45),
        version: 0,
        parent_id: id(4),
        code: 'delivery_dispatch',
        title: '送货',
        path: '/delivery-dispatch',
        icon: 'Van',
        sort_order: 60,
        children: [],
      },
      {
        id: id(46),
        version: 0,
        parent_id: id(4),
        code: 'repair_receive',
        title: '返修接收',
        path: '/repair/receive',
        icon: 'Tools',
        sort_order: 65,
        children: [],
      },
    ],
  },
  // 5. pending_programming — 待编程一览（顶级，leaf）
  {
    id: id(5),
    version: 0,
    parent_id: null,
    code: 'pending_programming',
    title: '待编程一览',
    path: '/cnc/pending',
    icon: 'Cpu',
    sort_order: 25,
    children: [],
  },
  // 6. production_group — 生产管理（分组，3 children）
  // 2026-09-11 首次落地：worker_queue 从 auth_group 迁出，与 part_process_chain 同组。
  // 2026-09-12 合并 fc99d3b tabbed 页：process_work_type 也挂这里（router /production/process-work-type）。
  // 介于 pending_programming(25) 和 auth_group(30) 之间；后续「扫工件」「条码打印」等生产侧功能都挂这里。
  {
    id: id(10),
    version: 0,
    parent_id: null,
    code: 'production_group',
    title: '生产管理',
    path: null,
    icon: 'Operation',
    sort_order: 26,
    children: [
      {
        id: id(103),
        version: 0,
        parent_id: id(10),
        code: 'process_work_type',
        title: '工序工种',
        path: '/production/process-work-type',
        icon: 'Operation',
        sort_order: 5,
        children: [],
      },
      {
        // 2026-09-14 menuCode 改名：process_design_list → part_process_chain
        // 对齐后端 t_menu（migration 017/018/021）code；前端 router 也同步改名。
        id: id(101),
        version: 0,
        parent_id: id(10),
        code: 'part_process_chain',
        title: '工序制定',
        path: '/production/process-design',
        icon: 'SetUp',
        sort_order: 10,
        children: [],
      },
      {
        id: id(102),
        version: 0,
        parent_id: id(10),
        code: 'worker_queue',
        title: '生产队列',
        path: '/workers/queue',
        icon: 'Operation',
        sort_order: 20,
        children: [],
      },
    ],
  },
  // 7. auth_group — 权限管理（分组，2 children）
  // 2026-09-11：worker_queue 迁到 production_group，本分组现仅含 workers_list + users_list。
  {
    // 2026-09-14 新增：template_management 顶级分组（sort_order=27，挂在
    // production_group=26 之后、auth_group=30 之前），含 print_templates_designer
    // 二级菜单（router /print-templates）。后端 t_menu 由 backend-rust
    // implementor 在另一 worktree 的 migration 同步写。PrintTemplateDesigner 不接
    // 后端 API（用户决策），仍跑 localStorage；菜单树只为权限 + 侧栏展示。
    // 2026-09-16 path 改 /print-templates 对齐 router，dev dummy 也跟上（router
    // 真实 path 是 /print-templates，dev dummy 之前写 /print-templates/designer
    // 已被 MenuTreeItem 渲染成死链）。
    id: id(11),
    version: 0,
    parent_id: null,
    code: 'template_management',
    title: '模板管理',
    path: null,
    icon: 'Document',
    sort_order: 27,
    children: [
      {
        id: id(111),
        version: 0,
        parent_id: id(11),
        code: 'print_templates_designer',
        title: '模板编辑',
        path: '/print-templates',
        icon: 'Printer',
        sort_order: 10,
        children: [],
      },
    ],
  },
  {
    id: id(6),
    version: 0,
    parent_id: null,
    code: 'auth_group',
    title: '权限管理',
    path: null,
    icon: 'Key',
    sort_order: 30,
    children: [
      {
        id: id(61),
        version: 0,
        parent_id: id(6),
        code: 'workers_list',
        title: '工人一览',
        path: '/workers',
        icon: 'User',
        sort_order: 10,
        children: [],
      },
      {
        id: id(62),
        version: 0,
        parent_id: id(6),
        code: 'users_list',
        title: '账号管理',
        path: '/users',
        icon: 'List',
        sort_order: 20,
        children: [],
      },
      {
        // 2026-09-16 从 floor_group 迁入：业务上货架归属权限管理（与工人/账号同类）。
        // backend-rust 025 同步；dev dummy 与生产对齐。sort_order=30 接在 users_list=20 之后。
        id: id(63),
        version: 0,
        parent_id: id(6),
        code: 'shelves_list',
        title: '货架管理',
        path: '/shelves',
        icon: 'Platform',
        sort_order: 30,
        children: [],
      },
    ],
  },
  // 8. outsource_list — 外协管理（分组，3 children）
  {
    id: id(7),
    version: 0,
    parent_id: null,
    code: 'outsource_list',
    title: '外协管理',
    path: null,
    icon: 'Promotion',
    sort_order: 35,
    children: [
      {
        id: id(71),
        version: 0,
        parent_id: id(7),
        code: 'outsource_companies_list',
        title: '外协厂一览',
        path: '/outsource/companies',
        icon: 'OfficeBuilding',
        sort_order: 10,
        children: [],
      },
      {
        id: id(72),
        version: 0,
        parent_id: id(7),
        code: 'outsource_quotes_list',
        title: '报价一览',
        path: '/outsource/quotes',
        icon: 'Document',
        sort_order: 20,
        children: [],
      },
      {
        id: id(73),
        version: 0,
        parent_id: id(7),
        code: 'outsource_send_receive_list',
        title: '外协发送/接收',
        path: '/outsource/send-receive',
        icon: 'Promotion',
        sort_order: 30,
        children: [],
      },
    ],
  },
  // 9. floor_group — 车间（软删分组，0 children）
  // 2026-09-16 停用，业务归入权限管理；保留行便于回滚 + __tests__ 断言。
  // backend-rust 025 对应 `is_active=false`；前端 MenuNode 类型无 is_active 字段，
  // 软删语义靠「无 children」+ 无路由 meta.menuCode 自然失效来兜底。
  {
    id: id(8),
    version: 0,
    parent_id: null,
    code: 'floor_group',
    title: '车间',
    path: null,
    icon: 'Tools',
    sort_order: 40,
    children: [],
  },
  // 2026-09-16 新增顶级菜单：scan_badge 扫码台（从 floor_group 升级，sort_order=13
  // 紧跟 production_stats=12 之后、customer_management=15 之前）。path=/scan
  // （router /scan → /scan/badge 重定向；meta.menuCode=scan_badge 见 router/index.ts:382）。
  // backend-rust 025 同步提升；router 早已就绪（5 个子路由共用 scan_badge menuCode）。
  // icon=Operation：表达「操作台/工位」语义；与 production_group 主图标同名是历史
  // 既有约定（auth_group 内 Platform / work_types_list User 等也复用同名），侧栏
  // 仍靠 title 区分。Cellphone 暂不引入 ICON_MAP（菜单图标导入白名单收敛约束）。
  {
    id: id(12),
    version: 0,
    parent_id: null,
    code: 'scan_badge',
    title: '扫码台',
    path: '/scan',
    icon: 'Operation',
    sort_order: 13,
    children: [],
  },
  // 10. settings_root — 设置（分组，3 children）
  {
    id: id(9),
    version: 0,
    parent_id: null,
    code: 'settings_root',
    title: '设置',
    path: null,
    icon: 'Setting',
    sort_order: 50,
    children: [
      {
        id: id(91),
        version: 0,
        parent_id: id(9),
        code: 'work_types_list',
        title: '工种管理',
        path: '/settings/work-types',
        icon: 'User',
        sort_order: 10,
        children: [],
      },
      {
        id: id(92),
        version: 0,
        parent_id: id(9),
        code: 'processes_list',
        title: '工序管理',
        path: '/settings/processes',
        icon: 'Operation',
        sort_order: 20,
        children: [],
      },
      {
        id: id(93),
        version: 0,
        parent_id: id(9),
        code: 'work_type_processes_list',
        title: '工种-工序映射',
        path: '/settings/work-type-processes',
        icon: 'Connection',
        sort_order: 30,
        children: [],
      },
    ],
  },
];
