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
  });

  // ===== actions =====
  async function logout(): Promise<void> {
    await apiLogout();
    token.value = null;
    refreshTokenValue = null;
    user.value = null;
    localStorage.removeItem('auth_session');
  }

  /** 异步守卫：拉 /iam/me 验证 token 仍有效；失败则清 session 跳 /login。
   *  router 通过参数注入（store 不 import vue-router，避免循环依赖）。 */
  async function refreshOrLogout(router: { replace: (p: string) => void }): Promise<boolean> {
    try {
      const u = await apiMe();
      // 兼容老后端（没有 menus 字段）
      u.menus = u.menus ?? [];
      user.value = u;
      return true;
    } catch {
      token.value = null;
      refreshTokenValue = null;
      user.value = null;
      localStorage.removeItem('auth_session');
      router.replace('/login');
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
    refreshOrLogout,
    initDummyAuth,
  };
});
