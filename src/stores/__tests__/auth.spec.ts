// src/stores/__tests__/auth.spec.ts
//
// 2026-09-26 新增：useAuthStore (Pinia setup store) 单测。
//
// 覆盖（按 PLAN.md §6.1）：
//   - initDummyAuth 注入（VITE_DUMMY_AUTH=true / 未设 / 'false'）+ 缺陷 C 复位护栏
//   - loadFromStorage 自执行恢复（localStorage 有 session → state 填好 + tagsView hydrate）
//   - login 成功写 state + saveToStorage
//   - login 失败（40101 ApiError）通过 loginMutation.error 暴露
//   - 2026-10-09：login 成功起 access token 保活定时器（saveToStorage 是登录路径的起表点，
//     它不经过 http.ts 的 persistTokens —— 漏了就等于登录后零流量的标签页没有保活链）
//   - logout 清 state + localStorage
//   - forceLogout 4 条既有用例（757c024 引入，本次签名不变、全部保留）
//   - refreshOrLogout 成功 / 失败两条路径
//   - auth:tokens-refreshed CustomEvent 同步 state + switchOwner 同 owner 早退护栏
//   - 2026-10-02（M-4）：4 条会话终止路径都清 TanStack Query 内存缓存（含
//     gcTime 永不过期的 query、跨账号闭环、tagsView per-user 隔离）
//
// 测试基础设施：每个用例前重置 Pinia + 注册 VueQueryPlugin。**两个原因**：
//   1. 2026-09-26：mutation 需要 QueryClient，否则 useMutation 抛 "No QueryClient set"；
//   2. 2026-10-02（M-4）：store setup 顶部调 useQueryClient()，且它**只在 store 首次
//      创建时**执行（后续 useAuthStore() 命中 pinia._s 缓存直接返回）⇒ 每个用例必须
//      重建 pinia + plugin，漏了会在首次 useAuthStore() 处抛
//      "vue-query hooks can only be used inside setup()..."。
// 用 vi.stubEnv / vi.unstubAllEnvs 切 VITE_DUMMY_AUTH。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// mock @/api/iam 拿到稳定的 spy；不要让真实 axios 跑进用例。
// refreshTokens 必须一并 mock：真实 http.ts 会 import 它，而「登录后保活定时器」那条用例
// 要真的走到 /iam/refresh（http.ts 是真模块，本 spec 只 mock api 层）。
vi.mock('@/api/iam', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  refreshTokens: vi.fn(),
}));

import {
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  refreshTokens as apiRefresh,
} from '@/api/iam';
import { ApiError, resetKeepaliveForTest } from '@/api/http';
import type { CurrentUser } from '@/types/user';
import { useAuthStore } from '../auth';
import { useTagsViewStore } from '../tagsView';
import { ADMIN_MENUS } from '@/composables/__fixtures__/adminMenus';

/** 2026-10-02：提成具名变量供「会话终止后 query 缓存为空」的断言用。 */
let testQueryClient: QueryClient;

/** 造一个 payload 带指定 exp 的假 JWT（decodeJwt 只解 payload，不验签）。
 *  登录路径的保活定时器要读 storage 里 token 的 exp，token 必须是能解出 exp 的 JWT。 */
function makeJwtWithExp(expEpochSec: number): string {
  const payload = btoa(
    JSON.stringify({
      sub: 'u1',
      aud: 'hsh-erp-rust',
      iat: expEpochSec - 900,
      nbf: expEpochSec - 900,
      exp: expEpochSec,
      iss: 'hsh-erp-rust',
      jti: 'test-jti',
      typ: 'access',
    }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

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
    // 否则会抛 "No QueryClient set"；2026-10-02 起 setup 顶部的 useQueryClient() 也需要它。
    const app = createApp({});
    app.use(createPinia());
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    app.use(VueQueryPlugin, { queryClient: testQueryClient });
    setActivePinia(app.config.globalProperties.$pinia);
    vi.mocked(apiLogin).mockReset();
    vi.mocked(apiLogout).mockReset();
    vi.mocked(apiMe).mockReset();
    vi.mocked(apiRefresh).mockReset();
    // 默认：refresh 成功并 rotation 出新的一对 token（新 access token 剩余 900s）
    vi.mocked(apiRefresh).mockResolvedValue({
      token: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900),
      refresh_token: 'rotated-refresh',
      user: makeUser(),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // http.ts 的保活定时器是**模块级**状态，本 spec 不 resetModules：用例跑完必须显式
    // 拆表，否则一枚还挂着的假定时器句柄会跨用例泄漏（resetKeepaliveForTest 走
    // clearTimeout，须在 vi.useRealTimers() 之前调，故放 afterEach 而非用例内）。
    resetKeepaliveForTest();
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

    // 2026-10-02（缺陷 B）：loadFromStorage → setUser → tagsView.switchOwner(u.id) 是
    // 「同账号重登恢复标签栏」能生效的时序前提：hydrate 必须发生在 setup 末尾的
    // loadFromStorage 链路里，而不是等某个后续事件。
    it("restores tagsView from the restored user's own key (myerp.tags_view.<id>)", () => {
      localStorage.setItem(
        'myerp.tags_view.u1',
        JSON.stringify({
          visitedViews: [
            {
              path: '/parts',
              fullPath: '/parts?status=active',
              name: 'PartsList',
              title: '零件一览',
            },
          ],
          cachedViewNames: ['PartsList'],
        }),
      );
      localStorage.setItem(
        'auth_session',
        JSON.stringify({ token: 'stored-tok', refresh_token: 'r', user: makeUser({ id: 'u1' }) }),
      );
      useAuthStore();
      const tags = useTagsViewStore();
      expect(tags.visitedViews).toHaveLength(1);
      expect(tags.visitedViews[0].path).toBe('/parts');
      expect(tags.cachedViewNames).toEqual(['PartsList']);
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

    // 2026-10-02（缺陷 C）「isDummyAuthActiveValue 永不复位」的回归护栏。此前该 ref
    // 只在 initDummyAuth() 置 true、从无复位点 ⇒ dev dummy 模式登出后路由守卫仍走
    // dummy 短路，等于永远登不出「开发模式」。M-4 已在 teardownSession() 里补上
    // `isDummyAuthActiveValue.value = false`，但那行此前没有任何 spec 断言 ——
    // 将来有人删掉，本 spec 仍全绿。
    //
    // 走真实路径：只 stub VITE_DUMMY_AUTH 一个变量就让 isDummyAuthRequested() 返回 true
    // （见本 describe 上面第一条既有用例：它同样只 stub 这一个变量就注入成功 ⇒ 测试
    // 环境下 import.meta.env.DEV 为 true，DEV 那一半条件天然满足，无需额外 stub）。
    it('logout 后 isDummyAuthActive 翻回 false（缺陷 C 回归护栏）', async () => {
      vi.stubEnv('VITE_DUMMY_AUTH', 'true');
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const auth = useAuthStore();
      auth.initDummyAuth();
      expect(auth.isDummyAuthActive).toBe(true);
      expect(auth.token).toBe('dummy-dev-token');

      vi.mocked(apiLogout).mockResolvedValue(undefined);
      await auth.logout();

      expect(auth.isDummyAuthActive).toBe(false);
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
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

    // 2026-10-09：登录成功后保活定时器必须在跑。登录是**唯一**不走 http.ts
    // persistTokens() 的 token 落盘路径（那条只在 doRefresh 里被调），起表点写在本 store
    // 的 saveToStorage() 里。缺了它，登录后长期零 HTTP 流量的标签页（空闲大屏 / HMI 屏）
    // 没有保活链 ⇒ access token 自然过期 ⇒ dashboard WS 的周期性 re-auth 拿 TOKEN_EXPIRED。
    it('登录成功后起 access token 保活定时器（零 HTTP 流量下到点自续期）', async () => {
      vi.useFakeTimers();
      try {
        // token 剩余寿命 700s > 提前量 300s ⇒ 登录后第一轮只排期、不立即刷新
        vi.mocked(apiLogin).mockResolvedValue({
          token: makeJwtWithExp(Math.floor(Date.now() / 1000) + 700),
          refresh_token: 'login-refresh',
          user: makeUser({ username: 'bob' }),
        });
        const auth = useAuthStore();
        await auth.loginMutation.mutateAsync({ username: 'bob', password: 'pw' });
        expect(auth.isAuthenticated).toBe(true);
        expect(apiRefresh).not.toHaveBeenCalled();

        // 推进到「剩余寿命 - 提前量 + 余量」= 700 - 300 + 5 = 405s：定时器到点，自己发
        // /iam/refresh（用的是登录响应里那枚 refresh token）。
        await vi.advanceTimersByTimeAsync(405_000);
        expect(apiRefresh).toHaveBeenCalledTimes(1);
        expect(apiRefresh).toHaveBeenCalledWith('login-refresh');
        // 续期后的新 token 已写盘（storage 与 store 都同步到新值）
        const persisted = JSON.parse(localStorage.getItem('auth_session')!);
        expect(persisted.refresh_token).toBe('rotated-refresh');
      } finally {
        vi.useRealTimers();
      }
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

  // ===== forceLogout（2026-10-02 新增，review Major 1 / Minor 2）=====
  describe('forceLogout', () => {
    /** 预置一个「已登录 + 有 tag 条」的状态，模拟用户正用着被后端踢下线。 */
    async function seedSession(auth: ReturnType<typeof useAuthStore>): Promise<void> {
      vi.mocked(apiLogin).mockResolvedValue({
        token: 'live-tok',
        refresh_token: 'live-refresh',
        user: makeUser(),
      });
      await auth.loginMutation.mutateAsync({ username: 'a', password: 'b' });
      useTagsViewStore().addView({
        path: '/dashboard',
        fullPath: '/dashboard',
        name: 'Dashboard',
        title: '首页',
      });
      expect(auth.isAuthenticated).toBe(true);
      expect(useTagsViewStore().visitedViews).toHaveLength(1);
    }

    it('清内存 state + 清 localStorage + 派发 auth:session-changed(null) + 跳 /login', async () => {
      const auth = useAuthStore();
      const router = { replace: vi.fn() };
      await seedSession(auth);

      // listener 在 seedSession 之后挂：登录本身也会派发 auth:session-changed(token)，
      // 这里只想断言「forceLogout 派发的那一条是 token=null」。
      const seen: (string | null)[] = [];
      const onChanged = (e: Event) => {
        seen.push((e as CustomEvent<{ token: string | null }>).detail.token);
      };
      window.addEventListener('auth:session-changed', onChanged);

      try {
        auth.forceLogout(router);

        expect(auth.token).toBeNull();
        expect(auth.user).toBeNull();
        expect(auth.isAuthenticated).toBe(false);
        expect(localStorage.getItem('auth_session')).toBeNull();
        // 派发是必须的：WS 层靠它把 URL 置 undefined 停掉重连
        expect(seen).toEqual([null]);
        expect(router.replace).toHaveBeenCalledWith('/login');
      } finally {
        window.removeEventListener('auth:session-changed', onChanged);
      }
    });

    it('连带清空 tagsView（review Minor 2：被踢登录后不该保留旧页签）', async () => {
      const auth = useAuthStore();
      const router = { replace: vi.fn() };
      await seedSession(auth);

      auth.forceLogout(router);

      expect(useTagsViewStore().visitedViews).toEqual([]);
    });

    it('幂等：可重复调用（与路由守卫的 refreshOrLogout 并发时也不会出问题）', async () => {
      const auth = useAuthStore();
      const router = { replace: vi.fn() };
      await seedSession(auth);

      auth.forceLogout(router);
      expect(() => auth.forceLogout(router)).not.toThrow();

      expect(auth.token).toBeNull();
      expect(router.replace).toHaveBeenCalledTimes(2);
    });

    it('不联系后端（不调 /iam/me）—— 4001 已经是权威判定', async () => {
      vi.mocked(apiMe).mockClear();
      const auth = useAuthStore();
      await seedSession(auth);

      auth.forceLogout({ replace: vi.fn() });

      expect(apiMe).not.toHaveBeenCalled();
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
      // 2026-10-02 review Nit 5：顺带锁定 tagsView 清理。refreshOrLogout 的失败分支
      // 委托给 forceLogout，守卫 / ScanBadgeGate 的失败路径因此
      // 也会清 tag 条（第一轮 Minor 2 的顺带效果）。若将来有人把 reset() 挪出
      // forceLogout，只有 forceLogout 的直测会红、守卫路径会静默退化 → 这里补断言。
      useTagsViewStore().addView({
        path: '/dashboard',
        fullPath: '/dashboard',
        name: 'Dashboard',
        title: '首页',
      });
      // 非空前置断言：否则下面的 `toEqual([])` 可能因为 addView 没生效而恒真
      expect(useTagsViewStore().visitedViews).toHaveLength(1);
      const auth = useAuthStore();
      const router = { replace: vi.fn() };
      const ok = await auth.refreshOrLogout(router);
      expect(ok).toBe(false);
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
      expect(localStorage.getItem('auth_session')).toBeNull();
      expect(useTagsViewStore().visitedViews).toEqual([]);
      expect(router.replace).toHaveBeenCalledWith('/login');
    });
  });

  // ===== 2026-10-02（M-4）：会话终止清理 query 缓存 =====
  describe('会话终止清理 query 缓存（M-4）', () => {
    /** 往 query 缓存塞一条数据（无 observer → inactive，gcTime 生效）。 */
    function seedQuery(key: string, gcTime?: number): void {
      const queryKey = ['seed', key];
      testQueryClient.setQueryData(queryKey, { key, items: ['a'] });
      if (gcTime !== undefined) {
        testQueryClient.getQueryCache().find({ queryKey })!.setOptions({ gcTime });
      }
    }

    function queryCount(): number {
      return testQueryClient.getQueryCache().getAll().length;
    }

    /** 登录一个账号并返回 store（顺带保证 token/user 就位）。 */
    async function loginAs(
      user: CurrentUser,
      token = 't',
    ): Promise<ReturnType<typeof useAuthStore>> {
      vi.mocked(apiLogin).mockResolvedValue({ token, refresh_token: 'r', user });
      const auth = useAuthStore();
      await auth.loginMutation.mutateAsync({ username: user.username, password: 'b' });
      return auth;
    }

    it('logout() 清空内存 query 缓存', async () => {
      const auth = await loginAs(makeUser());
      seedQuery('customers');
      expect(queryCount()).toBe(1);

      vi.mocked(apiLogout).mockResolvedValue(undefined);
      await auth.logout();

      expect(queryCount()).toBe(0);
      expect(auth.isAuthenticated).toBe(false);
    });

    it('auth:logout 事件（40105 / refresh 失败路径）同样清缓存并终止认证态', async () => {
      const auth = await loginAs(makeUser());
      seedQuery('workers');
      expect(auth.isAuthenticated).toBe(true);

      // http.ts:428 / :455 的 dispatch（无 detail）
      window.dispatchEvent(new CustomEvent('auth:logout'));

      expect(queryCount()).toBe(0);
      // 守第 4 条路径：会话状态也必须被清（此前只有 src/main.ts 跳登录页，
      // isAuthenticated 仍为 true → 路由守卫继续放行 requireAuth 路由）
      expect(auth.isAuthenticated).toBe(false);
      expect(auth.user).toBeNull();
      expect(localStorage.getItem('auth_session')).toBeNull();
    });

    it('forceLogout(router) 清空内存 query 缓存（757c024 新增的第 4 条终止路径）', async () => {
      const auth = await loginAs(makeUser());
      seedQuery('parts');
      expect(queryCount()).toBe(1);

      auth.forceLogout({ replace: vi.fn() });

      expect(queryCount()).toBe(0);
      expect(auth.isAuthenticated).toBe(false);
    });

    it('refreshOrLogout 失败后：缓存清空 + token/user 置空 + auth_session 已删', async () => {
      localStorage.setItem(
        'auth_session',
        JSON.stringify({ token: 'old', refresh_token: 'r', user: makeUser() }),
      );
      const auth = useAuthStore();
      seedQuery('shelf-processes');
      vi.mocked(apiMe).mockRejectedValue(new ApiError(40102, 'expired'));

      const ok = await auth.refreshOrLogout({ replace: vi.fn() });

      expect(ok).toBe(false);
      expect(queryCount()).toBe(0);
      expect(auth.token).toBeNull();
      expect(auth.user).toBeNull();
      expect(localStorage.getItem('auth_session')).toBeNull();
    });

    it('gcTime: POSITIVE_INFINITY 的 query（dashboard 系）也被 clear 兜底清掉', async () => {
      const auth = await loginAs(makeUser());
      seedQuery('dashboard-snapshot', Number.POSITIVE_INFINITY);
      expect(queryCount()).toBe(1);

      vi.mocked(apiLogout).mockResolvedValue(undefined);
      await auth.logout();

      // 正常 GC 策略下这条永远不会被淘汰，只能靠会话终止时的 clear()
      expect(queryCount()).toBe(0);
    });

    it('换账号闭环：logout → 换账号登录后不残留上一账号缓存（不产生新请求）', async () => {
      const auth = await loginAs(makeUser({ id: 'A', username: 'alice' }));
      // 模拟账号 A 打开货架页：按 can_access_shelf 收窄的映射数据进 query 缓存
      testQueryClient.setQueryData(['shelf-process-mappings'], {
        items: [{ shelf_id: 's1', process_ids: [1, 2] }],
        total: 1,
      });
      expect(queryCount()).toBe(1);

      vi.mocked(apiLogout).mockResolvedValue(undefined);
      await auth.logout();
      expect(queryCount()).toBe(0);

      // 换账号 B 登录（不刷新页面）
      await loginAs(
        makeUser({
          id: 'B',
          username: 'bob',
          roles: ['SHELF_ACCOUNT'],
          shelf_ids: ['s2'],
        }),
        't2',
      );
      expect(auth.user?.id).toBe('B');

      // 关键断言：新账号看到的货架↔工序映射缓存已被清空。真正证明「不发生缓存复用」
      // 的就是这一条 —— clear() 之后任何读点都必须重新取数，不可能从内存缓存里直接
      // 拿到账号 A 的那份。全仓 queryKey 均无 user 维度（src/composables/queries/keys.ts），
      // 所以「按 key 前缀失效」救不了，只能全清。
      expect(testQueryClient.getQueryData(['shelf-process-mappings'])).toBeUndefined();
      expect(queryCount()).toBe(0);
    });

    it('B 隔离：登出清内存但不写盘 —— 账号 A 的标签栏存档仍在自己的 key 里', async () => {
      const auth = await loginAs(makeUser({ id: 'A' }));
      const tags = useTagsViewStore();
      tags.addView({ path: '/parts', fullPath: '/parts', name: 'PartsList', title: '零件一览' });
      // 等一 tick 让 store 内部 watch 落盘
      await nextTick();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(localStorage.getItem('myerp.tags_view.A')).not.toBeNull();

      vi.mocked(apiLogout).mockResolvedValue(undefined);
      await auth.logout();

      // 内存清空（不串号）……
      expect(tags.visitedViews).toHaveLength(0);
      // ……但存档不丢：同账号下次登录还能恢复
      expect(localStorage.getItem('myerp.tags_view.A')).not.toBeNull();
      const persisted = JSON.parse(localStorage.getItem('myerp.tags_view.A') || '{}');
      expect(persisted.visitedViews).toHaveLength(1);
    });
  });

  // ===== CustomEvent auth:tokens-refreshed =====
  describe('auth:tokens-refreshed CustomEvent (http.ts interceptor)', () => {
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

    // 2026-10-02（缺陷 B 回归护栏）：tagsView `switchOwner` 的「同 owner 早退」是
    // 「token 刷新不丢标签栏」的唯一保证 —— auth:tokens-refreshed 走 setUser(user) →
    // switchOwner(同 id) 早退（不清内存、不重新 hydrate），否则每刷新一次 token 都会把
    // 内存标签栏清成空再从 localStorage 重填（表现为用户可见的标签栏闪空）。
    // 该早退此前无 spec 断言，删掉 switchOwner 首行 `if (userId === ownerId) return`
    // 仍然全绿。
    it('同 user 的 token 刷新不清空 tagsView（switchOwner 同 owner 早退）', () => {
      const auth = useAuthStore();
      const tags = useTagsViewStore();
      tags.switchOwner('u1');
      tags.addView({
        path: '/parts',
        fullPath: '/parts?status=active',
        name: 'Parts',
        title: '零件',
      });
      expect(tags.visitedViews.map((v) => v.path)).toEqual(['/parts']);

      // 同 user（makeUser() 默认 id = 'u1'）的 token 刷新事件
      window.dispatchEvent(
        new CustomEvent('auth:tokens-refreshed', {
          detail: { token: 'tok-after-refresh', refresh_token: 'r', user: makeUser() },
        }),
      );

      expect(auth.token).toBe('tok-after-refresh');
      // 关键断言：标签栏没被 hydrate 成空
      expect(tags.visitedViews.map((v) => v.path)).toEqual(['/parts']);
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
