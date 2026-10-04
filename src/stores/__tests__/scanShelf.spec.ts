// src/stores/__tests__/scanShelf.spec.ts
//
// 2026-10-04 新增：useScanShelfStore（报工台「当前作业架」Pinia store）单测。
//
// 为什么必须有这个文件（2026-10-04）：原实现是
// views/scan/composables/useActiveShelfSelection.ts —— ref 写在函数体内，**每次调用
// 都返回全新实例**。/scan/action 与送检页是兄弟路由，`router.push` 卸载前者即销毁
// 其实例，于是送检页读到的作业架恒为 null、守卫 100% 触发、请求根本没发出；旧形态下
// 仓内零测试覆盖它，所以这个 bug 能一直活着。改成 store 后跨路由存活，但「三个分支
// 各自的判定」+ 换账号 / 部分缺页这些边界仍需要钉死，故补这份用例。
//
// 覆盖：
//   - 单架：自动选唯一架并落 sessionStorage
//   - 多架：从 sessionStorage 读回；存储值必须仍在**本次候选集**内（越界的被丢弃 →
//     不选，这是「不让已解绑 / 未解析出的旧选择静默落到别的架上」的唯一防线）
//   - 多架无可用存储值：**不自动选**，等工人经 /scan/action 的选架入口显式选
//   - `selectShelf`：合法 id 写入并落盘；越界 id 返回 false 且不写任何状态
//   - wildcard（未绑任何架）：候选空 + 不选 + 不打 listShelves
//   - 幂等：同账号 + 同绑定集重复 initShelves 不重打 listShelves；换账号、**以及同账号
//     换绑定**（管理员改绑定，user.id 不变）都强制重载
//   - await 期间换账号：本次结果作废，不拿旧账号的绑定集去 markLoaded
//   - listShelves 失败时按绑定 id 兜底候选，但 zone 留 UNKNOWN 不猜
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
    // 恢复 T12 之类用例挂的 Date.now 探针；`vi.mock` 的模块桩不受影响
    vi.restoreAllMocks();
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

  // 2026-10-04 重写：选架写入口从「不存在」变成 `selectShelf`（`/scan/action` 顶部的
  // 选架 UI 调它）。暴露面因此多一个 action，且**必须**只有这一个写入口 —— 多一个就
  // 可能绕过 `id ∈ options` 校验，把已解绑 / 未解析出的架静默写成作业架。
  it('T5：多架且无存储值 → 不自动选、也不写 sessionStorage；暴露面只有 selectShelf 一个写入口', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-I02', zone: 'INSPECTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    // 系统判不出工人站在哪一架上 ⇒ 不替他猜，等他自己选
    expect(scanShelf.selectedShelfId).toBeNull();
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBeNull();
    // 选架入口的判定依据：多架 + 未选 ⇒ /scan/action 顶部渲染警示态 +「选择货架」
    expect(scanShelf.showShelfSelector).toBe(true);

    // 钉暴露面本身（滤掉 pinia 内建的 `$xxx` 与 dev 态的 `_xxx`）：`selectShelf` 是唯一
    // 的选架写入口，`selectedShelfId` / `options` / `selectedZone` 都得是只读的。
    // 将来若再加第二个写入口（比如「按 code 选架」的便利 action），这里必被拦下。
    expect(
      Object.keys(scanShelf)
        .filter((k) => !/^[$_]/.test(k))
        .sort(),
    ).toEqual([
      'initShelves',
      'initialized',
      'options',
      'selectShelf',
      'selectedShelfId',
      'selectedZone',
      'showShelfSelector',
    ]);

    expect(scanShelf.selectedShelfId).toBeNull();
    expect(scanShelf.selectedZone).toBeNull();
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBeNull();
  });

  it('T6：listShelves 失败时按绑定 id 兜底候选，但 zone 不猜（UNKNOWN）', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    vi.mocked(listShelves).mockRejectedValue(new Error('boom'));

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    // 兜底如实描述这一批候选的处境：仍给出唯一候选并自动选中，但 zone 无从得知 ⇒
    // UNKNOWN ⇒ selectedZone 为 null ⇒ 守卫的「无法识别所属区域」分支拦下，工人提交不出去。
    // 猜 PRODUCTION 会让品检架被当成生产架放行，最后落到后端 20501。
    // ⚠️ 兜底**换不来可用性**：这批候选不可用，恢复手段只有「端点好了之后再进一次页面」
    // （见 T12），不是这次兜底本身。
    expect(scanShelf.options).toEqual([
      { id: '8800000000001', code: 'shelf#8800000000001', zone: 'UNKNOWN' },
    ]);
    expect(scanShelf.selectedShelfId).toBe('8800000000001');
    expect(scanShelf.selectedZone).toBeNull();
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

  it('T9：selectShelf 合法 id → 写入 + 落盘，且「已选」后退出选架态', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    expect(scanShelf.showShelfSelector).toBe(true);

    expect(scanShelf.selectShelf('8800000000002')).toBe(true);

    expect(scanShelf.selectedShelfId).toBe('8800000000002');
    expect(scanShelf.selectedZone).toBe('PRODUCTION');
    // 选完架就不再需要选架入口（否则 /scan/action 会一直把工人当「没选好」）
    expect(scanShelf.showShelfSelector).toBe(false);
    // 跨路由记忆：送检页不经过选架 UI，没有它就要重新选一次
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000002');
  });

  it('T9b：selectShelf 越界 id → 返回 false，且不写状态、不落盘（不静默把坏值当作业架）', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    scanShelf.selectShelf('8800000000001');

    // 已解绑的架 / listShelves 没返到的架 / 纯捏造的 id，三种都越界
    expect(scanShelf.selectShelf('8800000000999')).toBe(false);
    expect(scanShelf.selectShelf('')).toBe(false);

    // 写进去的坏状态是「selectedShelfId 有值但 selectedZone 为 null」：既发不出请求、
    // 守卫文案也会说错成因 ⇒ 越界必须一个字段都不碰
    expect(scanShelf.selectedShelfId).toBe('8800000000001');
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000001');
  });

  it('T9c：selectShelf 在候选集为空（wildcard）时一律返回 false', async () => {
    bootstrap(makeUser('u1', []));

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(scanShelf.selectShelf('8800000000001')).toBe(false);
    expect(scanShelf.selectedShelfId).toBeNull();
  });

  it('T10：选架跨账号隔离 —— A 账号选的架不落到 B 账号名下', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    scanShelf.selectShelf('8800000000002');
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000002');

    // 换账号：Pinia store 跨「登出 → 换账号登录（不刷新页面）」存活
    switchSession(makeUser('u2', ['8800000000001', '8800000000002']));
    await scanShelf.initShelves();

    // B 账号的候选里也有这两架，sessionStorage 也确实按 user id 分了 key
    expect(scanShelf.selectedShelfId).toBeNull();
    expect(scanShelf.showShelfSelector).toBe(true);
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u2`)).toBeNull();
    // A 账号的条目不被动过（登出不清盘，只是不再被读）
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000002');

    // B 自己选一次，只写自己的 key
    expect(scanShelf.selectShelf('8800000000001')).toBe(true);
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u2`)).toBe('8800000000001');
    expect(sessionStorage.getItem(`${SESSION_KEY_PREFIX}u1`)).toBe('8800000000002');
  });

  it('T10b：sessionStorage 往返 —— 上次会话选过的架在本次 initShelves 后被恢复', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    scanShelf.selectShelf('8800000000002');

    // 模拟「工人离开一体机、浏览器关掉又开」：store 全新、只剩 sessionStorage 里的值
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    const fresh = useScanShelfStore();
    await fresh.initShelves();

    expect(fresh.selectedShelfId).toBe('8800000000002');
    expect(fresh.showShelfSelector).toBe(false);
  });

  it('T11：同账号换绑定（管理员改绑定，user.id 不变）→ 指纹变化即重载', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    mockShelves([{ id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' }]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    expect(scanShelf.selectedShelfId).toBe('8800000000001');
    expect(listShelves).toHaveBeenCalledTimes(1);

    // 加了第二架：user.id 没变，只比 id 的闸门会把单架候选挡在门外
    switchSession(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(2);
    expect(scanShelf.options).toHaveLength(2);

    // 只换了绑定顺序（内容没变）⇒ 不重打货架端点
    switchSession(makeUser('u1', ['8800000000002', '8800000000001']));
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(2);

    // 解绑到只剩另一架：旧候选会让提交打到已解绑的架上，必须重载
    switchSession(makeUser('u1', ['8800000000002']));
    mockShelves([{ id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' }]);
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(3);
    expect(scanShelf.options.map((o) => o.id)).toEqual(['8800000000002']);
    expect(scanShelf.selectedShelfId).toBe('8800000000002');
  });

  it('T12：兜底不置幂等闸门 —— 冷却窗内不重打端点，窗外再进一次路由自动自愈', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    // 冷却窗用真实 Date.now 算，手拨时钟而不是等 10s
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    vi.mocked(listShelves).mockRejectedValue(new Error('boom'));
    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    // 兜底的候选不可用（zone 猜不出来），而且**不能**当成「已加载」把该账号钉死
    expect(scanShelf.selectedZone).toBeNull();
    expect(scanShelf.initialized).toBe(false);

    // 冷却窗内再进一次路由（取件 ⇄ 送检切页）：不重打货架端点，也不清掉这批候选
    await scanShelf.initShelves();
    expect(listShelves).toHaveBeenCalledTimes(1);
    expect(scanShelf.selectedZone).toBeNull();

    // 端点恢复 + 窗外：再进一次路由自动重试并自愈，不靠 F5
    now += 11_000;
    mockShelves([{ id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' }]);
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(2);
    expect(scanShelf.selectedZone).toBe('PRODUCTION');
    expect(scanShelf.initialized).toBe(true);

    // 自愈之后幂等闸门重新生效
    await scanShelf.initShelves();
    expect(listShelves).toHaveBeenCalledTimes(2);
  });

  it('T12b：兜底后强制重载（force）立刻重打端点，不等冷却窗', async () => {
    bootstrap(makeUser('u1', ['8800000000001']));
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    vi.mocked(listShelves).mockRejectedValue(new Error('boom'));
    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();

    // 时钟没动（仍在冷却窗内），但 force 显式表达了「现在就重来」
    mockShelves([{ id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' }]);
    await scanShelf.initShelves({ force: true });

    expect(listShelves).toHaveBeenCalledTimes(2);
    expect(scanShelf.selectedZone).toBe('PRODUCTION');
  });

  // 2026-10-04：旧的「noticeShown 只在候选集真换了的时候复位」一条随
  // `noticeShown` / `markNoticeShown` 一起删掉（选架入口已有，守卫不再有 warning 分支，
  // 提示去重的那套状态没有消费方了）。本条守住它删掉之后仍然成立的一半：**选架不参与
  // 幂等闸门** —— 被闸门挡掉的重入不得清掉已选中的架，否则工人切一次页面就被重置。
  it('T13：幂等闸门挡掉的重入不清掉已选中的作业架', async () => {
    bootstrap(makeUser('u1', ['8800000000001', '8800000000002']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
    ]);

    const scanShelf = useScanShelfStore();
    await scanShelf.initShelves();
    scanShelf.selectShelf('8800000000002');

    // 送检页 / 操作选择页各自 onBeforeMount 调一次 initShelves，第二次被闸门挡掉
    await scanShelf.initShelves();
    expect(listShelves).toHaveBeenCalledTimes(1);
    expect(scanShelf.selectedShelfId).toBe('8800000000002');

    // 换绑定是真的重载（指纹变了）⇒ 此时按新候选重新判定
    switchSession(makeUser('u1', ['8800000000001', '8800000000002', '8800000000003']));
    mockShelves([
      { id: '8800000000001', code: 'SH-P01', zone: 'PRODUCTION' },
      { id: '8800000000002', code: 'SH-P02', zone: 'PRODUCTION' },
      { id: '8800000000003', code: 'SH-P03', zone: 'PRODUCTION' },
    ]);
    await scanShelf.initShelves();

    expect(listShelves).toHaveBeenCalledTimes(2);
    // 2 号架仍在候选集内 ⇒ 沿用原选择，不必工人重新指一次
    expect(scanShelf.selectedShelfId).toBe('8800000000002');
  });
});
