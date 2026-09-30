// src/views/cnc/composables/__tests__/usePendingProgrammingStore.spec.ts
//
// 2026-10-01 新增：「待编程一览」页 store（Pinia setup store）单测。
//
// 覆盖（对齐任务书 4.2 清单）：
//   - T1：Tab 映射 —— pending → has_cnc_program === false；programmed → true。
//   - T2：keyword / serialNo 的 trim 与「空串 / 纯空格 → undefined」。
//   - T3：offset 计算 —— 第 1 页 offset=0；第 3 页（pageSize=20）offset=40。
//   - T4：enabled 闸门 —— store 构造后**不**自动发请求；restoreState() 之后才发
//         （避免「默认参数首屏 + 持久化参数再屏」双 fetch）。
//   - T5：Zod 守门 —— mock 返回缺 has_cnc_program 的响应 → query 进 error 态
//         （errorMsg 非空，items 为空）。
//   - T6：release 成功 → onSuccess 失效 programmingPrefix（+ partsPrefix）。
//   - T7：autoRefresh 开关 + restoreState 持久化恢复（search / autoRefresh / activeTab）。
//   - T8：$dispose 重建 store → 对话框态 / 页码 / Tab 归零（Pinia hydrate 泄漏 guard）。
//   - 2026-10-01 review 第 1 轮 I-1 追加（搜索输入态 / 生效态拆分）：
//     T9：改 searchInput **不发请求**；onSearch() 才提交并带新值（page 归 1）。
//     T10：清空（searchInput 置空 + onSearch）净发 **1 次**请求（不双发）。
//     T11：restoreState() 后 searchInput 与 search 一致（输入框不留白）。
//
// mock 策略：
//   - vi.mock('@/api/programming')：主查询唯一出口，替换为 vi.fn；
//   - vi.mock('@/api/parts')：releaseFromProgramming（@/api/parts 聚合导出，mock
//     工厂只需给出用到的成员）；
//   - vi.mock('@/api/process') / vi.mock('@/api/shelves')：store 内
//     useProcessesQuery / useProductionShelvesQuery + useShelfProcessFilter 会拉
//     基础数据，桩掉避免真实 axios；
//   - vi.mock('element-plus', () => ({ ElMessage: {...} }))：store 内
//     watch(errorMsg) → ElMessage.error 在 vitest node env 会因 ElMessage 内部
//     normalizeAppendTo 触发 ReferenceError: document is not defined（CLAUDE.md
//     TanStack Query 架构条目 #9），必须桩成 no-op。
//     2026-10-01 review 第 1 轮 M-7：ElButton / ElTag 也要列出来 —— store 经
//     ../pendingProgrammingColumnDefs 把这两个组件拉进了模块图（renderActions /
//     renderCncProgram 在 cellRender 里用），本文件 mock 掉 element-plus 后它们
//     会是 undefined。今天不炸只因没有用例调 cellRender；将来加一个「渲染行」的
//     用例会撞 undefined 组件报错，故显式占位（空对象即可，本文件只断言 store
//     状态，不渲染 VNode）。
//   - createApp({}) + app.use(createPinia()) + app.use(VueQueryPlugin) +
//     setActivePinia：store 内 useQueryClient() / useQuery / useMutation /
//     useColumnVisibility（内部 useAuthStore）都要求 pinia + queryClient 就位；
//   - vi.stubGlobal('localStorage', 内存版)：node 环境无 localStorage，装最小实现
//     才能跑通 useListStatePersist 的落盘 / 恢复路径。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
// 供 vi.mock 的 importOriginal 泛型使用（@typescript-eslint/consistent-type-imports
// 禁止内联 `typeof import('...')` 写法；沿 usePendingDispatch.spec.ts:42 同款）
import type * as HttpModule from '@/api/http';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: { confirm: vi.fn() },
  // 见文件头 M-7 注：store 模块图经 pendingProgrammingColumnDefs 引入了这两个组件
  ElButton: {},
  ElTag: {},
}));

// vitest node 环境没有 localStorage（useListFilterPersist / useColumnVisibility
// 内部 try/catch 静默兜底，所以「持久化恢复」路径默认测不到）。
// 2026-10-01：装一个内存版最小实现，让 T7 能守 restoreState 的恢复语义。
const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string): string | null => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    memoryStorage.set(k, v);
  },
  removeItem: (k: string): void => {
    memoryStorage.delete(k);
  },
  clear: (): void => {
    memoryStorage.clear();
  },
});


/** 主查询 mock 的返回形态：items 收 unknown[]（用例里要喂「缺字段」等非法 payload）。 */
interface PendingProgrammingResponse {
  items: unknown[];
  total: number;
  limit: number;
  offset: number;
}

// vi.mock 的工厂被提升到文件顶部，而工厂体里 `get: apiGetMock` 是**立即求值**的
// （不像 releaseFromProgrammingMock 那样藏在箭头函数体内延迟求值）⇒ 普通 const 声明
// 会撞 TDZ（"Cannot access 'apiGetMock' before initialization"）。用 vi.hoisted 把
// mock 的声明一起提升到 vi.mock 之前。
const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn<
    (url: string, config?: { params?: Record<string, unknown> }) => Promise<{ data: unknown }>
  >(async () => ({ data: { items: [], total: 0, limit: 20, offset: 0 } })),
}));

// 2026-10-01 review 第 1 轮 M-2：**mock 边界下移到 axios 层**。
// Zod 守门（pendingProgrammingListResultSchema.parse）已收敛进 api 层
// （fetchPendingProgramming 内部，形态同 api/pendingBatches.ts::dispatchBatches），
// 若还 mock 掉 '@/api/programming' 整个模块，守门链被短路 —— T5（响应缺字段 →
// query 进 error 态）就变成在测 mock 自己，而不是测产品代码。
// 改 mock '@/api/http' 的 api.get 后：
//   · fetchPendingProgramming 真跑（真 cleanParams + 真 pendingProgrammingListResultSchema.parse）；
//   · api.get 桩成可控 payload，发出的入参从 config.params 断言（已经过 cleanParams）；
//   · http.ts 其余导出（cleanParams / normalizeListResult / ApiError …）保持真实。
vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock } };
});

const releaseFromProgrammingMock = vi.fn<
  (id: string, shelfId: string, nextProcessId: string) => Promise<unknown>
>(async () => ({}));

vi.mock('@/api/parts', () => ({
  releaseFromProgramming: (id: string, shelfId: string, nextProcessId: string) =>
    releaseFromProgrammingMock(id, shelfId, nextProcessId),
}));

vi.mock('@/api/process', () => ({
  listProcesses: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

vi.mock('@/api/shelves', () => ({
  listShelves: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
  getAllShelfProcessMappings: vi.fn(async () => ({ items: [] })),
}));

import { usePendingProgrammingStore } from '../usePendingProgrammingStore';
import type { PendingProgrammingRow } from '../../pendingProgrammingColumnDefs';
import { qk } from '@/composables/queries/keys';

/** 造一行合法的 ProgrammingItem（13 字段齐全 —— 缺字段会被 Zod 守门拦掉）。 */
function makeItem(overrides: Partial<PendingProgrammingRow> = {}): PendingProgrammingRow {
  return {
    id: '190000000000099',
    version: 1,
    serial_no: 'SN-001',
    name: '法兰盘',
    drawing_no: 'DWG-A001',
    quantity: 5,
    status: 'PROGRAMMING',
    is_urgent: false,
    planned_delivery_date: '2026-10-10',
    system_delivery_date: null,
    customer_name: '客户A-子',
    parent_customer_name: '客户A',
    has_cnc_program: false,
    ...overrides,
  };
}

/** 主查询已发出的请求次数（api.get 调用数）。 */
function callCount(): number {
  return apiGetMock.mock.calls.length;
}

/** 让下一次主查询返回指定 payload（经真实 Zod 守门解析）。 */
function respondWith(payload: PendingProgrammingResponse): void {
  apiGetMock.mockResolvedValue({ data: payload });
}

/** 取最近一次主查询发出的 params（已过 cleanParams，缺省键被剥掉）。 */
function lastParams(): Record<string, unknown> {
  const calls = apiGetMock.mock.calls;
  return (calls[calls.length - 1]?.[1]?.params ?? {}) as Record<string, unknown>;
}

let testQueryClient: QueryClient;

describe('usePendingProgrammingStore', () => {
  beforeEach(() => {
    apiGetMock.mockClear();
    apiGetMock.mockReset();
    respondWith({ items: [], total: 0, limit: 20, offset: 0 });
    releaseFromProgrammingMock.mockClear();
    releaseFromProgrammingMock.mockResolvedValue({});

    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    const app = createApp({});
    app.use(createPinia());
    app.use(VueQueryPlugin, { queryClient: testQueryClient });
    setActivePinia(app.config.globalProperties.$pinia);
    memoryStorage.clear();
  });

  afterEach(() => {
    testQueryClient.unmount();
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  // ============ T1：Tab 映射 ============
  it('T1：pending tab → has_cnc_program=false；programmed tab → true', async () => {
    const store = usePendingProgrammingStore();
    expect(store.query.activeTab).toBe('pending');
    store.query.restoreState();
    await store.query.fetchList();
    expect(lastParams().has_cnc_program).toBe(false);

    // 切到「已编程」：onTabChange 只置 page=1，queryKey 变化自动 refetch
    store.query.activeTab = 'programmed';
    store.query.onTabChange();
    await store.query.fetchList();
    expect(lastParams().has_cnc_program).toBe(true);
  });

  // ============ T2：keyword / serialNo 的 trim 与空串→undefined ============
  it('T2：keyword / serialNo trim 后发出；空串与纯空格 → undefined', async () => {
    const store = usePendingProgrammingStore();
    store.query.restoreState();

    // 直接写**生效态** search（本例守的是 buildParams 的 trim 层，不经 onSearch
    // 中转；「打字不发请求、提交才发」由 T9 守）。
    // 纯空格 → undefined（不发该参数）
    store.query.search.keyword = '   ';
    store.query.search.serialNo = '';
    await store.query.fetchList();
    expect(lastParams().keyword).toBeUndefined();
    expect(lastParams().serial_no).toBeUndefined();

    // 两端空格被 trim
    store.query.search.keyword = '  法兰 ';
    store.query.search.serialNo = ' SN-001 ';
    await store.query.fetchList();
    expect(lastParams().keyword).toBe('法兰');
    expect(lastParams().serial_no).toBe('SN-001');
  });

  // ============ T3：offset 计算 ============
  it('T3：offset = (page - 1) * pageSize（第 1 页 0；第 3 页 40）', async () => {
    const store = usePendingProgrammingStore();
    store.query.restoreState();
    expect(store.query.pageSize).toBe(20);

    store.query.page = 1;
    await store.query.fetchList();
    expect(lastParams().limit).toBe(20);
    expect(lastParams().offset).toBe(0);

    store.query.page = 3;
    await store.query.fetchList();
    expect(lastParams().offset).toBe(40);

    // onSearch / onTabChange 都只做 page=1（offset 随之归零）
    store.query.page = 3;
    store.query.onSearch();
    expect(store.query.page).toBe(1);
    await store.query.fetchList();
    expect(lastParams().offset).toBe(0);
  });

  // ============ T4：enabled 闸门 ============
  it('T4：store 构造后不自动 fetch（enabled 闸门），restoreState 后才发第一次请求', async () => {
    const store = usePendingProgrammingStore();
    // 等微任务循环，确保 useQuery 的 scheduler 跑过 mount + enabled 检查
    await new Promise((r) => setTimeout(r, 20));
    expect(apiGetMock).not.toHaveBeenCalled();

    store.query.restoreState();
    await new Promise((r) => setTimeout(r, 20));
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(lastParams().has_cnc_program).toBe(false);
  });

  // ============ T5：Zod 守门 ============
  it('T5：响应缺 has_cnc_program → query 进 error 态（errorMsg 非空、items 空）', async () => {
    // 缺 has_cnc_program —— 后端漏返该字段时 Zod 必须抛错（不被 strip 静默吞掉）
    const { has_cnc_program: _omit, ...invalid } = makeItem();
    void _omit;
    respondWith({
      items: [invalid],
      total: 1,
      limit: 20,
      offset: 0,
    });

    const store = usePendingProgrammingStore();
    store.query.restoreState();
    await store.query.fetchList();

    expect(store.query.errorMsg).toBeTruthy();
    expect(store.query.items).toHaveLength(0);
    expect(store.query.total).toBe(0);
  });

  // ============ 正常路径：items / total 派生 ============
  it('T5b：响应合法 → items / total 正常派生', async () => {
    respondWith({
      items: [makeItem(), makeItem({ id: '190000000000100', has_cnc_program: true })],
      total: 2,
      limit: 20,
      offset: 0,
    });

    const store = usePendingProgrammingStore();
    store.query.restoreState();
    await store.query.fetchList();

    expect(store.query.errorMsg).toBeNull();
    expect(store.query.items).toHaveLength(2);
    expect(store.query.total).toBe(2);
    // 客户列渲染依赖的字段名（prod 域出参是 parent_customer_name，不是 l1_*）
    expect(store.query.items[0]?.parent_customer_name).toBe('客户A');
  });

  // ============ T6：release 成功 → 失效 programmingPrefix + partsPrefix ============
  it('T6：confirmRelease 成功 → onSuccess 失效 programmingPrefix 与 partsPrefix', async () => {
    respondWith({
      items: [makeItem()],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    const store = usePendingProgrammingStore();
    store.query.restoreState();
    await store.query.fetchList();

    store.release.target = store.query.items[0] ?? null;
    store.release.shelfId = '8800000000001';
    store.release.processId = '7700000000001';
    // router 桩：store 只用 push（20706 兜底跳工序制定页），结构化注入见
    // PendingProgrammingRouter 类型注
    await store.release.confirm({ push: vi.fn() });

    expect(releaseFromProgrammingMock).toHaveBeenCalledWith(
      '190000000000099',
      '8800000000001',
      '7700000000001',
    );
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown } | undefined)?.queryKey,
    );
    expect(invalidatedKeys).toContainEqual(qk.programmingPrefix);
    expect(invalidatedKeys).toContainEqual(qk.partsPrefix);
    // 成功后关对话框
    expect(store.release.dialogVisible).toBe(false);
    expect(store.release.submitting).toBe(false);
  });

  // ============ 自动刷新开关（轮询间隔本身在 node 环境不可断言）============
  // 2026-10-01：autoRefresh 语义回归 —— 勾选后由 useQuery 的 refetchInterval
  // 承担 5min 轮询（原视图的裸 setInterval 已删）。轮询定时器无法在 vitest node
  // 环境断言：query-core 的 `#shouldScheduleTimer` 带 `!isServer()` 闸门
  // （node 下 window 未定义 ⇒ 永不排定时器），本例只守「开关状态 + 持久化恢复」
  // 两层，间隔计算（300_000 / false）由 store 内 refetchInterval computed 负责。
  it('T7：autoRefresh 开关状态随 store 读写，且能经 restoreState 从持久化恢复', () => {
    const store = usePendingProgrammingStore();
    expect(store.query.autoRefresh).toBe(false);
    store.query.autoRefresh = true;
    expect(store.query.autoRefresh).toBe(true);

    // 模拟「刷新页面后恢复」：useListStatePersist 的 onBeforeUnmount 落盘
    store.$dispose();
    localStorage.setItem(
      'myerp.list.anon.pending_programming_filter',
      JSON.stringify({ search: { keyword: '法兰', serialNo: '' }, autoRefresh: true, activeTab: 'programmed' }),
    );

    const store2 = usePendingProgrammingStore();
    expect(store2.query.autoRefresh).toBe(false); // 构造时不预读持久化
    store2.query.restoreState();
    expect(store2.query.autoRefresh).toBe(true);
    expect(store2.query.activeTab).toBe('programmed');
    expect(store2.query.search.keyword).toBe('法兰');
  });

  // ============ $dispose：重建后状态归零 ============
  it('$dispose 重建 store → 私有状态归零（对话框态不泄漏到下次进入）', async () => {
    const store1 = usePendingProgrammingStore();
    store1.release.openDialog(makeItem());
    expect(store1.release.dialogVisible).toBe(true);
    store1.$dispose();

    const store2 = usePendingProgrammingStore();
    expect(store2.release.dialogVisible).toBe(false);
    expect(store2.release.target).toBeNull();
    expect(store2.query.page).toBe(1);
    expect(store2.query.activeTab).toBe('pending');
  });

  // ============ I-1（2026-10-01 review 第 1 轮）：搜索输入态 / 生效态拆分 ============

  /** 等一轮微任务 + timer，让 vue-query 的 pre-flush watch 跑完 setOptions。 */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it('T9：改 searchInput 不发请求；onSearch() 才提交（带新值 + page 归 1）', async () => {
    const store = usePendingProgrammingStore();
    store.query.restoreState();
    await settle();

    // 先把页码挪到第 3 页并等它落定，作为「打字前后」的基线
    store.query.page = 3;
    await settle();
    expect(lastParams().offset).toBe(40);
    const callsBeforeTyping = callCount();

    // 打字：只改输入态 ⇒ 0 请求（改前 bug 是每个字符一次 GET）
    store.query.searchInput.keyword = '法兰';
    store.query.searchInput.serialNo = ' SN-001 ';
    await settle();
    expect(apiGetMock).toHaveBeenCalledTimes(callsBeforeTyping);
    // 生效态此刻还是空的（输入没提交）
    expect(store.query.search.keyword).toBe('');
    expect(lastParams().keyword).toBeUndefined();

    // 提交：onSearch() 把输入态写进生效态并把页码归 1 ⇒ 只发一次
    store.query.onSearch();
    await settle();
    expect(callCount() - callsBeforeTyping).toBe(1);
    expect(store.query.search.keyword).toBe('法兰');
    expect(store.query.search.serialNo).toBe(' SN-001 ');
    expect(store.query.page).toBe(1);
    // 请求侧仍是 buildParams 的 trim 口径（生效态带空格 → 发出时已 trim）
    expect(lastParams().keyword).toBe('法兰');
    expect(lastParams().serial_no).toBe('SN-001');
    expect(lastParams().offset).toBe(0);
  });

  it('T10：清空搜索（searchInput 置空 + onSearch）净发 1 次请求，不双发', async () => {
    const store = usePendingProgrammingStore();
    store.query.restoreState();
    store.query.searchInput.keyword = '法兰';
    store.query.onSearch();
    await settle();
    expect(lastParams().keyword).toBe('法兰');

    store.query.page = 2;
    await settle();
    const callsBeforeClear = callCount();

    // el-input clearable 的 ✕ 会先 emit update:modelValue('') 再 emit @clear：
    // 前者只改输入态（0 请求），后者才提交 —— 净 1 次，不会双发。
    store.query.searchInput.keyword = '';
    store.query.searchInput.serialNo = '';
    await settle();
    expect(apiGetMock).toHaveBeenCalledTimes(callsBeforeClear);

    store.query.onSearch();
    await settle();
    expect(callCount() - callsBeforeClear).toBe(1);
    expect(store.query.search.keyword).toBe('');
    expect(store.query.page).toBe(1);
    expect(lastParams().keyword).toBeUndefined();
    expect(lastParams().offset).toBe(0);
  });

  it('T11：restoreState() 把生效态同步回输入态（输入框不留白）', () => {
    localStorage.setItem(
      'myerp.list.anon.pending_programming_filter',
      JSON.stringify({
        search: { keyword: '法兰', serialNo: 'SN-001' },
        autoRefresh: true,
        activeTab: 'programmed',
      }),
    );

    const store = usePendingProgrammingStore();
    store.query.restoreState();

    // 生效态
    expect(store.query.search.keyword).toBe('法兰');
    expect(store.query.search.serialNo).toBe('SN-001');
    // 输入态必须与生效态一致，否则输入框空白但列表已按恢复出的条件过滤
    expect(store.query.searchInput.keyword).toBe('法兰');
    expect(store.query.searchInput.serialNo).toBe('SN-001');
    expect(store.query.searchInput).toEqual(store.query.search);
  });
});
