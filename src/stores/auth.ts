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
//   - loadFromStorage() 在 setup 回调末尾自执行（首次 useAuthStore() 时触发）；Listener
//     在 setup 里挂；保证首次实例化就具备 localStorage 恢复 + 事件同步能力。
//   - 2026-10-02 新增 forceLogout(router)：「后端已权威判定会话失效」时无条件终止本地
//     会话（不联系后端），refreshOrLogout 的失败分支委托给它。详见函数注释。
//   - main.ts 在 dummy 模式下先调 useAuthStore().initDummyAuth()，再 app.use(router)，
//     路由守卫触发时 isDummyAuthActive 已是 true，refreshOrLogout 短路。
//   - Zod schema（loginSchema）与角色路由跳转仍留 LoginView.vue（视图关注点）。store
//     不持 Zod schema、不接 router.push，仅 expose loginMutation（error / isPending）。
//   - 消费侧禁止解构 store：统一 auth.xxx 访问（响应式），沿用 usePartsListStore
//     不变量 #3。

import { ref, computed, type Ref } from 'vue';
import { defineStore } from 'pinia';
import { useMutation } from '@tanstack/vue-query';
import { login as apiLogin, logout as apiLogout, me as apiMe } from '@/api/iam';
import type { ApiError } from '@/api/http';
import type { CurrentUser } from '@/types/user';
import type { MenuNode } from '@/types/menu';
import { ADMIN_MENUS } from '@/composables/__fixtures__/adminMenus';
// 2026-09-28 新增：登出联动清空 tagsView（auth → tagsView 单向引用，tagsView 不
// 反向 import auth，无循环依赖）。plugin 持久化在 mutation 后会立即把空数组写
// localStorage['tags_view']，下次启动看到空 tags 条。
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
      user.value = s.user;
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
      user.value = resp.user;
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
  async function logout(): Promise<void> {
    await apiLogout();
    token.value = null;
    refreshTokenValue = null;
    user.value = null;
    localStorage.removeItem('auth_session');
    // 2026-10-01 新增：登出后必须让 WS 层主动断开。detail.token = null →
    // syncWsUrl() 把 URL 置为 undefined → VueUse open() 先 close() 再因
    // `_init()` 见 url undefined 直接返回。少了这一步，WS 会拿着刚被吊销的
    // session 持续重连直到页面关闭。
    window.dispatchEvent(
      new CustomEvent('auth:session-changed', { detail: { token: null } }),
    );
    // 2026-09-28 新增：联动清空 tagsView（visited + cache）。插件持久化会立即把
    // 空数组写 localStorage['tags_view']。
    useTagsViewStore().reset();
  }

  /** 2026-10-02 修复（review Major 1）：无条件终止本地会话 + 跳 /login，**不联系后端**。
   *
   *  存在理由：dashboard WS 收到关闭码 4001（会话在连接期间失效）时，后端已经是
   *  权威判定。此前 app 层（src/router/index.ts）收到 'auth:session-lost' 后走
   *  `refreshOrLogout(router)` 复核 /iam/me，**那次复核在构造上必然失败**：
   *    - WS 层在派发事件前已 `localStorage.removeItem('auth_session')`（dashboard.ts:245）；
   *    - http.ts 请求拦截器只从 localStorage 取 token（`readToken()`），不读 store；
   *    ⇒ `apiMe()` 发出的请求根本不带 Authorization，后端 middleware 直接返
   *      `40100 UNAUTHORIZED`，`stillValid === true` 是不可达的死分支。
   *  副作用还有两个：① 「UI 显示已登录、实际已登出」的窗口长达一次 RTT
   *  （store 内存 token/user 未清，后端不可达时最长 30s axios timeout），期间任何
   *  用户操作都会发出无 token 请求 → 40100 → 弹「操作失败」；② 多一次必然失败的
   *  往返，白等一个 RTT 才跳登录页。4001 本身没有「HTTP 侧仍有效」这种边界情况 ——
   *  真有的话后端会在 re-auth 阶段继续握手成功而不是发 Close 帧。
   *
   *  幂等性：可重复调用（登出 → 登出、4001 与路由守卫并发），每步都是「置 null /
   *  removeItem / reset / replace」，后一次覆盖前一次，无副作用。`router.replace`
   *  本身幂等。
   *
   *  dummy-auth 不需要特判：`initDummyAuth` 只写内存不写 localStorage，
   *  `syncWsUrl()` 读不到 token → URL 恒为 undefined → 零连接尝试 ⇒ 收不到 4001。
   *
   *  router 通过参数注入（store 不 import vue-router，避免循环依赖，不变式）。 */
  function forceLogout(router: { replace: (p: string) => void }): void {
    token.value = null;
    refreshTokenValue = null;
    user.value = null;
    localStorage.removeItem('auth_session');
    // 2026-10-01 新增：同 logout —— session 已死，让 WS 层断开，
    // 否则它会拿着失效 token 持续重连刷控制台。
    window.dispatchEvent(
      new CustomEvent('auth:session-changed', { detail: { token: null } }),
    );
    // 2026-10-02 修复（review Minor 2）：联动清空 tagsView（对齐 logout()）。
    // 此前只有 logout() 清，refreshOrLogout 失败分支不清 —— 「正在用着被踢登录」
    // 变成常规路径（4001 / 会话过期）后，tag 条会保留旧页签，重新登录后仍在。
    useTagsViewStore().reset();
    router.replace('/login');
  }

  /** 异步守卫：拉 /iam/me 验证 token 仍有效；失败则终止会话跳 /login。
   *  router 通过参数注入（store 不 import vue-router，避免循环依赖）。 */
  async function refreshOrLogout(router: { replace: (p: string) => void }): Promise<boolean> {
    try {
      const u = await apiMe();
      // 兼容老后端（没有 menus 字段）
      u.menus = u.menus ?? [];
      user.value = u;
      return true;
      // 失败分支统一委托给 forceLogout(router)（2026-10-02 提取），避免两处
      // 「清 state + removeItem + 派发 + 跳转」各写一份而漂移（review Major 1）。
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

    user.value = {
      id: '1999999999001',
      username: 'dev-admin',
      full_name: '开发模式管理员',
      is_active: true,
      roles: ['MANAGER', 'SHELF_ACCOUNT'],
      shelf_ids: [],
      menus: ADMIN_MENUS,
    };
    token.value = 'dummy-dev-token';
    refreshTokenValue = 'dummy-dev-refresh';
    isDummyAuthActiveValue.value = true;
    // 2026-08-28 新增：浏览器 console 确认标记。仅 dev 模式（外层 isDummyAuthRequested
    // 已守），prod bundle tree-shake 掉，no-op。
    console.info('[dummy-auth] 已注入开发用管理员会话（dev-only）');
  }

  // ===== CustomEvent listener（http.ts 拦截器刷新成功后同步）=====
  // 2026-09-26 沿用：拦截器不直接 import store（会引入循环依赖），通过 CustomEvent
  // 解耦。listener 在 setup 回调内挂，首次 useAuthStore() 时就位。
  if (typeof window !== 'undefined') {
    window.addEventListener('auth:tokens-refreshed', ((e: Event) => {
      const ce = e as CustomEvent<{ token: string; refresh_token: string; user: CurrentUser }>;
      const pair = ce.detail;
      if (pair?.token) {
        token.value = pair.token;
        refreshTokenValue = pair.refresh_token ?? null;
        user.value = pair.user;
      }
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
