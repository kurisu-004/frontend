// src/composables/__fixtures__/adminMenus.ts
// 2026-10-16 review 第 1 轮 MAJOR-1 同步 backend-rust seeds/menu.sql（送货单打印模板）：
//   - **复活** `template_management` 一级分组（2026-09-24 随 x-data-spreadsheet 弃用整段
//     从本 fixture 删除，但后端 t_menu 里那两行从未被软删、rbac.sql 也一直给 MANAGER 授
//     权 —— 于是 dummy 模式下侧栏不出现该菜单、直接敲 `/print-templates` 会被路由守卫
//     第 3 条踢回首菜单。生产模式用后端真实菜单树不受影响，但 fixture 与后端脱节本身就是
//     本文件纪律（见下方「维护纪律」）要防的事）。
//   - 其下子菜单 `print_templates_designer`，path `/print-templates`（与 router 的
//     `path: 'print-templates'` 逐字一致）、sort_order 10、icon Document。
//   - ⚠️ **数组物理位置插在 production_group 与 auth_group 之间**（sort_order 28 落在两者
//     之间）：侧栏按数组顺序渲染、不排 sort_order，「menu tree is in ascending sort_order」
//     守的正是数组物理序。
//   - ⚠️ **id 用后端 seed 字面量**（`9000000000000008` / `9000000000000701`），同
//     `scheduled_task` 那两个节点的既有做法：id 是唯一能把「2026-09-24 只是从 fixture 里
//     删掉、后端从未软删」与「后端换了新行」区分开的标识。
// 2026-10-17 同步 backend-rust seeds/menu.sql（企业微信推送子模块）：
//   - `scheduled_task` 分组下**新增**二级子菜单 `wecom`「企业微信」，path `/wecom`
//     （与 router 的 `path: 'wecom'` 逐字一致）、sort_order **20**（排在 mail(10) 之后）、
//     icon `ChatDotRound`、id `9000000000000903`。
//     **path 与 API 前缀无关**：前端书签 URL 是 `/wecom`，后端 API 是
//     `/api/v2/cron/wecom/*`（2026-10-17 随定时任务域的 `/cron/` 归拢同批硬切），两层不
//     要求一致 —— 与 `shelves` / `iam/roles` / `mail` 同款做法。将来改 API 前缀时不要连带
//     改这里：它同时是浏览器书签 URL 与后端 `t_menu.path` 的值。
//   - ⚠️ **数组物理位置紧跟 mail 之后**（渲染链路没有排序），且 `id` 用后端 seed 字面量
//     （`9000000000000903`），理由同上面那两个节点：id 是唯一能把「后端从未有过这行」与
//     「后端换了新行」区分开的标识。
// 2026-10-16 同步 backend-rust seeds/menu.sql（定时任务域改名 + 邮件多账号）：
//   - 一级分组 **改 code**：`mail_group` → `scheduled_task`，title 由「定时任务/邮件」
//     收敛为「定时任务」，sort_order 仍 45、icon 仍 Clock、path 仍 NULL。
//     **为什么换 code**：菜单 code 是**权限与路由的连接键**（`meta.menuCode` 必须与它逐字
//     一致，不一致会被路由守卫第 3 条踢回首一个有 path 的节点）。旧 code 的名字
//     `mail_group` 把「一级分组」与「子域」混成了一团 —— 分组管的是**定时任务**这一整类
//     后台作业（邮件只是它的第一个子域），叫 mail_group 会让下一个子域（比如未来的报表
//     推送）挂在一个名不副实的分组下。改名也让标题从「定时任务/邮件」这种拼接式写法里
//     解脱出来：分组标题就是分类名，二级标题才是具体功能。
//   - 二级子菜单 **改 code + 改 path**：`mail_digest` → `mail`，title「交期汇总邮件」→
//     「邮件」，path `/mail/digest` → `/mail`（与 router 的 `path: 'mail'` 逐字一致）。
//     **为什么二级叫「邮件」而不是「交期汇总」**：邮件类型改用**页内 tab** 区分（当前
//     只有「交期汇总」一种），邮件类型不再是菜单层级 ⇒ 侧栏没必要为每种类型各占一项。
//     老书签 `/mail/digest` 由 router 里一条 `redirect: '/mail'` 的路由保住。
//   - 两个节点的 **id 用后端 seed 的新 id**（`9000000000000014` / `9000000000000902`），
//     **不复用** fixture 原先的 `id(13)` / `id(131)`：后端已软删旧两行，旧 id 在生产
//     库里仍指向软删行，沿用会让「fixture 与后端逐行对账」这件事失去意义。
// 2026-10-14 同步 backend-rust seeds/menu.sql（RBAC 控制面板）：
//   - auth_group 新增子菜单 roles_list「角色权限」，path /iam/roles（与 router 的
//     `path: 'iam/roles'` 逐字一致）、sort_order 40、icon Lock（与生产 t_menu.icon 对齐）。
//   - ⚠️ **数组物理位置插在 shelves_list(30) 之后**（见该节点的注释）：侧栏按物理
//     顺序渲染、不按 sort_order 排，位置必须与后端 seed 一致。
// 2026-10-13 同步 backend-rust seeds/menu.sql（交期汇总邮件定时任务）：
//   - 新增一级分组 mail_group「定时任务/邮件」（path NULL → 渲染成 el-sub-menu，不需前端
//     路由），sort_order 45，插在 floor_group(40) 与 settings_root(50) 之间；
//   - 其下子菜单 mail_digest「交期汇总邮件」，path /mail/digest（与 router 的
//     `path: 'mail/digest'` 逐字一致）、sort_order 10、icon Message（分组 icon Clock）。
// 2026-10-04 同步 backend-rust seeds/menu.sql：
//   - workers_list 从 auth_group children 迁入 production_group children，
//     path /workers → /production/worker-list，sort_order 10 → 25；
//   - worker_queue path /workers/queue → /production/worker-queue；
//   - 顺带修既有漂移：pending_programming sort_order 25 → 15（后端 seed 早已改成 15，
//     fixture 漏跟，不修则 25 槽位与 workers_list 撞车）。
//   - production_group 现含 6 children：process_work_type=5 / part_process_chain=10 /
//     pending_programming=15 / worker_queue=20 / workers_list=25 / inspection_pending=30；
//     auth_group 现含 3 children（users_list + shelves_list + roles_list，2026-10-14 起）。
// 2026-09-29 同步 backend-rust seeds/menu.sql：
//   - pending_programming 从顶级菜单迁入 production_group children，
//     title 由「待编程一览」精简为「待编程」；
//   - inspection_pending 从 order_group children 迁入 production_group children（sort=30）。
// 2026-09-16 同步 backend-rust sqlx migration 025：
//   - 货架（shelves_list）从 floor_group 移到 auth_group，与 users_list / workers_list 同组
//     （sort_order 30）。业务上货架归属权限管理范畴。
//   - 扫码台（scan_badge）从 floor_group 升级为顶级菜单（sort_order 13，紧跟
//     production_stats=12 之后），path=/scan/badge（router/index.ts:382 子路由 'badge'；
//     父路由 /scan 路径仅承载 redirect 到 /scan/badge，不暴露菜单）。
//   - 车间（floor_group）软删：子项全部迁出后保留空分组节点（comment-only soft-delete，
//     与 backend-rust 025 的 `is_active=false` 等价语义；MenuNode 类型未含 is_active
//     字段故不在 TS 里表达，靠注释 + 路由层 `meta.menuCode` 缺失自然失效来兜底）。
// 2026-09-16 part_process_chain path 已是 /production/process-design（router 已对齐），无需改路径。
// 2026-09-14 同步自生产 DB：admin 角色的完整菜单树（10 顶级 + 20 子项 leaf + 1 新顶级 scan_badge = 31 code）。
// 2026-09-14 menuCode 改名：process_design_list → part_process_chain（对齐后端 t_menu migration 017/018/021）。
// 2026-09-14 path 对齐 router：part_process_chain.path = /production/process-design。
// 2026-09-11 新增 production_group（生产管理）顶级分组，含 part_process_chain（工序制定）+ worker_queue（从 auth_group 迁出）。
// 2026-09-12 合并 fc99d3b tabbed 页：production_group 新增 process_work_type（工序工种，/production/process-work-type）。
// settings_root 暂时保留（fc99d3b 后端 migration 已软删，但前端 fixture 仍挂 3 个旧子菜单码以兜底路由守卫，
// 待后端菜单树彻底下架 settings_root 后再移除）。
// floor_group 软删保留（2026-09-16，迁 shelves_list 后无子项；待后端彻底下架再移除 fixture 行；
// __tests__/adminMenus.spec.ts 断言 floor_group 必须存在，故暂不能删）。
// 仅 dev dummy-auth 模式使用（initDummyAuth 注入 useAuthStore().user.menus；
// 原 useAuthSession → Pinia store 迁移）。
// prod bundle 不引用此文件（无 dead code 风险）。
//
// 数据来源：实际生产环境登录响应（USER / 15060779955 的 /iam/login 返回 data.menus）。
// 维护纪律：每次后端菜单树（t_menu）变更，必须把生产最新响应粘到这里同步；否则 dummy
// 模式下侧栏显示与生产不一致，且 menuCode 不存在的子项会被守卫降级踢走。
//
// 注：本 fixture 的 ID 用 `id(n)` 生成的假雪花 ID，**不**复用生产真 ID——fixture 是 dev-only
// 假数据，混用真实 ID 易让后续维护者误以为是后端快照。
//
// 改动后必须验证：
//   1. 每个 MenuNode.code 是 router/index.ts 里某条路由的 meta.menuCode
//   2. 每个 MenuNode.icon 在 MenuTreeItem.vue 的 ICON_MAP 中存在
//   3. leaf 节点（path 非 null 且 children 为空）数 = 路由可点击菜单数 = 26

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
  // 3. scan_badge — 扫码台（顶级，leaf）
  // 2026-09-16 新增（从 floor_group 升级为顶级菜单，backend-rust 025 同步提升）。
  // 为什么排在这个位置：sort_order=13 紧跟 production_stats=12、customer_management=15
  // 之前；而后端菜单查询是 `ORDER BY m.sort_order, m.code`（backend-rust
  // src/modules/iam/repo/sql/menu.rs），真实模式侧栏恒按 sort_order 出。MenuTreeItem
  // 与 MainLayout 都是直接 v-for 数组、渲染链路上没有排序 ⇒ **数组物理顺序必须与
  // sort_order 升序一致**，否则 dummy 模式的侧栏顺序 ≠ 生产。本条与同文件其它顶级
  // 条目、以及各分组 children 都受 adminMenus.spec.ts 的「menu tree is in ascending
  // sort_order」不变量用例守护。
  // path=/scan/badge（router/index.ts 子路由 'badge'；父路由 /scan 路径仅承载
  // redirect，不暴露菜单）。router 早已就绪（5 个子路由共用 scan_badge menuCode）。
  // icon=Operation：表达「操作台/工位」语义；与 production_group 主图标同名是历史
  // 既有约定（auth_group 内 Platform / work_types_list User 等也复用同名），侧栏
  // 仍靠 title 区分。Cellphone 暂不引入 ICON_MAP（菜单图标导入白名单收敛约束）。
  {
    id: id(12),
    version: 0,
    parent_id: null,
    code: 'scan_badge',
    title: '扫码台',
    path: '/scan/badge',
    // ⚠️ **与后端 seed 的已知漂移（本轮刻意不改）**（2026-10-16 review 第 2 轮裁决 1 登记）：
    // 后端 `seeds/menu.sql` 给这一行的是 `Promotion`，这里写的是 `Operation`。改与不改都不
    // 影响可达性或排序（icon 只是菜单前面的装饰字符），**刻意留白**：改它会把一个与本任务
    // 无关的改动混进 diff。对齐时连同下面 `production_group` 的 sort_order 一起做。
    icon: 'Operation',
    sort_order: 13,
    children: [],
  },
  // 4. customer_management — 客户管理（分组，2 children）
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
  // 5. order_group — 订单管理（分组，6 children）
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
  // 6. production_group — 生产管理（分组，6 children）
  // 2026-09-11 首次落地：worker_queue 从 auth_group 迁出，与 part_process_chain 同组。
  // 2026-09-12 合并 fc99d3b tabbed 页：process_work_type 也挂这里（router /production/process-work-type）。
  // 2026-09-29 新增：pending_programming（CNC 编程员主入口，从顶级菜单迁入，
  // title 由「待编程一览」精简为「待编程」）+ inspection_pending（从 order_group 迁入）
  // 挂这里；「扫工件」「条码打印」等生产侧功能后续都挂这里。
  // 2026-10-04 同步 backend-rust seeds/menu.sql：workers_list 从 auth_group 迁入
  // （path /workers → /production/worker-list，sort 10 → 25，接在 worker_queue=20 之后、
  // inspection_pending=30 之前）；worker_queue 的 path 同步为 /production/worker-queue。
  // 2026-10-04 顺带修既有漂移：pending_programming 的 sort_order 25 → 15（后端 seed
  // 早已按 review 意见改成 15，fixture 漏跟；不修则 25 槽位与 workers_list 撞车）。
  // 本组子项最终 sort：process_work_type=5 / part_process_chain=10 / pending_programming=15 /
  // worker_queue=20 / workers_list=25 / inspection_pending=30。
  {
    id: id(10),
    version: 0,
    parent_id: null,
    code: 'production_group',
    title: '生产管理',
    path: null,
    icon: 'Operation',
    // ⚠️ **与后端 seed 的已知漂移（本轮刻意不改）**（2026-10-16 review 第 2 轮裁决 1 登记）：
    // 后端 `seeds/menu.sql` 给 `production_group` 的是 **27**，这里写的是 **26**。
    // 对页面无影响（同级分组之间的相对次序没变），**刻意留白**：改它会把一个与本任务无关的
    // 改动混进 diff。对齐时连同上面 `scan_badge` 的 icon 一起做。
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
        // 2026-09-29 新增：从顶级菜单迁入 production_group children。
        // title 精简为「待编程」（旧 fixture 字面「待编程一览」冗余，与「已编程」Tab
        // 配合去掉「一览」后缀）。2026-10-04 sort_order 25 → 15，对齐 backend-rust seed
        // （排在 part_process_chain=10 之后、worker_queue=20 之前）；同一次修订把本块
        // 上移到 part_process_chain 之后 —— 数组物理顺序须与 sort_order 升序一致，
        // MenuTreeItem 直接 v-for children，渲染链路上没有排序。
        id: id(5),
        version: 0,
        parent_id: id(10),
        code: 'pending_programming',
        title: '待编程',
        path: '/cnc/pending',
        icon: 'Cpu',
        sort_order: 15,
        children: [],
      },
      {
        id: id(102),
        version: 0,
        parent_id: id(10),
        code: 'worker_queue',
        title: '生产队列',
        path: '/production/worker-queue',
        icon: 'Operation',
        sort_order: 20,
        children: [],
      },
      {
        // 2026-10-04：从 auth_group children 迁入 production_group children。
        // path /workers → /production/worker-list（与 router 子路由 'production/worker-list'
        // 对齐）；sort_order 10 → 25，接在 worker_queue=20 之后、inspection_pending=30 之前。
        id: id(61),
        version: 0,
        parent_id: id(10),
        code: 'workers_list',
        title: '工人一览',
        path: '/production/worker-list',
        icon: 'User',
        sort_order: 25,
        children: [],
      },
      {
        // 2026-09-29 新增：从 order_group children 迁入 production_group children。
        // 原 order_group 位置 sort_order=50 与业务侧「零件一览/送货/返修」错位；
        // 待品检本质是车间工序流的入口（INSPECTION → READY_TO_SHIP），归类到
        // 生产管理更贴合业务语义。挂 pending_programming=15 之后，sort=30。
        id: id(44),
        version: 0,
        parent_id: id(10),
        code: 'inspection_pending',
        title: '待品检',
        path: '/inspection/pending',
        icon: 'CircleCheck',
        sort_order: 30,
        children: [],
      },
    ],
  },
  // 7. template_management — 模板管理（分组，1 children）
  // 2026-10-16 review 第 1 轮 MAJOR-1 **复活**（2026-09-24 随 x-data-spreadsheet 弃用整段
  // 删除，本轮送货单打印模板上传页重新占用同一个 URL / 菜单节点）。
  //
  // ⚠️ **为什么必须同步而不是登记成已知偏差**：本文件的维护纪律（见文件头）写着「每次后端
  // 菜单树（t_menu）变更，必须把生产最新响应粘到这里同步」，且 2026-10-13 / 10-14 / 10-16
  // 三轮菜单变更都同步了；本轮是第四轮。不同步的直接后果不是「侧栏少一项」这么轻——路由
  // 守卫第 3 条（`if (code && !treeContainsCode(auth.menus, code))` → 踢到
  // `findFirstMenuPath(auth.menus) ?? '/login'`）会让 dummy 模式下**直接敲 URL 也进不去**
  // 本页，现象是「点菜单闪一下又回到别的页」，与真实故障无法区分。
  //
  // ⚠️ **数组物理位置插在 production_group 与 auth_group 之间**：sort_order 28 落在两者
  // 之间（后端 seed：production_group=27 / template_management=28 / auth_group=30），而
  // MenuTreeItem 与 MainLayout 都是直接 v-for 数组、渲染链路上**没有排序** ⇒ 数组物理序
  // 必须与 sort_order 升序一致（`__tests__/adminMenus.spec.ts` 的「menu tree is in
  // ascending sort_order」守着）。
  //
  // ⚠️ 图标 `Document` 必须在 `MenuTreeItem.vue` 的 ICON_MAP 内（查不到会**静默不显示**、
  // 不报错）。分组与子菜单同名 `Document` 是后端 seed 的原样取值（分组与叶子同图标在本
  // fixture 里有先例：outsource_list / outsource_send_receive_list 都是 Promotion）。
  {
    id: '9000000000000008',
    version: 0,
    parent_id: null,
    code: 'template_management',
    title: '模板管理',
    path: null,
    icon: 'Document',
    sort_order: 28,
    children: [
      {
        // path 与 router 的 `path: 'print-templates'` 逐字一致；`meta.menuCode` 是
        // `print_templates_designer`（见 router/index.ts 的同名注释），两者互为对账。
        id: '9000000000000701',
        version: 0,
        parent_id: '9000000000000008',
        code: 'print_templates_designer',
        title: '模板编辑',
        path: '/print-templates',
        icon: 'Document',
        sort_order: 10,
        children: [],
      },
    ],
  },
  // 8. auth_group — 权限管理（分组，3 children）
  // 2026-09-11：worker_queue 迁到 production_group。
  // 2026-09-16：shelves_list 从 floor_group 迁入。
  // 2026-10-04：workers_list 迁到 production_group（业务侧归类随菜单分组调整）。
  // 2026-10-14：新增 roles_list（RBAC 控制面板），本分组现含
  // users_list + shelves_list + roles_list 三个子菜单。
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
        // 2026-10-10：货架管理后端整域迁 iam（CRUD URL 前缀改 `/api/v2/iam/shelves`），
        // 但本节点的 `path` **刻意保持 `/shelves` 不变** —— 它是前端路由 / 浏览器
        // 书签 URL，与后端菜单表里的 path 字段同源，改它会断掉用户已收藏的链接。
        // 后端 API URL 与菜单 path 是两层，不要求一致。
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
      {
        // 2026-10-14 新增：RBAC 控制面板（角色权限）。**数组物理位置接在 shelves_list
        // 之后**（sort_order=40），且必须与 sort_order 升序一致 —— MainLayout 与
        // MenuTreeItem 都是直接 v-for 数组、渲染链路上**没有排序**，侧栏渲染顺序 ==
        // 数组顺序；真实模式的后端菜单是 `ORDER BY m.sort_order, m.code` 出的。两层
        // 任一处失序，dummy 模式的侧栏顺序就 ≠ 生产。
        // 由 __tests__/adminMenus.spec.ts 的「menu tree is in ascending sort_order」
        // 与「covers all menuCodes exactly」两条用例同时守住。
        // icon 用 `Lock`（与生产 t_menu.icon 一致，也与父节点 auth_group 的 `Key` 区分）：
        // `Lock` 必须在 MenuTreeItem.vue 的 ICON_MAP 内，查不到会**静默不显示**、不报错。
        id: id(64),
        version: 0,
        parent_id: id(6),
        code: 'roles_list',
        title: '角色权限',
        path: '/iam/roles',
        icon: 'Lock',
        sort_order: 40,
        children: [],
      },
    ],
  },
  // 9. outsource_list — 外协管理（分组，3 children）
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
  // 10. floor_group — 车间（软删分组，0 children）
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
  // 11. scheduled_task — 定时任务（分组，2 children）
  // 定时任务域的一级分组：管**所有**后台定时作业，邮件与企业微信推送是它的两个子域。
  // 分组节点 path=null（渲染成 el-sub-menu，**不需要**前端路由，照 order_group /
  // auth_group 等既有分组节点的既有做法）；子菜单 mail 的 path 与 router 的
  // `path: 'mail'` 逐字一致，wecom 的 path 与 router 的 `path: 'wecom'` 逐字一致。
  //
  // ⚠️ **sort_order=45 的插入位是硬约束**：数组物理顺序必须与 sort_order 升序一致
  // （MenuTreeItem / MainLayout 都是直接 v-for 数组、渲染链路上没有排序），所以本块
  // 插在 floor_group(40) 与 settings_root(50) 之间 —— `__tests__/adminMenus.spec.ts`
  // 的「menu tree is in ascending sort_order」用例会守住这个位置。
  // children 内部同理：mail(10) 必须在 wecom(20) 之前（物理顺序 = 渲染顺序）。
  //
  // ⚠️ 图标必须在 `MenuTreeItem.vue` 的 ICON_MAP 内（查不到会**静默不显示**，不报错）：
  // scheduled_task → Clock、mail → Message（两者 2026-10-13 已补命名导入，零改动）、
  // wecom → ChatDotRound（2026-10-17 新增，见 `layouts/components/menuIcons.ts`）。
  //
  // ⚠️ **id 写死字面量、不走 `id(n)` 生成器**：本仓 fixture 的 id 通常是假雪花，但
  // 这几个节点**刻意**与 backend-rust `seeds/menu.sql` 的 id 逐字一致 —— 后端已软删
  // 旧两行（`mail_group` / `mail_digest`），id 是唯一能把「软删」与「改名」区分开的标识，
  // 沿用旧 id 会让对账脚本看不出这其实是两行新记录。
  {
    id: '9000000000000014',
    version: 0,
    parent_id: null,
    code: 'scheduled_task',
    title: '定时任务',
    path: null,
    icon: 'Clock',
    sort_order: 45,
    children: [
      {
        id: '9000000000000902',
        version: 0,
        parent_id: '9000000000000014',
        code: 'mail',
        title: '邮件',
        path: '/mail',
        icon: 'Message',
        sort_order: 10,
        children: [],
      },
      {
        // 2026-10-17 新增：企业微信推送（Webhook 配置 + 每日总结，页内两个 tab）。
        // ⚠️ `sort_order: 20` 排在 mail(10) 之后，且**数组物理位置紧跟其后** —— 渲染链路
        //   上没有排序（见上方「sort_order=45 的插入位是硬约束」）。
        id: '9000000000000903',
        version: 0,
        parent_id: '9000000000000014',
        code: 'wecom',
        title: '企业微信',
        path: '/wecom',
        icon: 'ChatDotRound',
        sort_order: 20,
        children: [],
      },
    ],
  },
  // 12. settings_root — 设置（分组，3 children）
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
