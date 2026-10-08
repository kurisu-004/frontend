import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import type { MenuNode } from '@/types/menu';
// 2026-09-26：迁移到 Pinia store useAuthStore（src/stores/auth.ts）。原 composable
// 模块级单例换 store 顶层 import —— store 不 import router（refreshOrLogout 与
// forceLogout 都通过参数接收 router），无循环依赖。useAuthStore() 在 router 守卫里
// 调一次拿当前 session state（标量自动解包，函数式 getter 保留调用形态）。
// 2026-10-02（M-4）：两条终止路径的分工是「auth.teardownSession() 纯收口（无 router）
// + forceLogout(router) 在其之上追加导航」；本模块调 forceLogout(router) 的两处
// （'auth:session-lost' listener、全局前置守卫的 refreshOrLogout 失败分支）都依赖
// 它顺带完成导航。
import { useAuthStore } from '@/stores/auth';
// 2026-10-09 新增：4001 且 reason 为 'access token expired' 时，refresh 成功后需要
// 恢复长连接（WS 侧已在 4001 分支把 URL 置 undefined 停连）。api/dashboard.ts 不
// import vue-router / stores/auth，依赖单向，不构成循环依赖。
import { reconnectDashboard } from '@/api/dashboard';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    icon?: string;
    requireAuth?: boolean;
    /** 该路由所需的菜单 code；缺省表示不依赖菜单（公开 / 已登录即可）。
     *  守卫会校验"用户的菜单树中是否包含该 code"，单一权限源。 */
    menuCode?: string;
    /** 该路由的访问条件：用户只要拥有任一列出的角色即可进入，无需 menuCode 命中。
     *  用例：工位扫码台（/scan/*）—— SHELF_ACCOUNT 业务上必须能进，但 SHELF_ACCOUNT
     *  的菜单树不含 scan_badge。allowRoles 检查在 menuCode 检查之前触发。 */
    allowRoles?: string[];
    /** 2026-09-28 新增：钉在 tagsView 最左侧的常驻 tab，关闭按钮禁用。无 affix 时
     *  tab 表现与普通 tab 一致（可关闭）。通常配合常驻页面（首页 Dashboard）使用。 */
    affix?: boolean;
    /** 2026-09-28 新增：该路由不参与 tagsView（登录页 / 错误页 / MainLayout 之外的
     *  全屏页面）。tagsView.afterEach 跳过此类路由，避免登录页扫码台成为 tabs。 */
    noTagsView?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  // 通用登录页（脱离 MainLayout，独立全屏）
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/auth/LoginView.vue'),
    meta: { title: '登录', noTagsView: true },
  },
  // MainLayout 子树
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    meta: { requireAuth: true },
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/DashboardView.vue'),
        meta: {
          title: '首页',
          icon: 'House',
          menuCode: 'home',
          // 2026-09-28 新增：Dashboard 钉死在 tagsView 最左侧，关闭按钮禁用
          affix: true,
        },
      },
      {
        path: 'parts',
        name: 'PartsList',
        component: () => import('@/views/parts/list/PartsList.vue'),
        meta: {
          title: '零件一览',
          icon: 'Box',
          menuCode: 'parts_list',
        },
      },
      {
        path: 'parts/new',
        name: 'PartsNew',
        component: () => import('@/views/parts/new/PartBatchNew.vue'),
        meta: {
          title: '新建零件',
          menuCode: 'parts_new',
        },
      },
      {
        path: 'parts/:id(\\d+)',
        name: 'PartsDetail',
        component: () => import('@/views/parts/detail/PartDetail.vue'),
        meta: {
          title: '零件详情',
        },
        props: true,
      },
      {
        path: 'inspection/pending',
        name: 'InspectionPending',
        component: () => import('@/views/inspection/InspectionPending.vue'),
        meta: {
          title: '待品检',
          icon: 'CircleCheck',
          menuCode: 'inspection_pending',
        },
      },
      {
        // PR-M 2026-08-04 「返修接收」：订单管理子菜单，权限 MANAGER+CLERK+INSPECTOR
        path: 'repair/receive',
        name: 'RepairReceive',
        component: () => import('@/views/repair/RepairReceive.vue'),
        meta: {
          title: '返修接收',
          icon: 'Tools',
          menuCode: 'repair_receive',
        },
      },
      {
        // 2026-07-14：待编程一览（status=PROGRAMMING），CNC 编程员专属页。
        // 侧栏作为顶级菜单渲染（t_menu.parent_id IS NULL）；权限通过 menuCode 守卫。
        path: 'cnc/pending',
        name: 'PendingProgramming',
        component: () => import('@/views/cnc/PendingProgrammingList.vue'),
        meta: {
          title: '待编程一览',
          icon: 'Cpu',
          menuCode: 'pending_programming',
        },
      },
      {
        // 2026-07-16：commit 8 — /outsource 老入口重定向到 /outsource/companies
        path: '/outsource',
        redirect: '/outsource/companies',
      },
      {
        // 2026-07-16：外协厂一览（MANAGER + CLERK，commit 8 后叶子挂分组）
        path: 'outsource/companies',
        name: 'OutsourceCompaniesList',
        component: () => import('@/views/outsource/OutsourceList.vue'),
        meta: {
          title: '外协厂一览',
          icon: 'OfficeBuilding',
          menuCode: 'outsource_companies_list',
        },
      },
      {
        // 2026-07-16：报价一览（MANAGER + CLERK）
        path: 'outsource/quotes',
        name: 'OutsourceQuoteList',
        component: () => import('@/views/outsource/OutsourceQuoteList.vue'),
        meta: {
          title: '报价一览',
          icon: 'Document',
          menuCode: 'outsource_quotes_list',
        },
      },
      {
        // 外协发送/接收看板（MANAGER + CLERK + INSPECTOR）。2026-10-09 组件硬切：
        // 原「可发送 / 待接收」双表格 tab 换成按外协工序分的看板（OutsourceBoard.vue），
        // **路径不变**，只有组件换了。`?tab=` 的语义随之从 sendable/receiving 变成
        // 外协工序 id（见 OutsourceBoard.vue 的深链校正）。
        path: 'outsource/send-receive',
        name: 'OutsourceSendReceive',
        component: () => import('@/views/outsource/OutsourceBoard.vue'),
        meta: {
          title: '外协发送/接收',
          icon: 'Promotion',
          menuCode: 'outsource_send_receive_list',
        },
      },
      {
        // 2026-07-28：外协对账一览（按公司聚合 SENT_TO_OUTSOURCE 事件）
        path: 'outsource/companies/:id/sent-parts',
        name: 'OutsourceCompanySentParts',
        component: () => import('@/views/outsource/OutsourceCompanySentParts.vue'),
        meta: {
          title: '外协对账',
          // 不暴露为独立菜单；通过公司列表的「对账」链接进入。
          menuCode: 'outsource_companies_list',
        },
      },
      {
        // 2026-07-30：装配件一览退役，合并到零件一览
        path: 'assemblies',
        redirect: '/parts',
      },
      {
        path: 'delivery-notes',
        name: 'DeliveryNoteList',
        component: () => import('@/views/com/delivery/DeliveryNoteList.vue'),
        meta: {
          title: '送货单',
          icon: 'Document',
          menuCode: 'delivery_notes_manage',
        },
      },
      {
        path: 'delivery-notes/:id(\\d+)',
        name: 'DeliveryNoteDetail',
        component: () => import('@/views/com/delivery/DeliveryNoteDetail.vue'),
        meta: {
          title: '送货单详情',
          menuCode: 'delivery_notes_manage',
        },
      },
      {
        // 2026-08-21 v2 扫码建单入口。
        // 不暴露为独立菜单：通过「送货单」列表页顶部「扫码建单」按钮进入。
        // 复用 delivery_notes_manage menuCode，与 list / detail 同一权限面。
        path: 'delivery-notes/scan',
        name: 'DeliveryNoteScan',
        component: () => import('@/views/com/delivery/DeliveryNoteScan.vue'),
        meta: {
          title: '扫码建单',
          menuCode: 'delivery_notes_manage',
        },
      },
      {
        path: 'assemblies/:id(\\d+)',
        name: 'AssemblyDetail',
        component: () => import('@/views/assemblies/AssemblyDetail.vue'),
        meta: {
          title: '装配件详情',
        },
        props: true,
      },
      {
        path: 'production/worker-list',
        name: 'WorkerList',
        component: () => import('@/views/production/WorkerList.vue'),
        meta: {
          title: '工人一览',
          icon: 'User',
          menuCode: 'workers_list',
        },
      },
      {
        // 2026-09-14 menuCode 改名：process_design_list → part_process_chain
        // 对齐后端 t_menu（migration 017/018/021 写入）的 menuCode。
        path: 'production/process-design',
        name: 'ProcessDesign',
        component: () => import('@/views/production/ProcessDesignView.vue'),
        meta: {
          title: '工序制定',
          icon: 'SetUp',
          menuCode: 'part_process_chain',
        },
      },
      {
        path: 'production/worker-queue',
        name: 'WorkerQueueBoard',
        component: () => import('@/views/production/queue/QueueBoard.vue'),
        meta: {
          title: '生产队列',
          icon: 'Operation',
          menuCode: 'worker_queue',
        },
      },
      {
        path: 'users',
        name: 'UserList',
        component: () => import('@/views/users/UserList.vue'),
        meta: {
          title: '账号管理',
          icon: 'Key',
          menuCode: 'users_list',
        },
      },
      {
        // 2026-10-10：货架管理整域迁 iam 域（后端 `src/modules/shelf/` →
        // `src/modules/iam/shelf/`，CRUD URL 前缀硬切到 `/api/v2/iam/shelves/*`，
        // 无 alias），视图随之搬到 `views/iam/shelves/`。
        //
        // ⚠️ **`path` 刻意仍是 `shelves`**（前端路由 / 浏览器书签 URL），它同时也是
        // 后端菜单表 `shelves_list` 节点的 `path` 字段 —— 改它会断掉用户已收藏的
        // 链接与后端菜单数据。后端 URL 是另一层（`/api/v2/iam/shelves`），两层
        // **不要求一致**：「前端 /shelves + 后端 /iam/shelves」不是漏改。
        path: 'shelves',
        name: 'ShelfList',
        component: () => import('@/views/iam/shelves/ShelfList.vue'),
        meta: {
          title: '货架管理',
          icon: 'Platform',
          menuCode: 'shelves_list',
        },
      },
      {
        path: 'statistics',
        name: 'ProductionStats',
        component: () => import('@/views/statistics/ProductionStats.vue'),
        meta: {
          title: '生产统计',
          icon: 'DataAnalysis',
          menuCode: 'production_stats',
        },
      },
      {
        path: 'customers',
        name: 'CustomerList',
        component: () => import('@/views/customers/CustomerList.vue'),
        meta: {
          title: '客户一览',
          icon: 'Connection',
          menuCode: 'customers_list',
        },
      },
      {
        path: 'applicants',
        name: 'ApplicantList',
        component: () => import('@/views/applicants/ApplicantList.vue'),
        meta: {
          title: '申请人一览',
          icon: 'User',
          menuCode: 'applicants_list',
        },
      },
      {
        // 2026-09-12：合并原 设置/工种管理 + 设置/工序管理 + 设置/工种-工序映射 三菜单到一个
        // tabbed 页（/production/process-work-type）。原三个 /settings/* 路由已删除。
        path: 'production/process-work-type',
        name: 'ProcessWorkType',
        component: () => import('@/views/production/ProcessWorkTypePage.vue'),
        meta: {
          title: '工序工种',
          menuCode: 'process_work_type',
        },
      },
    ],
  },
  // 工位扫码台
  //
  // 2026-10-10：视图目录从 `views/scan/` 搬到 `views/production/scan/`（与后端
  // `prod::scan` 域、生产队列域对齐），但**路由 path 与 menuCode 一律不动**：
  // `path: 'scan/*'` 是浏览器可见的书签 URL、也是后端菜单表 `scan_badge` 节点的
  // `path` 字段，改它会断掉用户已收藏的链接与菜单下发。它与后端 API URL
  // （`/prod/scan/*`）是两层，本就不要求一致 —— 搬目录只改下面 `component` 的
  // import 路径。
  {
    path: '/scan',
    meta: {
      requireAuth: true,
      allowRoles: ['SHELF_ACCOUNT'],
      // 2026-09-28 新增：工位扫码台全屏、MainLayout 之外，不进 tagsView
      noTagsView: true,
    },
    children: [
      { path: '', redirect: '/scan/badge' },
      {
        path: 'badge',
        name: 'ScanBadge',
        component: () => import('@/views/production/scan/ScanBadgeGate.vue'),
        meta: { title: '扫码台 · 工牌识别', menuCode: 'scan_badge' },
      },
      {
        path: 'action',
        name: 'ScanAction',
        component: () => import('@/views/production/scan/ScanActionPicker.vue'),
        meta: { title: '扫码台 · 操作选择', menuCode: 'scan_badge' },
      },
      {
        path: 'pick',
        name: 'ScanPick',
        component: () => import('@/views/production/scan/ScanPickParts.vue'),
        meta: { title: '扫码台 · 选件领取', menuCode: 'scan_badge' },
      },
      {
        path: 'return',
        name: 'ScanReturn',
        component: () => import('@/views/production/scan/ScanReturnParts.vue'),
        meta: { title: '扫码台 · 选件放回', menuCode: 'scan_badge' },
      },
      {
        path: 'inspect',
        name: 'ScanInspect',
        component: () => import('@/views/production/scan/ScanInspectParts.vue'),
        meta: { title: '扫码台 · 选件送检', menuCode: 'scan_badge' },
      },
    ],
  },
];

const router = createRouter({ history: createWebHistory(), routes });

// 2026-10-02 新增：接 dashboard WS 的「连接期间 re-auth 失败」通知。
// api/dashboard.ts 收到后端关闭码 4001 时会派发 window 事件 'auth:session-lost'
// 并停掉重连（wsUrl 置 undefined）；**本层负责决定会话怎么处置**。
//
// 为什么接收方选 router 模块而不是 MainLayout.vue：
//   ① 全局一次性注册。MainLayout 是组件（且挂在 requireAuth 子树上），
//      /scan/* 这些 MainLayout 之外的全屏路由收不到；
//   ② router 模块已持有 router 实例 + 已 import useAuthStore，本处零新增依赖；
//   ③ store 仍不 import vue-router —— forceLogout(router) 按参数注入（不变式）。
//
// 与 'auth:session-changed' 的区别（别混淆）：后者由 auth 层派发、语义是
// 「token 变了，WS 该重算 URL 重连」；本事件由 WS 层派发、语义是「WS re-auth 失败，
// 请上层处置会话」，方向相反。二者互不覆盖。
//
// 2026-10-09 起按 reason 三路分流（4001 带两段 reason，字面量与后端
// `src/modules/dashboard/handler.rs` 的 `reauth_close_code` 严格对齐）：
//   - `auth expired` → 会话真被吊销（登出 / 改密 / 管理员停用 / reuse detection）
//     ⇒ forceLogout(router) 直接终止，不做注定失败的 refresh 往返；
//   - `access token expired` → 只是这枚 access JWT 自然过期，refresh token 仍有效
//     ⇒ refreshOrLogout(router)：成功则 reconnectDashboard() 恢复长连接，
//     失败则由它内部 forceLogout（session 真的没了才会失败）；
//   - `null` / 未知 → null 按「可能只是 token 过期」走 refresh 分支（乐观：刷新成功
//     就留人，失败才登出）；其它非空未知 reason 保守 forceLogout。
//
// refresh 成功后**必须**显式 reconnectDashboard()：refreshOrLogout 内部走 apiMe()
// 拉 /iam/me 复核，那是一次成功响应，不触发 40102；若客户端时钟偏移导致它判断
// token 仍有效而不发生 refresh，就没有 persistTokens → 没人派发
// 'auth:session-changed' → WS 会永远停在 undefined 上不再连（dashboard 静默停更）。
//
// 幂等性：forceLogout 可重复调用（每步都是置 null / removeItem / clear / replace），
// refreshOrLogout 的成功分支只做 setUser，不清缓存；两条路径各自可重入，本层不加
// 防重入 flag（WS 是 createGlobalState 单例，4001 派发点只有 onDisconnected 一处）。
//
// `import { reconnectDashboard } from '@/api/dashboard'` 不构成循环依赖：
// api/dashboard.ts 不 import vue-router / stores/auth / @tanstack/vue-query
// （WS 层分层禁令），依赖方向是 router → api 单向。
if (typeof window !== 'undefined') {
  window.addEventListener('auth:session-lost', ((ev: Event) => {
    const detail = (ev as CustomEvent<{ code: number; reason: string | null }>).detail;
    const reason = detail?.reason ?? null;
    const auth = useAuthStore();
    if (reason === 'access token expired' || reason === null) {
      void auth
        .refreshOrLogout(router)
        .then((ok) => {
          // ok === false 时 refreshOrLogout 内部已 forceLogout(router)，这里不再重复调。
          if (ok) reconnectDashboard();
        })
        // 兜底：refreshOrLogout 把 forceLogout 放在 catch 里，而 forceLogout 自身也可能抛
        // （teardownSession 内的 storage 写入、queryClient.clear()、router.replace 各自都有
        // 抛的可能）。异常一旦穿出 listener 的 promise 就是一条无人处理的 rejection ——
        // 会话没清、没跳登录页、只在控制台留一条 unhandled rejection。此处宁可多登不可
        // 不登：再调一次 forceLogout（幂等，见 auth store 的注释）。兜底路径自己再抛就
        // 真的无处可兜了，只记一条日志。
        .catch(() => {
          try {
            auth.forceLogout(router);
          } catch (err) {
            console.error('[auth] forceLogout 兜底失败', err);
          }
        });
      return;
    }
    auth.forceLogout(router);
  }) as EventListener);
}

/** DFS 在用户的菜单树中查找指定 code。 */
function treeContainsCode(tree: MenuNode[], code: string): boolean {
  const stack: MenuNode[] = [...tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.code === code) return true;
    if (n.children.length > 0) stack.push(...n.children);
  }
  return false;
}

/** DFS 在用户的菜单树中找第一个有 path 的节点路径；找不到返回 null。
 *  用作 menuCode 校验失败时的降级目标：避免再次陷入相同的菜单校验循环。 */
function findFirstMenuPath(tree: MenuNode[]): string | null {
  const stack: MenuNode[] = [...tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.path) return n.path;
    if (n.children.length > 0) stack.push(...n.children);
  }
  return null;
}

// 全局前置守卫
router.beforeEach(async (to, _from, next) => {
  // 2026-09-26：使用 Pinia store useAuthStore() 替代 useAuthSession()。标量 getter
  // 自动解包（auth.isAuthenticated 不带括号），函数式 getter 保留调用形态
  // （auth.hasRole(r) 仍带括号）。
  const auth = useAuthStore();

  // 1) 未登录 → /login
  // 2026-08-26 新增：dummy-auth 短路。
  // dummy 模式下不再调 /iam/me（会失败并清掉 fake session），直接走后续菜单校验。
  if (auth.isDummyAuthActive) {
    // dummy 模式：跳过 refreshOrLogout，直接进入 allowRoles + menuCode 检查
  } else if (to.meta.requireAuth || to.matched.some((r) => r.meta.requireAuth)) {
    if (!auth.isAuthenticated) {
      const ok = await auth.refreshOrLogout(router);
      // 2026-10-02 修缺陷 A：此处原来只写 `if (!ok) return;`，**从不调 next()**。
      // 本守卫是 3 参签名 `(to, _from, next)`，vue-router 的 guardToPromiseFn 只在
      // `guard.length < 3` 时自动续 next（node_modules/vue-router/dist/
      // devtools-EWN81iOl.mjs:757），dev 分支还会对「promise 已 resolve 但 next 没被
      // 调用」直接 `Promise.reject(new Error("Invalid navigation guard"))`（同文件
      // :763/:770）⇒ 表现是 prod 导航永久挂起、dev 抛错。
      // 必须是 `next(false)` 而不是 `next('/login')`：`refreshOrLogout` 的失败分支
      // 已委托 `forceLogout(router)`，导航**已在 store 内**用 router.replace('/login')
      // 完成；这里再导航一次会与 replace 打架（且守卫返回值语义与 next 语义不可混用，
      // 故本守卫全程保持 3 参 + next 形态）。
      if (!ok) return next(false);
    }
  }

  // 2) allowRoles 短路：用户拥有任一列出的角色则直接放行，不管 menuCode。
  //    用于 SHELF_ACCOUNT → /scan/* 等"业务上必须能进但 menuCode 校验会卡住"的场景。
  const allowRoles = to.meta.allowRoles ?? [];
  if (allowRoles.length > 0 && allowRoles.some((r) => auth.hasRole(r))) {
    return next();
  }

  // 3) menuCode 校验：菜单树中存在对应 code 即放行。
  //    单一权限源。降级目标：用户菜单树中第一个可达路径；
  //    若菜单树为空（极端情况）→ /login。
  const code = to.meta.menuCode;
  if (code && !treeContainsCode(auth.menus, code)) {
    const fallback = findFirstMenuPath(auth.menus) ?? '/login';
    if (fallback === to.fullPath) return next(); // 自环保护，防止未来回归
    return next(fallback);
  }

  next();
});

export default router;
