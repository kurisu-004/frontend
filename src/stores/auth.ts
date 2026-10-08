// src/stores/auth.ts
//
// 2026-09-26 新增：Pinia setup store，替代原 composables/useAuthSession（模块级单例）。
// 同步把 login useMutation 从 LoginView.vue 搬进 store（一次性迁移，登录是全局唯一
// mutation，error / isPending 是全局状态）。
//
// 关键设计：
//   - CustomEvent 'auth:tokens-refreshed' 保留：http.ts 拦截器不 import store（避免循环
//     依赖），拦截器刷新成功后 dispatch 事件，本 store 在 setup 回调里挂 listener 同步
//     state。
//   - 订阅 'auth:logout'：40105 SESSION_REVOKED 与 refresh 失败（api/http.ts 的
//     错误拦截器）只负责 dispatch，会话状态（清 token / user /
//     localStorage / tagsView / query 缓存）由本 store 的 teardownSession() 单点收口。
//   - loadFromStorage() 在 setup 回调末尾自执行（首次 useAuthStore() 时触发）；Listener
//     在 setup 里挂；保证首次实例化就具备 localStorage 恢复 + 事件同步能力。
//     它同时是 access token 保活定时器的起表点之一（见 ensureAccessTokenKeepalive）；
//     teardownSession() 则是拆表点（会话终止后必须停掉，否则还挂着 10 分钟）。
//   - forceLogout(router)：「会话已没救」时无条件终止本地会话（不联系后端），
//     refreshOrLogout 的失败分支委托给它。详见函数注释。
//   - 会话终止唯一收口 teardownSession()：**无 router 参数**、
//     只做状态 + 缓存收口；forceLogout(router) 在其之上追加一次导航。四条终止路径
//     （logout() / forceLogout / refreshOrLogout 失败分支 / auth:logout 事件）全部汇到
//     它，新增第 5 条时必须改走本函数。
//   - main.ts 在 dummy 模式下先调 useAuthStore().initDummyAuth()，再 app.use(router)，
//     路由守卫触发时 isDummyAuthActive 已是 true，refreshOrLogout 短路。
//   - Zod schema（loginSchema）与角色路由跳转仍留 LoginView.vue（视图关注点）。store
//     不持 Zod schema、不接 router.push，仅 expose loginMutation（error / isPending）。
//   - 消费侧禁止解构 store：统一 auth.xxx 访问（响应式），沿用 usePartsListStore
//     不变量 #3。

import { ref, computed, type Ref } from 'vue';
import { defineStore } from 'pinia';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { login as apiLogin, logout as apiLogout, me as apiMe } from '@/api/iam';
import type { ApiError } from '@/api/http';
// 2026-10-09 新增：起 access token 保活定时器（api/http.ts 的 setTimeout 链）。
// 「刷新浏览器恢复会话」这条路径只由本函数读 localStorage，不经过 http.ts 的
// persistTokens()，若不在这里补一次起表，页面一加载就是零 HTTP 流量 → 定时器缺失 →
// access token 静默过期。http.ts 不 import 本 store，依赖方向单向。
import { ensureAccessTokenKeepalive } from '@/api/http';
import type { CurrentUser } from '@/types/user';
import type { MenuNode } from '@/types/menu';
import { ADMIN_MENUS } from '@/composables/__fixtures__/adminMenus';
// 2026-09-28 新增：登出联动清空 tagsView（auth → tagsView 单向引用，tagsView 不
// 反向 import auth，无循环依赖）。2026-10-02 起改为按 userId 分 key 的 per-user
// 持久化（缺陷 B：换账号看到上一账号标签栏），切换入口统一是 setUser() 里的
// switchOwner(user?.id ?? null)。
import { useTagsViewStore } from '@/stores/tagsView';

interface StoredSession {
  token: string;
  /** 2026-07-10 新增：refresh token（7d TTL）。老条目可能缺省，按 null 处理。 */
  refresh_token?: string | null;
  user: CurrentUser;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export const useAuthStore = defineStore('auth', () => {
  // 2026-10-02 新增（M-4 会话边界缓存清理）：必须在 setup **最顶部**捕获，不能挪到
  // teardownSession() 里惰性取。证据：
  //   - Pinia 只对 store setup 包 runWithContext（node_modules/pinia/dist/pinia.mjs:1468-1470），
  //     action wrapper（同文件 :1379-1405，body 内只有 setActivePinia / 订阅触发，**没有**
  //     runWithContext）里没有；
  //   - 而 useQueryClient() 首行 hasInjectionContext() 守卫会抛
  //     "vue-query hooks can only be used inside setup() function or functions that support
  //     injection context."（node_modules/@tanstack/vue-query/build/modern/useQueryClient.js:26）。
  // ⇒ 任何惰性路径（action 内 / 事件 listener 内）再调 useQueryClient() 都会炸。
  // main.ts 侧顺序（src/main.ts）：`app.use(VueQueryPlugin, { queryClient })` 紧跟在
  // `app.use(createPinia())` 之后，首次 useAuthStore()（dummy 分支）更在其后 ⇒ plugin
  // 早于 store 实例化，OK（`rg -n "createPinia\(\)|VueQueryPlugin, \{ queryClient|useAuthStore\(\)\.initDummyAuth" src/main.ts`
  // 可复核）。模块体里的调用之所以也安全，是因为 Pinia 用 app.runWithContext 包了
  // store setup（正是上面 :1468-1470 那行）—— 有 injection context 的是 setup 内部，
  // 不是调用点。
  // 测试侧含义（2026-10-02 补）：useQueryClient() 只在 store **首次创建**时执行
  // （后续 useAuthStore() 命中 pinia._s 缓存直接返回，不重跑 setup）。故任何实例化
  // auth store 的 spec 必须先 app.use(createPinia()) 再 app.use(VueQueryPlugin) 并传入
  // 一个 QueryClient 实例（见 src/stores/__tests__/auth.spec.ts 的 beforeEach），
  // 否则首次 useAuthStore() 就会抛上面那句。
  const queryClient = useQueryClient();

  // ===== state =====
  const user: Ref<CurrentUser | null> = ref(null);
  const token: Ref<string | null> = ref(null);
  // refreshToken 不暴露（只 axios 拦截器读 localStorage），但 store 内部需要
  let refreshTokenValue: string | null = null;
  const isDummyAuthActiveValue = ref(false);

  // ===== storage =====
  function loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem('auth_session');
      if (!raw) return false;
      const s: StoredSession = JSON.parse(raw);
      if (!s.token || !s.user) return false;
      // 兼容旧版本 localStorage（没有 menus 字段）：补默认值，下次 /iam/me 会刷新。
      s.user.menus = s.user.menus ?? [];
      token.value = s.token;
      refreshTokenValue = s.refresh_token ?? null;
      setUser(s.user);
      // 2026-10-09 新增：起 access token 保活定时器（本路径不经过 http.ts 的
      // persistTokens，必须在此补一次；函数幂等，重复调用只是重排）。
      ensureAccessTokenKeepalive();
      return true;
    } catch {
      return false;
    }
  }

  function saveToStorage(): void {
    if (!token.value || !user.value) {
      localStorage.removeItem('auth_session');
      return;
    }
    localStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: token.value,
        refresh_token: refreshTokenValue,
        user: user.value,
      }),
    );
  }

  // ===== dummy auth =====
  // 2026-08-28 重写：dummy-auth 判定改用 Vite 官方 env 机制。
  // 仅在 `npm run dev:dummy`（=`vite --mode dummy` → 自动加载 .env.dummy → 设置
  // VITE_DUMMY_AUTH=true）时为 true；prod build 里 import.meta.env.DEV === false，
  // 永远 false。供 router 守卫短路 refreshOrLogout（避免 dummy 模式下 /iam/me 失败
  // 清掉 fake session）。
  function isDummyAuthRequested(): boolean {
    return import.meta.env.DEV && import.meta.env.VITE_DUMMY_AUTH === 'true';
  }

  // ===== user 写入唯一收口 / 会话终止唯一收口（2026-10-02 新增）=====

  /**
   * `user.value` 的**唯一**写点。5 处调用方（loadFromStorage / loginMutation /
   * refreshOrLogout 成功 / initDummyAuth / auth:tokens-refreshed）都经它，顺带把
   * tagsView 的持久化归属切到该用户 id —— 这是缺陷 B（同账号重登恢复标签栏、换账号
   * 互不可见）能生效的关键。写 `user.value` 而忘了切归属的 bug 曾真实存在
   * （2026-10-02 修 M-4 时 auth store 里 5 个赋值点全裸写 user.value）。
   *
   * 不变量：`tagsView.switchOwner` **只经本函数调用**。teardownSession() 不额外再调
   * `switchOwner(null)` 当「冗余保险」—— 那是恒 no-op（switchOwner 对同 owner 早退，
   * 上面 setUser(null) 刚切过），只会把归属切换的所有权搅成两处。要清 tagsView 就改
   * setUser，不要另开一条路。
   */
  function setUser(u: CurrentUser | null): void {
    user.value = u;
    useTagsViewStore().switchOwner(u?.id ?? null);
  }

  /**
   * 会话终止的**唯一**收口，**刻意不收 router 参数** —— 纯状态 + 缓存
   * 收口，导航职责由调用方在其之上追加（目前只有 `forceLogout(router)`）。终止入口
   * 全部汇到它，共 4 条：
   *   1. `logout()` —— 用户点退出（以 `apiLogout()` 成功 resolve 为前提，见该函数注释）；
   *   2. `forceLogout(router)` —— 'auth:session-lost' 且 reason 为 `auth expired`
   *      （会话真被吊销）；**或**被 `refreshOrLogout()` catch 委托调用（见第 3 条）；
   *   3. `refreshOrLogout()` catch —— /iam/me 校验失败（路由守卫，或 WS 4001
   *      `access token expired` 的恢复尝试），本身不直接调本函数，
   *      透传 router 给 `forceLogout(router)`，实际执行体在这里；
   *   4. `auth:logout` 事件 —— 40105 SESSION_REVOKED / refresh 失败
   *      （api/http.ts 的错误拦截器 dispatch，listener 在本文件 setup 内挂）。
   * **新增第 5 条终止路径时，必须改走本函数。**
   */
  function teardownSession(): void {
    // 幂等短路：auth:logout 可能被 dispatch 多次（并发请求同时命中错误拦截器的
    // 40105 分支与 refresh 失败分支），且测试里 listener 会跨 Pinia 实例
    // 累积。重复清理会重复 dispatch auth:session-changed → WS 侧多余 syncWsUrl()。
    if (!token.value && !user.value) return;
    token.value = null;
    refreshTokenValue = null;
    setUser(null);
    // isDummyAuthActiveValue 只在 initDummyAuth() 置 true，复位点必须在本函数：
    // dev dummy 模式登出后路由守卫仍走 dummy 短路，等于永远登不出「开发模式」。
    isDummyAuthActiveValue.value = false;
    // 2026-10-09：删盘包 try/catch。隐私模式 / 存储被站点策略禁用时 removeItem 抛
    // SecurityError，原来会把整个收口函数炸掉 —— 后面派发 auth:session-changed（WS 断开）
    // 与 queryClient.clear()（跨账号缓存隔离的唯一手段）都还没执行 ⇒ 既不断连接也不清
    // 缓存，只在控制台留一条异常。会话已在内存里清掉了，删盘失败不该阻断后续步骤。
    try {
      localStorage.removeItem('auth_session');
    } catch {
      /* 存储不可用：内存态已清，继续往下收口 */
    }
    // 登出后必须让 WS 层主动断开。detail.token = null → syncWsUrl() 把 URL 置为
    // undefined → closeConnection() 先 close() 再因 `_init()` 见 url undefined 直接返回。
    // 少了这一步，WS 会拿着刚被吊销的 session 持续重连直到页面关闭。
    window.dispatchEvent(new CustomEvent('auth:session-changed', { detail: { token: null } }));
    // 2026-10-09：拆掉 access token 保活定时器。storage 里已无 token ⇒ 该函数走「不排期」
    // 分支（幂等，删表后即 no-op）。少了这一步，登出后最多还挂着一枚定时器直到 TTL 走完
    // （约 10 分钟），到点还会发一次注定失败的 refresh。
    ensureAccessTokenKeepalive();
    // tagsView 归属已由上面的 setUser(null) 切到 null（清内存、不写盘）—— 不再重复
    // 调 switchOwner(null)，理由见 setUser 的不变量注释。
    // 内存 query 缓存全清。全仓所有 queryKey（src/composables/queries/keys.ts
    // + 各视图内 query）均无 user 维度，登出 → 不刷新页面 → 换账号登录会把上一账号的
    // 数据零网络请求直喂新账号。clear() 自带 in-flight 取消且是 silent
    // （node_modules/@tanstack/query-core/build/modern/queryCache.js:109 `clear()` →
    // `remove()` → 同包 query.js:129-132 `destroy()` → `this.cancel({ silent: true })`），
    // **禁止**再叠 cancelQueries()：默认非 silent 会触发仓内 query 的
    // `watch(error, …ElMessage.error)` 桥接，登出瞬间刷一屏假错误。
    // dashboard 系 3 个 query 用 gcTime: POSITIVE_INFINITY（永不被 GC），
    // 靠这一步兜底。
    queryClient.clear();
  }

  // ===== getters（标量：computed 属性不带括号）=====
  const isAuthenticated = computed(() => !!token.value && !!user.value);
  const roles = computed<string[]>(() => user.value?.roles ?? []);
  const menus = computed<MenuNode[]>(() => user.value?.menus ?? []);
  const boundShelves = computed<string[]>(() => user.value?.shelf_ids ?? []);
  const activeShelfId = computed<string | null>(() => boundShelves.value[0] ?? null);
  const isWildcardShelfAccount = computed(
    () => roles.value.includes('SHELF_ACCOUNT') && boundShelves.value.length === 0,
  );
  const isDummyAuthActive = computed(() => isDummyAuthActiveValue.value);

  // ===== getters（函数式：computed 返回函数，调用形态保留 auth.hasRole('X')）=====
  const hasRole = computed(() => (role: string) => roles.value.includes(role));
  const hasMenuCode = computed(() => (code: string) => {
    const stack: MenuNode[] = [...menus.value];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.code === code) return true;
      if (n.children.length > 0) stack.push(...n.children);
    }
    return false;
  });
  const canOperateShelf = computed(() => (shelfId: string) => {
    if (roles.value.includes('MANAGER')) return true;
    if (!roles.value.includes('SHELF_ACCOUNT')) return false;
    // 2026-07-13：与后端 CurrentUser.can_operate_shelf 对齐，补 wildcard 兜底
    // （SHELF_ACCOUNT 且未绑任何 active 架 → 视为共享 HMI 通行）。
    if (isWildcardShelfAccount.value) return true;
    return boundShelves.value.includes(shelfId);
  });
  const getAuthHeader = computed(() => (): Record<string, string> => {
    if (!token.value) return {};
    return { Authorization: `Bearer ${token.value}` };
  });

  // ===== login mutation（从 LoginView 搬入）=====
  // 2026-09-26 迁移：原 LoginView 内 useMutation 全局唯一 mutation 形态太重（isPending
  // / error 只在 LoginView 可见），搬到 store 后全局可见（其它视图也可订阅）。
  // 不写 retry：信任 main.ts 全局 mutations.retry: 0。
  // onSuccess 跳转逻辑不进 store，由 LoginView 在 mutateAsync 后处理角色路由。
  const loginMutation = useMutation<CurrentUser, ApiError, LoginCredentials>({
    mutationKey: ['auth', 'login'],
    mutationFn: async (creds) => {
      const resp = await apiLogin(creds.username, creds.password);
      token.value = resp.token;
      refreshTokenValue = resp.refresh_token ?? null;
      // 必须在 saveToStorage() 之前：saveToStorage 读 user.value
      setUser(resp.user);
      saveToStorage();
      return resp.user;
    },
    // 2026-10-01 新增：通知长连接层 token 已就位。api/dashboard.ts 的 WS URL 是
    // 「模块级 shallowRef + auth:session-changed 时 syncWsUrl()」—— 没有这一步，
    // 登出后不刷新页面直接重新登录，WS 手里还是登出前那个已被吊销的 token，
    // 会陷入 40105 无限重连（首屏 HTTP 正常、控制台一直刷 WS 报错）。
    // 不 import api/dashboard（那会形成 auth ↔ api 循环依赖），走 CustomEvent 解耦。
    onSuccess: () => {
      // 登录响应体里的 token 已经由 mutationFn 写进 localStorage，syncWsUrl 会现读。
      window.dispatchEvent(
        new CustomEvent('auth:session-changed', { detail: { token: token.value } }),
      );
    },
  });
  // ===== actions =====
  /** 主动登出（用户点「退出」）。
   *  2026-10-02 订正：原注释称「与下面 forceLogout 的清会话序列逐字相同，唯一差异是
   *  本函数先 await apiLogout()、且不跳 /login，强行合并会给 forceLogout 添一个
   *  router 可选参数」—— 该结论已随 M-4 失效：两条路径现在共用
   *  `teardownSession()`（无 router 的纯收口），导航差异由 `forceLogout(router)`
   *  在其之上**追加**而非内联，故不合并是「收口 + 追加导航」两层，不是「多一个
   *  可选参数」。
   *  保留的语义差异有两条：① 本函数**先 await apiLogout() 通知后端**，后端登出失败时
   *  该 promise 会 reject 并被 `src/composables/useUserActions.ts` 的空 catch
   *  （注释 `cancelled`）吞掉 ⇒ 收口不跑。已知缺口，单开「登出失败也要清会话」跟进。
   *  ② 本函数**不导航**，路由跳转由调用方负责。改本函数时必须同步看 `forceLogout`。 */
  async function logout(): Promise<void> {
    await apiLogout();
    teardownSession();
  }

  /** 无条件终止本地会话 + 跳 /login，**不联系后端**。
   *
   *  存在理由：会话确实没救了才调它，只有两种情形：
   *    ① 'auth:session-lost' 的 reason 是 `auth expired` —— 后端已权威判定会话被吊销
   *      （登出 / 改密 / 管理员停用 / reuse detection），refresh 不可能救回来；
   *    ② `refreshOrLogout` 的 catch 分支 —— /iam/me 复核失败。
   *  另一个 reason `access token expired`（只是这枚 access JWT 自然过期，refresh
   *  token 仍有效）**不走这里**：router 层先试 refreshOrLogout —— WS 层已不再为它
   *  删 localStorage，apiMe() 因此能带上有意义的 Authorization 发出这次往返。
   *
   *  与 teardownSession 的分工：本函数**保留 router 参数**（签名是 app 层唯一的
   *  导航注入点，`src/router/index.spec.ts` 有用例锁住「参数是 router 实例本身」），
   *  结构改为「teardownSession() 收口 + router.replace('/login') 追加导航」。
   *  **router 参数刻意保留、不改成无参**。
   *
   *  幂等性：可重复调用（并发 4001 / 路由守卫 / 登出）。teardownSession() 有幂等短路
   *  （token/user 都空直接 return），`router.replace` 本身幂等 ⇒ 重复调用不产生额外
   *  副作用。
   *
   *  dummy-auth 不需要特判：`initDummyAuth` 只写内存不写 localStorage，
   *  `syncWsUrl()` 读不到 token → URL 恒为 undefined → 零连接尝试 ⇒ 收不到 4001。
   *
   *  router 通过参数注入（store 不 import vue-router，避免循环依赖，不变式）。 */
  function forceLogout(router: { replace: (p: string) => void }): void {
    // 清 state / removeItem / 派发 / 清 tagsView / 清 query 缓存全部由
    // teardownSession() 收口，本函数只追加导航。
    teardownSession();
    router.replace('/login');
  }

  /** 异步守卫：拉 /iam/me 验证 token 仍有效；失败则终止会话跳 /login。
   *
   *  router 通过参数注入（store 不 import vue-router，避免循环依赖）。失败分支把
   *  router 透传给 `forceLogout(router)`，由它完成「收口 + 导航」——守卫侧拿到
   *  false 后只需 `next(false)` 取消这条已被取代的导航（见 src/router/index.ts 的
   *  全局前置守卫）。 */
  async function refreshOrLogout(router: { replace: (p: string) => void }): Promise<boolean> {
    try {
      const u = await apiMe();
      // 兼容老后端（没有 menus 字段）
      u.menus = u.menus ?? [];
      setUser(u);
      return true;
      // 失败分支统一委托给 forceLogout(router)，避免两处
      // 「清 state + removeItem + 派发 + 跳转」各写一份而漂移。
    } catch {
      forceLogout(router);
      return false;
    }
  }

  // 2026-08-26 新增 / 2026-08-28 重写：dummy-auth 注入（仅 `npm run dev:dummy` 时被调用）。
  // 第三道 prod 保护：import.meta.env.DEV === false 时整段 dead code，prod bundle
  // 不含此函数体。不写 localStorage，避免下次非 dummy 启动时被 loadFromStorage 复活。
  function initDummyAuth(): void {
    if (!isDummyAuthRequested()) return;

    setUser({
      id: '1999999999001',
      username: 'dev-admin',
      full_name: '开发模式管理员',
      is_active: true,
      roles: ['MANAGER', 'SHELF_ACCOUNT'],
      shelf_ids: [],
      menus: ADMIN_MENUS,
    });
    token.value = 'dummy-dev-token';
    refreshTokenValue = 'dummy-dev-refresh';
    isDummyAuthActiveValue.value = true;
    // 2026-08-28 新增：浏览器 console 确认标记。仅 dev 模式（外层 isDummyAuthRequested
    // 已守），prod bundle tree-shake 掉，no-op。
    console.info('[dummy-auth] 已注入开发用管理员会话（dev-only）');
  }

  // ===== CustomEvent listener =====
  // 2026-09-26 沿用：拦截器不直接 import store（会引入循环依赖），通过 CustomEvent
  // 解耦。listener 在 setup 回调内挂，首次 useAuthStore() 时就位。
  if (typeof window !== 'undefined') {
    window.addEventListener('auth:tokens-refreshed', ((e: Event) => {
      const ce = e as CustomEvent<{ token: string; refresh_token: string; user: CurrentUser }>;
      const pair = ce.detail;
      if (pair?.token) {
        token.value = pair.token;
        refreshTokenValue = pair.refresh_token ?? null;
        setUser(pair.user);
      }
    }) as EventListener);

    // 'auth:logout'（会话终止路径 4）：40105 SESSION_REVOKED 与 refresh 失败
    // 由 api/http.ts 的错误拦截器 dispatch。src/main.ts 只负责导航，会话状态
    // （token / user / localStorage / tagsView / query 缓存）由本 listener 收口。
    // 箭头函数包裹：显式忽略 Event 实参（拦截器 dispatch 时不带 detail，直传会 TS2345）。
    window.addEventListener('auth:logout', (() => {
      teardownSession();
    }) as EventListener);
  }

  // ===== 启动时恢复（首次 useAuthStore() 触发）=====
  loadFromStorage();

  return {
    user,
    token,
    isAuthenticated,
    roles,
    menus,
    boundShelves,
    activeShelfId,
    isWildcardShelfAccount,
    isDummyAuthActive,
    hasRole,
    hasMenuCode,
    canOperateShelf,
    getAuthHeader,
    loginMutation,
    logout,
    forceLogout,
    refreshOrLogout,
    initDummyAuth,
  };
});
