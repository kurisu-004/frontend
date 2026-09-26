// src/stores/__tests__/auth.spec.ts
//
// 2026-09-26 新增：useAuthStore (Pinia setup store) 单测。
//
// 覆盖（按 PLAN.md §6.1）：
//   - initDummyAuth 注入（VITE_DUMMY_AUTH=true / 未设 / 'false'）
//   - loadFromStorage 自执行恢复（localStorage 有 session → state 填好）
//   - login 成功写 state + saveToStorage
//   - login 失败（40101 ApiError）通过 loginMutation.error 暴露
//   - logout 清 state + localStorage
//   - refreshOrLogout 成功 / 失败两条路径
//   - auth:tokens-refreshed CustomEvent 同步 state
//
// 测试基础设施：每个用例前重置 Pinia + 注册 VueQueryPlugin（mutation 需要
// QueryClient，否则 useMutation 会抛 "No QueryClient set"）。
// 用 vi.stubEnv / vi.unstubAllEnvs 切 VITE_DUMMY_AUTH。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// mock @/api/iam 拿到稳定的 spy；不要让真实 axios 跑进用例
vi.mock('@/api/iam', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
}));

import { login as apiLogin, logout as apiLogout, me as apiMe } from '@/api/iam';
import { ApiError } from '@/api/http';
import type { CurrentUser } from '@/types/user';
import { useAuthStore } from '../auth';
import { ADMIN_MENUS } from '@/composables/__fixtures__/adminMenus';

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u1',
    username: 'alice',
    full_name: 'Alice',
    is_active: true,
    roles: ['MANAGER'],
    shelf_ids: [],
    menus: [],
    ...overrides,
  };
}

describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    // 2026-09-26：每个用例重建 Pinia + VueQueryPlugin。useMutation 需要 QueryClient
    // 否则会抛 "No QueryClient set"。
    const app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, {
      queryClient: new QueryClient({ defaultOptions: { mutations: { retry: 0 } } }),
    });
    setActivePinia(app.config.globalProperties.$pinia);
    vi.mocked(apiLogin).mockReset();
    vi.mocked(apiLogout).mockReset();
    vi.mocked(apiMe).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ===== loadFromStorage 自执行恢复 =====
  describe('loadFromStorage (auto-run on first useAuthStore)', () => {
    it('restores user/token from localStorage on store creation', () => {
      localStorage.setItem(
        'auth_session',
        JSON.stringify({
          token: 'stored-tok',
          refresh_token: 'stored-refresh',
          user: makeUser({ username: 'restored' }),
        }),
      );
      const auth = useAuthStore();
      expect(auth.token).toBe('stored-tok');
      expect(auth.user?.username).toBe('restored');
      expect(auth.isAuthenticated).toBe(true);
    });

    it('keeps state empty when localStorage has no auth_session', () => {
      const auth = useAuthStore();
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
      expect(auth.isAuthenticated).toBe(false);
    });

    it('keeps state empty when localStorage payload is corrupt', () => {
      localStorage.setItem('auth_session', 'not-json');
      const auth = useAuthStore();
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
    });
  });

  // ===== initDummyAuth =====
  describe('initDummyAuth', () => {
    it('injects admin user when VITE_DUMMY_AUTH=true', () => {
      vi.stubEnv('VITE_DUMMY_AUTH', 'true');
      const auth = useAuthStore();
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      auth.initDummyAuth();
      expect(auth.isAuthenticated).toBe(true);
      expect(auth.user?.username).toBe('dev-admin');
      expect(auth.user?.roles).toContain('MANAGER');
      expect(auth.isDummyAuthActive).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith('[dummy-auth] 已注入开发用管理员会话（dev-only）');
      // 2026-08-28：initDummyAuth 不写 localStorage，避免下次非 dummy 启动时被 loadFromStorage
      // 复活。
      expect(localStorage.getItem('auth_session')).toBeNull();
      infoSpy.mockRestore();
    });

    it('does not inject when VITE_DUMMY_AUTH is not set', () => {
      const auth = useAuthStore();
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      auth.initDummyAuth();
      expect(auth.isAuthenticated).toBe(false);
      expect(auth.isDummyAuthActive).toBe(false);
      expect(infoSpy).not.toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('does not inject when VITE_DUMMY_AUTH is explicitly false', () => {
      vi.stubEnv('VITE_DUMMY_AUTH', 'false');
      const auth = useAuthStore();
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      auth.initDummyAuth();
      expect(auth.isAuthenticated).toBe(false);
      expect(auth.isDummyAuthActive).toBe(false);
      infoSpy.mockRestore();
    });
  });

  // ===== login mutation =====
  describe('loginMutation', () => {
    it('writes state + persists to localStorage on success', async () => {
      vi.mocked(apiLogin).mockResolvedValue({
        token: 'new-tok',
        refresh_token: 'new-refresh',
        user: makeUser({ username: 'bob' }),
      });
      const auth = useAuthStore();
      const u = await auth.loginMutation.mutateAsync({ username: 'bob', password: 'pw' });
      expect(u.username).toBe('bob');
      expect(auth.token).toBe('new-tok');
      expect(auth.user?.username).toBe('bob');
      // 持久化到 localStorage
      const persisted = JSON.parse(localStorage.getItem('auth_session')!);
      expect(persisted.token).toBe('new-tok');
      expect(persisted.refresh_token).toBe('new-refresh');
      expect(persisted.user.username).toBe('bob');
    });

    it('exposes ApiError via loginMutation.error on 40101', async () => {
      vi.mocked(apiLogin).mockRejectedValue(new ApiError(40101, 'invalid credentials'));
      const auth = useAuthStore();
      try {
        await auth.loginMutation.mutateAsync({ username: 'bob', password: 'wrong' });
      } catch {
        /* 错误会通过 mutation observer 写入 error，下面断言它 */
      }
      // 2026-09-26：Pinia store 自动解包嵌套 ref —— store.loginMutation.error 直接
      // 是 ApiError 值，不需要 .value。
      const err = auth.loginMutation.error as ApiError | null;
      expect(err?.code).toBe(40101);
    });
  });

  // ===== logout =====
  describe('logout', () => {
    it('clears state + localStorage', async () => {
      vi.mocked(apiLogout).mockResolvedValue(undefined);
      const auth = useAuthStore();
      // 先登录注入 state
      vi.mocked(apiLogin).mockResolvedValue({
        token: 't',
        refresh_token: 'r',
        user: makeUser(),
      });
      await auth.loginMutation.mutateAsync({ username: 'a', password: 'b' });
      expect(auth.isAuthenticated).toBe(true);

      await auth.logout();
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
      expect(auth.isAuthenticated).toBe(false);
      expect(localStorage.getItem('auth_session')).toBeNull();
    });
  });

  // ===== refreshOrLogout =====
  describe('refreshOrLogout', () => {
    it('returns true and updates user on success', async () => {
      vi.mocked(apiMe).mockResolvedValue(makeUser({ username: 'refreshed' }));
      const auth = useAuthStore();
      const router = { replace: vi.fn() };
      const ok = await auth.refreshOrLogout(router);
      expect(ok).toBe(true);
      expect(auth.user?.username).toBe('refreshed');
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('clears state and routes to /login on failure', async () => {
      vi.mocked(apiMe).mockRejectedValue(new ApiError(40102, 'expired'));
      // 预置一个 session 模拟「已登录但 token 失效」
      localStorage.setItem(
        'auth_session',
        JSON.stringify({ token: 'old', refresh_token: 'r', user: makeUser() }),
      );
      const auth = useAuthStore();
      const router = { replace: vi.fn() };
      const ok = await auth.refreshOrLogout(router);
      expect(ok).toBe(false);
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
      expect(localStorage.getItem('auth_session')).toBeNull();
      expect(router.replace).toHaveBeenCalledWith('/login');
    });
  });

  // ===== CustomEvent auth:tokens-refreshed =====
  describe("auth:tokens-refreshed CustomEvent (http.ts interceptor)", () => {
    it('syncs state when interceptor dispatches refreshed tokens', () => {
      const auth = useAuthStore();
      window.dispatchEvent(
        new CustomEvent('auth:tokens-refreshed', {
          detail: {
            token: 'refreshed-tok',
            refresh_token: 'refreshed-refresh',
            user: makeUser({ username: 'after-refresh' }),
          },
        }),
      );
      expect(auth.token).toBe('refreshed-tok');
      expect(auth.user?.username).toBe('after-refresh');
    });

    it('does not throw when event has no detail', () => {
      const auth = useAuthStore();
      expect(() => {
        window.dispatchEvent(new CustomEvent('auth:tokens-refreshed'));
      }).not.toThrow();
      // state 不变
      expect(auth.token).toBeNull();
    });
  });

  // ===== getters（标量 + 函数式形态）=====
  describe('getters', () => {
    it('标量 getter 不带括号（isAuthenticated / menus / activeShelfId / boundShelves / isWildcardShelfAccount / isDummyAuthActive）', () => {
      localStorage.setItem(
        'auth_session',
        JSON.stringify({
          token: 't',
          refresh_token: 'r',
          user: makeUser({
            roles: ['SHELF_ACCOUNT'],
            shelf_ids: ['s1', 's2'],
            menus: ADMIN_MENUS,
          }),
        }),
      );
      const auth = useAuthStore();
      expect(typeof auth.isAuthenticated).toBe('boolean');
      expect(auth.isAuthenticated).toBe(true);
      expect(Array.isArray(auth.menus)).toBe(true);
      expect(auth.boundShelves).toEqual(['s1', 's2']);
      expect(auth.activeShelfId).toBe('s1');
      // SHELF_ACCOUNT + 绑了架 → 非 wildcard
      expect(auth.isWildcardShelfAccount).toBe(false);
      expect(auth.isDummyAuthActive).toBe(false);
    });

    it('SHELF_ACCOUNT 未绑架 → isWildcardShelfAccount === true', () => {
      localStorage.setItem(
        'auth_session',
        JSON.stringify({
          token: 't',
          refresh_token: 'r',
          user: makeUser({ roles: ['SHELF_ACCOUNT'], shelf_ids: [] }),
        }),
      );
      const auth = useAuthStore();
      expect(auth.isWildcardShelfAccount).toBe(true);
    });

    it('函数式 getter 保留调用形态（hasRole / hasMenuCode / canOperateShelf / getAuthHeader）', () => {
      localStorage.setItem(
        'auth_session',
        JSON.stringify({
          token: 'h-tok',
          refresh_token: 'r',
          user: makeUser({ roles: ['MANAGER', 'CLERK'], shelf_ids: ['s1'] }),
        }),
      );
      const auth = useAuthStore();
      // 形态：必须以 () 调用（不是属性）
      expect(auth.hasRole('MANAGER')).toBe(true);
      expect(auth.hasRole('UNKNOWN')).toBe(false);
      expect(auth.canOperateShelf('s1')).toBe(true);
      expect(auth.canOperateShelf('s99')).toBe(true); // MANAGER 通行
      expect(auth.getAuthHeader()).toEqual({ Authorization: 'Bearer h-tok' });
      // hasMenuCode：空树返回 false
      expect(auth.hasMenuCode('anything')).toBe(false);
    });

    it('hasMenuCode 在菜单树中找到 code', () => {
      localStorage.setItem(
        'auth_session',
        JSON.stringify({
          token: 't',
          refresh_token: 'r',
          user: makeUser({ menus: ADMIN_MENUS }),
        }),
      );
      const auth = useAuthStore();
      expect(auth.hasMenuCode('parts_list')).toBe(true);
      expect(auth.hasMenuCode('not_exists')).toBe(false);
    });

    it('getAuthHeader 在未登录时返回空对象', () => {
      const auth = useAuthStore();
      expect(auth.getAuthHeader()).toEqual({});
    });
  });
});
