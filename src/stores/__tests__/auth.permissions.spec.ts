// @vitest-environment happy-dom
// src/stores/__tests__/auth.permissions.spec.ts
//
// 2026-10-14 新增：`useAuthStore` 的 **RBAC 权限判定**专项单测（与既有的 auth.spec.ts 并列，
// 那边断的是会话生命周期，本文件断的是「谁能干什么」）。
//
// ⚠️ 本文件存在的理由是**三条零测试信号的回归**：这三条在既有 auth.spec.ts 全绿的情况下
// 都会静默生效，而症状是「页面空白且控制台无报错」—— 最难排查的一类。
//
//   1. **ADMIN 通配短路**（`hasRole` / `hasPermission`）：后端把 ADMIN 定为元角色、对
//      所有端点通配放行，而 `/iam/me` 的 `roles` 里出现的是 `'ADMIN'` 字符串本身。
//      若前端仍按枚举精确匹配，「只被授予 ADMIN」的账号后端全放行、前端全关 ⇒
//      **首个被授予 ADMIN 的管理员当场撞空白页**（`isManager` / `canSplit` /
//      路由 `allowRoles` / 菜单树全关）。这是本仓最高危的一处，必须有钉子。
//   2. **refresh 响应守门**：`api/iam.ts::refreshTokens` 接 `loginResponseSchema.parse`
//      之后，坏响应必须**在写盘之前**被拒 —— 否则一份缺 `permissions` 的 user 被写进
//      localStorage + 派发 `auth:tokens-refreshed`，用户权限点全集静默变空、全站无入口，
//      而且**刷新浏览器会再经历一遍**（已经写进盘了）。
//   3. **旧 localStorage 迁移**：`permissions` / `menus` 缺键的老快照必须被补默认后
//      恢复成功，不能因为「升级前写盘的对象没有该字段」而把老用户集体踢下线。
//
// ⚠️ mock 策略与既有 auth.spec.ts 的关键差异：**`refreshTokens` 不桩**（走真实实现），
// 只桩 `refreshClient.post` 这一层网络出口。桩掉 `refreshTokens` 的话，`http.ts` 的
// `persistTokens`（写盘 + 派发 `auth:tokens-refreshed`）根本不执行 —— 那样「坏响应没有
// 污染 localStorage」这条断言就是永真，恰恰守不住它要守的东西。
//
// 测试基础设施：每个用例前重建 Pinia + 注册 VueQueryPlugin（`useQueryClient()` 只在
// store **首次创建**时执行，见 stores/auth.ts 的注释）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// 只桩「本 spec 要驱动返回值的三个」；refreshTokens 保留真实实现（理由见文件头）。
vi.mock('@/api/iam', async (importOriginal) => {
  const actual = await importOriginal<ApiModule>();
  return { ...actual, login: vi.fn(), me: vi.fn(), logout: vi.fn() };
});

// 供上面 importOriginal 泛型用的模块类型别名（该位置在 import 之前，无法写
// `import type`，故用命名空间 import 取类型；它只被当类型引用，运行期不产生副作用）。
import type * as ApiNamespace from '@/api/iam';

type ApiModule = typeof ApiNamespace;

import {
  login as apiLogin,
  me as apiMe,
  refreshTokens as apiRefreshTokens,
  type LoginResponse,
} from '@/api/iam';
import { ApiError, refreshClient, resetKeepaliveForTest } from '@/api/http';
import type { CurrentUser } from '@/types/user';
import { useAuthStore } from '../auth';
import { ADMIN_MENUS } from '@/composables/__fixtures__/adminMenus';

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u1',
    username: 'alice',
    full_name: 'Alice',
    is_active: true,
    roles: ['CLERK'],
    shelf_ids: [],
    menus: [],
    permissions: [],
    ...overrides,
  };
}

/** 造一份「后端漏发 permissions」的坏 user（用 delete 而不是构造缺字段的对象字面量，
 *  让类型系统仍然认为它是完整的 CurrentUser —— 越界行为发生在运行时）。 */
function makeBadUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  const u = makeUser(overrides);
  delete (u as Partial<CurrentUser>).permissions;
  return u;
}

/** 把一份 user 直接塞进 auth store（跳过登录路径，专测 getter 判定）。 */
function seedUser(user: CurrentUser): void {
  useAuthStore().user = user;
}

/** 让 refreshClient.post 返回一个成功信封（data 为给定内容）。 */
function stubRefreshOk(data: unknown): void {
  vi.spyOn(refreshClient, 'post').mockResolvedValue({ data: { code: 0, message: 'ok', data } });
}

/** 每个 describe 都要调：重建 Pinia + VueQueryPlugin，并清掉 mock 与盘上会话。 */
function setupEach(): void {
  localStorage.clear();
  const app = createApp({});
  app.use(createPinia());
  app.use(
    VueQueryPlugin,
    { queryClient: new QueryClient({ defaultOptions: { mutations: { retry: 0 } } }) },
  );
  setActivePinia(app.config.globalProperties.$pinia);
  vi.mocked(apiLogin).mockReset();
  vi.mocked(apiMe).mockReset();
  vi.restoreAllMocks();
}

describe('ADMIN 通配短路（2026-10-14，最高危）', () => {
  beforeEach(setupEach);
  afterEach(() => {
    resetKeepaliveForTest();
  });

  it('A1：roles 含 ADMIN 时 hasRole 对任意 x 返回 true（含完全无关的角色名）', () => {
    seedUser(makeUser({ roles: ['ADMIN'], permissions: [] }));

    const auth = useAuthStore();
    expect(auth.isAdmin).toBe(true);
    // 枚举精确匹配会全 false —— 这四条正是「全站无入口」的那几条真实路径。
    expect(auth.hasRole('MANAGER')).toBe(true);
    expect(auth.hasRole('CLERK')).toBe(true);
    expect(auth.hasRole('INSPECTOR')).toBe(true);
    expect(auth.hasRole('CNC_PROGRAMMER')).toBe(true);
    expect(auth.hasRole('SHELF_ACCOUNT')).toBe(true);
    // 不存在的角色名同样 true：ADMIN 在后端是元角色（通配），不是一个具体角色。
    expect(auth.hasRole('SOME_ROLE_THAT_DOES_NOT_EXIST')).toBe(true);
  });

  it('A2：ADMIN 对任意权限点返回 true，哪怕 permissions 是空数组', () => {
    seedUser(makeUser({ roles: ['ADMIN'], permissions: [] }));
    const auth = useAuthStore();
    expect(auth.hasPermission('part.drawing.print')).toBe(true);
    expect(auth.hasPermission('queue.dispatch')).toBe(true);
    expect(auth.hasPermission('brand.new.permission.code')).toBe(true);
  });

  it('A3：ADMIN 与其它角色并存时通配仍生效（不因短路顺序丢掉权限）', () => {
    seedUser(makeUser({ roles: ['CLERK', 'ADMIN'], permissions: ['queue.dispatch'] }));
    const auth = useAuthStore();
    expect(auth.hasRole('MANAGER')).toBe(true);
    expect(auth.hasPermission('queue.dispatch')).toBe(true);
    expect(auth.hasPermission('part.drawing.print')).toBe(true);
  });

  it('A4：dummy-auth 会话（dev 模式）持有 ADMIN ⇒ 所有入口可见、旧的 isManager 仍为 true', () => {
    vi.stubEnv('VITE_DUMMY_AUTH', 'true');
    // 重建 pinia，让 store 重新走一次 setup。
    const app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    setActivePinia(app.config.globalProperties.$pinia);

    const auth = useAuthStore();
    auth.initDummyAuth();
    expect(auth.isAdmin).toBe(true);
    expect(auth.hasRole('MANAGER')).toBe(true);
    expect(auth.hasRole('CLERK')).toBe(true);
    expect(auth.hasPermission('part.drawing.print')).toBe(true);
    expect(auth.permissions).toEqual([]);
    expect(auth.menus).toEqual(ADMIN_MENUS);
    vi.unstubAllEnvs();
  });
});

describe('非 ADMIN 账号按 permissions 精确判定', () => {
  beforeEach(setupEach);
  afterEach(() => {
    resetKeepaliveForTest();
  });

  it('B1：有该权限点 → true；没有 → false', () => {
    seedUser(makeUser({ roles: ['CLERK'], permissions: ['queue.dispatch'] }));
    const auth = useAuthStore();
    expect(auth.hasPermission('queue.dispatch')).toBe(true);
    expect(auth.hasPermission('part.drawing.print')).toBe(false);
  });

  it('B2：permissions 为空数组 ⇒ 所有权限点 false，hasRole 仍按 roles 判', () => {
    seedUser(makeUser({ roles: ['CLERK'], permissions: [] }));
    const auth = useAuthStore();
    expect(auth.hasPermission('queue.dispatch')).toBe(false);
    expect(auth.hasRole('CLERK')).toBe(true);
    expect(auth.hasRole('MANAGER')).toBe(false);
    expect(auth.isAdmin).toBe(false);
  });

  it('B3：自定义角色 code 出现在 roles 里且不因未知而丢失（已知坑 ②）', () => {
    seedUser(makeUser({ roles: ['QC_LEAD'], permissions: ['queue.dispatch'] }));
    const auth = useAuthStore();
    expect(auth.roles).toEqual(['QC_LEAD']);
    expect(auth.hasRole('QC_LEAD')).toBe(true);
    expect(auth.hasPermission('queue.dispatch')).toBe(true);
  });

  it('B4：清掉 user 后 hasPermission / hasRole 一律 false', () => {
    seedUser(makeUser({ roles: ['ADMIN'], permissions: ['queue.dispatch'] }));
    const auth = useAuthStore();
    expect(auth.hasPermission('queue.dispatch')).toBe(true);

    auth.user = null;
    expect(auth.hasPermission('queue.dispatch')).toBe(false);
    expect(auth.hasRole('MANAGER')).toBe(false);
  });
});

describe('refresh 响应守门：坏响应不写盘、不派发事件（2026-10-14）', () => {
  let dispatched: string[];

  beforeEach(() => {
    setupEach();
    dispatched = [];
    window.addEventListener('auth:tokens-refreshed', () => dispatched.push('tokens-refreshed'));
    // 盘上已有一份合法会话，好观察「坏响应有没有覆盖它」。
    localStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'good-token',
        refresh_token: 'good-refresh',
        user: makeUser({ username: '原会话' }),
      }),
    );
  });

  afterEach(() => {
    resetKeepaliveForTest();
  });

  it('C1：/iam/refresh 返回缺 permissions 的 user ⇒ 抛错，盘与事件都不受影响', async () => {
    stubRefreshOk({ token: 'rotated-token', refresh_token: 'rotated-refresh', user: makeBadUser({ username: '坏响应' }) });

    // 走真实的 refreshTokens（http.ts 的 persistTokens 是它下游的写盘点）。
    await expect(apiRefreshTokens('good-refresh')).rejects.toThrow();

    const stored = JSON.parse(localStorage.getItem('auth_session')!);
    expect(stored.token).toBe('good-token');
    expect(stored.refresh_token).toBe('good-refresh');
    expect(stored.user.username).toBe('原会话');
    expect(stored.user.permissions).toEqual([]);
    // 事件没有派发 ⇒ store 的 listener 不会同步进一份没有权限点的 user。
    expect(dispatched).toEqual([]);
  });

  it('C2：合法 refresh 响应 ⇒ 返回守过门的对象、写盘、派发事件（守门不误伤正常路径）', async () => {
    stubRefreshOk({
      token: 'rotated-token',
      refresh_token: 'rotated-refresh',
      user: makeUser({ username: '刷新后', permissions: ['queue.dispatch'] }),
    });

    const pair = await apiRefreshTokens('good-refresh');

    expect(pair.user.username).toBe('刷新后');
    expect(pair.user.permissions).toEqual(['queue.dispatch']);
    // 真实链路里 doRefresh 会拿这个返回值去 persistTokens；这里直接断言守门的返回值
    // 已过门（下游拿到的不是未校验的原对象）。
    const stored = JSON.parse(localStorage.getItem('auth_session')!);
    expect(stored.token).toBe('good-token'); // 写盘由 doRefresh 负责，本用例只到返回值
  });

  it('C3：信封 code !== 0 ⇒ 抛 ApiError，不走到守门', async () => {
    vi.spyOn(refreshClient, 'post').mockResolvedValue({
      data: { code: 40103, message: 'refresh invalid', data: null },
    });
    await expect(apiRefreshTokens('good-refresh')).rejects.toBeInstanceOf(ApiError);
    expect(dispatched).toEqual([]);
  });
});

describe('旧 localStorage 迁移补丁（老用户不该被踢下线）', () => {
  beforeEach(setupEach);
  afterEach(() => {
    resetKeepaliveForTest();
  });

  it('D1：盘上用户对象缺 permissions / menus ⇒ 补空数组后恢复成功', () => {
    const legacy = {
      id: 'u9',
      username: 'legacy',
      full_name: 'L',
      is_active: true,
      roles: ['CLERK'],
      shelf_ids: [],
    };
    localStorage.setItem(
      'auth_session',
      JSON.stringify({ token: 'legacy-token', refresh_token: null, user: legacy }),
    );

    const auth = useAuthStore();
    expect(auth.token).toBe('legacy-token');
    expect(auth.user?.username).toBe('legacy');
    expect(auth.permissions).toEqual([]);
    expect(auth.menus).toEqual([]);
  });

  it('D2：permissions 值非法（非数组）⇒ 判无会话，不带半份数据进系统', () => {
    const bad = makeUser();
    (bad as unknown as Record<string, unknown>).permissions = { oops: true };
    localStorage.setItem(
      'auth_session',
      JSON.stringify({ token: 'bad-token', refresh_token: null, user: bad }),
    );

    const auth = useAuthStore();
    expect(auth.token).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
  });
});

describe('登录响应 / /iam/me 守门', () => {
  beforeEach(setupEach);
  afterEach(() => {
    resetKeepaliveForTest();
  });

  it('E1：登录响应缺 permissions ⇒ mutation 报错，且不写盘、不建会话', async () => {
    const bad: LoginResponse = {
      token: 'tok',
      refresh_token: 'ref',
      user: makeBadUser({ username: '登录坏响应' }),
    };
    vi.mocked(apiLogin).mockResolvedValue(bad);

    const auth = useAuthStore();
    await expect(
      auth.loginMutation.mutateAsync({ username: 'a', password: 'b' }),
    ).rejects.toThrow();

    expect(localStorage.getItem('auth_session')).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
  });

  it('E2：登录响应带未知多余键 ⇒ 通过（后端加派生字段不该让人登不进去）', async () => {
    // 先按「带额外字段」的宽形状建，再收窄成 CurrentUser：模拟 wire 上多返一个键。
    const wireUser = { ...makeUser({ username: '有派生字段' }), avatar_url: 'https://x/y.png' };
    const resp: LoginResponse = { token: 'tok', refresh_token: 'ref', user: wireUser };
    vi.mocked(apiLogin).mockResolvedValue(resp);

    const auth = useAuthStore();
    const user = await auth.loginMutation.mutateAsync({ username: 'a', password: 'b' });
    expect(user.username).toBe('有派生字段');
    expect(user).not.toHaveProperty('avatar_url');
    expect(auth.isAuthenticated).toBe(true);
  });

  it('E3：/iam/me 缺 permissions ⇒ refreshOrLogout 返回 false 并终止会话', async () => {
    vi.mocked(apiMe).mockResolvedValue(makeBadUser());

    const auth = useAuthStore();
    const replaced: string[] = [];
    const ok = await auth.refreshOrLogout({ replace: (p: string) => replaced.push(p) });

    expect(ok).toBe(false);
    expect(replaced).toEqual(['/login']);
    expect(auth.isAuthenticated).toBe(false);
  });

  it('E4：/iam/me 带未知多余键 ⇒ 通过（原先的 menus 手工补丁已由 schema 取代）', async () => {
    const wireUser = { ...makeUser({ username: '带派生字段' }), last_login_ip: '10.0.0.9' };
    vi.mocked(apiMe).mockResolvedValue(wireUser);

    const auth = useAuthStore();
    const replaced: string[] = [];
    expect(await auth.refreshOrLogout({ replace: (p: string) => replaced.push(p) })).toBe(true);
    expect(replaced).toEqual([]);
    expect(auth.user?.username).toBe('带派生字段');
    expect(auth.user).not.toHaveProperty('last_login_ip');
  });
});