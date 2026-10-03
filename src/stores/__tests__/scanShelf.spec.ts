// src/stores/__tests__/scanShelf.spec.ts
//
// 2026-10-04 新增：useScanShelfStore（报工台「当前作业架」Pinia store）单测。
//
// 为什么必须有这个文件（2026-10-04）：原实现是
// views/scan/composables/useActiveShelfSelection.ts —— ref 写在函数体内，**每次调用
// 都返回全新实例**。/scan/action 与 /scan/pick 是兄弟路由，`router.push` 卸载前者
// 即销毁其实例，于是取件页读到的作业架恒为 null、守卫 100% 触发、请求根本没发出；
// 旧形态下仓内零测试覆盖它，所以这个 bug 能一直活着。改成 store 后跨路由存活，
// 但「三个分支各自的判定」+ 换账号 / 部分缺页这些边界仍需要钉死，故补这份用例。
//
// 覆盖：
//   - 单架：自动选唯一架并落 sessionStorage（当前唯一的 sessionStorage 写入点）
//   - 多架：从 sessionStorage 读回；存储值必须仍在**本次候选集**内（越界的被丢弃 →
//     不自动选，这是「不让已解绑 / 未解析出的旧选择静默落到别的架上」的唯一防线）
//   - wildcard（未绑任何架）：候选空 + 不选 + 不打 listShelves
//   - 幂等：同账号重复 initShelves 不重打 listShelves；换账号强制重载（不继承旧账号选择）
//   - await 期间换账号：本次结果作废，不拿旧账号的绑定集去 markLoaded
//   - selectedShelfId 只读（页面上没有选架入口 ⇒ 没有写入方）
//   - listShelves 失败时按绑定 id 兜底候选
//
// 测试基础设施：
//   - 每个用例重建 Pinia + VueQueryPlugin 并传 QueryClient —— store setup 里会
//     `useAuthStore()`，而 auth store 在 setup **第一行**调 `useQueryClient()`
//     （Pinia 只给 setup 注入上下文；见 CLAUDE.md 与 auth.spec.ts 的同款说明）。
//   - 登录态靠**预置 localStorage `auth_session`** 建立：auth store 在首次
//     useAuthStore() 时自执行 loadFromStorage()，不必去碰 store 私有写点。
//     换账号走 `auth:tokens-refreshed` 事件（与生产代码同一路径）。
//   - listShelves 整函数桩掉，不让真实 axios 进用例。本 store 不弹 ElMessage，
//     故无需 element-plus 桩（node env 下真实 ElMessage 会因 document 未定义污染输出）。
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(),
}));

import { listShelves } from '@/api/shelves';
import { useScanShelfStore } from '../scanShelf';
import type { CurrentUser } from '@/types/user';
import type { Shelf, ShelfListResult } from '@/types/shelf';

const SESSION_KEY_PREFIX = 'active_shelf_selection:';

function makeUser(userId: string, shelfIds: string[]): CurrentUser {
  return {
    id: userId,
    username: `hmi-${userId}`,
    full_name: `工位 ${userId}`,
    is_active: true,
    roles: ['SHELF_ACCOUNT'],
    shelf_ids: shelfIds,
    menus: [],
  };
}

/** 预置登录态（必须在 setActivePinia 之前写：auth store 首次创建时读它）。 */
function seedSession(user: CurrentUser): void {
  localStorage.setItem(
    'auth_session',
    JSON.stringify({ token: `tok-${user.id}`, refresh_token: null, user }),
  );
}

/** 切账号：走生产代码同款路径（拦截器刷新成功后 dispatch 的事件 → store setUser）。 */
function switchSession(user: CurrentUser): void {
  window.dispatchEvent(
    new CustomEvent('auth:tokens-refreshed', {
      detail: { token: `tok-${user.id}`, refresh_token: null, user },
    }),
  );
}

/** listShelves 的桩响应：只保留消费侧真读的字段。 */
function mockShelves(rows: Array<Pick<Shelf, 'id' | 'code' | 'zone'>>): void {
  vi.mocked(listShelves).mockResolvedValue({
    items: rows.map((r) => ({
      version: 1,
      name: r.code,
      location: null,
      is_active: true,
      display_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...r,
    })),
    total: rows.length,
    limit: 200,
    offset: 0,
  });
}

describe('useScanShelfStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.mocked(listShelves).mockReset();
  });

  /** 装好 pinia + query plugin，并把登录态注入 localStorage。 */
  function bootstrap(user: CurrentUser): void {
    seedSession(user);
    const app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, {
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: 0 } } }),
    });
    setActivePinia(app.config.globalProperties.$pinia);
  }

  it('T1：单架自动选，并把 id 落进 per-user sessionStorage', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    mockShelves([{ id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' }]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(scanShelf.selectedShelfId).toBe('8800000000001');
    expect(scanShelf.selectedZone).toBe('PRODUCTION');
    expect(scanShelf.options).toHaveLength(1);
    // 选架要跨路由记忆：不落盘则每次进页面都要工人重选
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000001');
    // 单架不需要选择器
    expect(scanShelf.showShelfSelector).toBe(false);
  });

  it('T2：多架从 sessionStorage 读回，且必须仍在候选集内', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    sessionStorage.setItem(`${SESSION_KEY_PREFIX}u1`, '8800000000002');

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(scanShelf.options.map((o) => o.id)).toEqual(['8800000000001', '8800000000002']);
    expect(scanShelf.selectedShelfId).toBe('8800000000002');
    expect(scanShelf.showShelfSelector).toBe(false);

    // 存储值指向已解绑的架：必须丢弃并回到「未选」，不能静默拿它当作业架
    sessionStorage.setItem(`${SESSION_KEY_PREFIX}u1`, '8800000000999');
    await scanShelf.initShelves({ force: true });

    expect(scanShelf.selectedShelfId).toBeNull();
    expect(scanShelf.showShelfSelector).toBe(true);
  });

  it('T3：wildcard（未绑任何架）候选为空且不选', async () => {
    bootstrap(makeUser('u1', []));

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(scanShelf.options).toEqual([]);
    expect(scanShelf.selectedShelfId).toBeNull();
    expect(scanShelf.selectedZone).toBeNull();
    expect(scanShelf.showShelfSelector).toBe(false);
    // 没有候选就没得可拉，不该为了显示选择器去打货架端点
    expect(listShelves).not.toHaveBeenCalled();
  });

  it('T4：同账号重复 initShelves 幂等；换账号强制重载且不继承旧账号的选择', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    mockShelves([{ id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' }]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(1);
    expect(scanShelf.initialized).toBe(true);

    // 换账号：Pinia store 跨「登出 → 换账号登录（不刷新页面）」存活，
    // 旧账号的选择不得被新账号继承（sessionStorage 的 per-user key 也拦一道）。
    switchSession(makeUser('u2', ['8800000000009']));
    mockShelves([{ id: '8800000000009', code: 'SH-P09', zone: 'PRODUCTION' }]);

    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(2);
    expect(scanShelf.selectedShelfId).toBe('8800000000009');
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u2`)).toBe('8800000000009');
    // 旧账号的持久化条目不被动过（登出不清盘，只是不再被读）
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000001');
  });

  it('T5：多架不自动选、也不写 sessionStorage；selectedShelfId 是只读的', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-I02', zone: 'INSPECTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    // 多架 + 没有选架入口 ⇒ 系统不选、也不落盘（没有写入方）
    expect(scanShelf.selectedShelfId).toBeNull();
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBeNull();

    // 只读：没有 setSelected / reset 这类写入口（2026-10-04 删除，两者在删除时都无
    // 生产调用方）。这里用赋值断言「写了不生效」，钉住「别再把写路径加回来」。
    (scanShelf as { selectedShelfId: string | null }).selectedShelfId = '8800000000002';

    expect(scanShelf.selectedShelfId).toBeNull();
    expect(scanShelf.selectedZone).toBeNull();
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBeNull();
  });

  it('T6：listShelves 失败时按绑定 id 兜底候选（zone 猜 PRODUCTION）', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    vi.mocked(listShelves).mockRejectedValue(new Error('boom'));

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    // 兜底的目的是「不让一次货架端点抖动把整个扫码台废掉」：仍给出唯一候选并自动选中
    expect(scanShelf.options).toEqual([
      { id: '8800000000001', code: 'shelf#8800000000001', zone: 'PRODUCTION' },
    ]);
    expect(scanShelf.selectedShelfId).toBe('8800000000001');
  });

  it('T7：存储值在绑定集内、但货架端点没返到它 → 不选（判候选集而非绑定集）', async () => {
    // 账号绑 3 架、货架端点只返回 2 架 —— `limit: 200` 「取全」假设不成立时的形态。
    // 要落进多架分支必须 details ≥ 2，故用 3 架绑定、缺 1 架。
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002', '8800000000003']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    sessionStorage.setItem(`${SESSION_KEY_PREFIX}u1`, '8800000000003');

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(scanShelf.options.map((o) => o.id)).toEqual(['8800000000001', '8800000000002']);
    // 选 3 号会得到「selectedShelfId 有值、selectedZone 为 null」的坏状态，守卫文案也会
    // 误报成因 ⇒ 必须落到「未选」。
    expect(scanShelf.selectedShelfId).toBeNull();
    expect(scanShelf.selectedZone).toBeNull();
  });

  it('T8：await listShelves 期间换账号 → 本次结果作废，不按旧账号 markLoaded', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    // 手动控制 listShelves 的落地时刻，好把「请求在飞」和「换账号」排出先后
    let release: (v: ShelfListResult) => void = () => {};
    vi.mocked(listShelves).mockReturnValue(
      new Promise<ShelfListResult>((resolve) => {
        release = resolve;
      }),
    );

    const scanShelf = useScanShelfStore();
    const pending = scanShelf.initShelves();

    // 请求在飞时换成 u2
    switchSession(makeUser('u2', ['8800000000009']));
    release({
      items: [
        {
          id: '8800000000001',
          code: 'SH-P01',
          name: 'SH-P01',
          version: 1,
          location: null,
          is_active: true,
          display_order: 0,
          zone: 'PRODUCTION',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    });
    await pending;

    // u1 的候选不得落到 options 上，也不得把「已加载」记在 u1 名下（否则 u2 的 init
    // 会被幂等闸门挡掉、永远拿不到自己的候选）。
    expect(scanShelf.options).toEqual([]);
    expect(scanShelf.initialized).toBe(false);

    mockShelves([{ id: '8800000000009', code: 'SH-P09', zone: 'PRODUCTION' }]);
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(2);
    expect(scanShelf.selectedShelfId).toBe('8800000000009');
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u2`)).toBe('8800000000009');
  });
});
