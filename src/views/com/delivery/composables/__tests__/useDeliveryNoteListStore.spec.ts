// src/views/com/delivery/composables/__tests__/useDeliveryNoteListStore.spec.ts
//
// 2026-10-08 新增：送货单一览页面级 store 的守卫。
//
// 覆盖（对齐任务书 §7 清单 + CLAUDE.md 页面级 store 的 4 不变量里可测的那几条）：
//   - slice 形态：`query` / `actions` 是 **plain object**（不是 ref / reactive）——
//     写成 reactive 会通过 Pinia 的 state 登记闸门进 state，$dispose 后 hydrate 回来
//     ⇒ 对话框态 / 页码泄漏到下次进入；
//   - `restoreState()` 末尾开 enabled 闸门（构造后 0 请求，restore 之后才发）；
//   - 输入态 / 生效态拆分（打字 0 请求，onSearch 才提交且 page 归 1）；
//   - 前缀失效（写后一把刷掉本域全部键）；
//   - 一键送货的司机流程（2026-10-16）：选司机 ⇒ driver POST 先、pickup 后且用 driver
//     响应里的**新** version；沿用本单司机 ⇒ 只发 pickup 一条；零 ElMessageBox；
//     失败路径也失效本域（driver 成功 + pickup 失败 ⇒ 本端 version / 司机名已过期）。
//   - 对话框快照的清理时机：关闭那一刻**不清**（leave 过渡期间回显还在用），等 `closed`。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as HttpModule from '@/api/http';
import { qk } from '@/composables/queries/keys';
import type { DeliveryNoteRow } from '../../deliveryNoteColumnDefs';
import { useDeliveryNoteListStore } from '../useDeliveryNoteListStore';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => true) },
  // columnDefs 的 cellRender 里用到 ElTag（状态列）
  ElTag: {},
  ElButton: {},
  ElTooltip: {},
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: { items: [], total: 0, limit: 50, offset: 0 },
  })),
  apiPostMock: vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>(async () => ({
    data: null,
  })),
}));

vi.mock('@/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, api: { ...actual.api, get: apiGetMock, post: apiPostMock } };
});

vi.mock('@/composables/queries/useCustomersQuery', () => ({
  useCustomersQuery: () => ({ data: { value: { items: [] } } }),
}));

// node 环境没有 localStorage（useListStatePersist / useColumnVisibility 会 try/catch
// 静默兜底，但「持久化恢复」路径就测不到了）—— 装一个内存版最小实现。
const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string): string | null => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string): void => void memoryStorage.set(k, v),
  removeItem: (k: string): void => void memoryStorage.delete(k),
  clear: (): void => memoryStorage.clear(),
});

const app = createApp({ render: () => null });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let pinia: Pinia;

function boot(): ReturnType<typeof useDeliveryNoteListStore> {
  pinia = createPinia();
  app.use(pinia);
  app.use(VueQueryPlugin, { queryClient });
  setActivePinia(pinia);
  return app.runWithContext(() => useDeliveryNoteListStore());
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await nextTick();
  await new Promise((r) => setTimeout(r, 0));
}

// element-plus 已在文件头桩成 no-op ⇒ 取出 mock 门面，用于「确认送货不再走
// ElMessageBox」与失败 toast 的断言。
const { ElMessage, ElMessageBox } = await import('element-plus');

/** 一张 SUBMITTED 送货单行（`canDeliver` 为真的形态）。 */
function noteRow(over: Partial<DeliveryNoteRow> = {}): DeliveryNoteRow {
  return {
    id: 'N1',
    version: 3,
    delivery_note_no: 'DN-001',
    customer_id: 'C1',
    customer_name: '法拉电子',
    customer_path: '法拉电子 / 法拉',
    status: 'SUBMITTED',
    submitted_at: '2026-10-16 09:00:00',
    picked_up_at: null,
    driver_worker_name: null,
    part_count: 2,
    note: null,
    delivery_date: '2026-10-16',
    ...over,
  };
}

/** 送货两条 POST 按发生顺序的 URL（`/driver` 与 `/pickup` 后缀）。 */
function deliverPostUrls(): string[] {
  return apiPostMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.endsWith('/driver') || u.endsWith('/pickup'));
}

/** 让 driver POST 返回推进后的 version（`+1`），其余返回 null。 */
function mockDriverPostPushesVersion(): void {
  apiPostMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/driver')) return { data: noteRow({ version: 4 }) };
    return { data: null };
  });
}

beforeEach(() => {
  queryClient.clear();
  memoryStorage.clear();
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue({ data: { items: [], total: 0, limit: 50, offset: 0 } });
  apiPostMock.mockReset();
  apiPostMock.mockResolvedValue({ data: null });
});

describe('useDeliveryNoteListStore', () => {
  it('对外状态走 plain object slice（非 ref / 非 reactive ⇒ 不会被 Pinia 登记进 state）', () => {
    const store = boot();
    expect(store.$state).toEqual({});
    expect(isPlainObject(store.query)).toBe(true);
    expect(isPlainObject(store.actions)).toBe(true);
    // slice 内层是 ref（由 Pinia 深代理自动解包），但 slice 自身必须不是 ref/reactive
    expect(store.query).not.toHaveProperty('__v_isRef');
    expect(store.query).not.toHaveProperty('__v_isReactive');
  });

  it('构造后 0 请求；restoreState() 之后才发（enabled 闸门，避免双 fetch）', async () => {
    const store = boot();
    await settle();
    expect(apiGetMock).not.toHaveBeenCalled();
    store.query.restoreState();
    await settle();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it('输入态 / 生效态拆分：打字 0 请求，onSearch 才提交且 page 归 1', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    const before = apiGetMock.mock.calls.length;
    store.query.page = 3; // page 进 queryKey ⇒ 会重发（这是另一次提交，不是打字）
    await settle();
    const afterPage = apiGetMock.mock.calls.length;
    expect(afterPage).toBe(before + 1);
    store.query.searchInput = 'DN-9'; // 输入态**不进** queryKey ⇒ 0 请求
    await settle();
    expect(apiGetMock.mock.calls.length).toBe(afterPage);
    store.query.onSearch();
    await settle();
    expect(store.query.search).toBe('DN-9');
    expect(store.query.page).toBe(1);
    expect((apiGetMock.mock.calls.at(-1)![1] as { params: { keyword: string } }).params.keyword).toBe(
      'DN-9',
    );
  });

  it('restoreState 把生效态同步回输入态（输入框不留白）', () => {
    const store = boot();
    store.query.restoreState();
    expect(store.query.searchInput).toBe(store.query.search);
  });

  it('URL ?statuses= 优先于持久化快照', async () => {
    const store = boot();
    store.query.setRouteStatuses('PICKED_UP,ARCHIVED');
    store.query.restoreState();
    expect(store.query.statuses).toEqual(['PICKED_UP', 'ARCHIVED']);
    await settle();
  });

  it('老快照（{statuses, customerId, keyword}，没有 autoRefresh）照样恢复（M2 回归）', () => {
    // 老视图写进 localStorage 的就是这三个键；本轮把「生效态 ref」改名成 search 之后，
    // 若把持久化 dep 键也改名，restore() 的严格校验会让**整份**快照返回 null ⇒
    // 所有老用户的状态 / 客户 / 单号筛选记忆一次性全丢。
    memoryStorage.set(
      'myerp.list.anon.delivery_note_list',
      JSON.stringify({
        statuses: ['SUBMITTED'],
        customerId: 'C-7',
        keyword: 'DN-2026',
      }),
    );
    const store = boot();
    store.query.restoreState();
    expect(store.query.statuses).toEqual(['SUBMITTED']);
    expect(store.query.customerId).toBe('C-7');
    expect(store.query.search).toBe('DN-2026');
    expect(store.query.searchInput).toBe('DN-2026');
    // 老快照里没有 autoRefresh ⇒ 兜底 false（而不是让整份快照作废）
    expect(store.query.autoRefresh).toBe(false);
  });

  it('写回的快照用 keyword 键（键名不许漂）', async () => {
    const store = boot();
    store.query.restoreState();
    store.query.search = 'DN-2026';
    // useListStatePersist 的 watch 是 300ms 节流 ⇒ 等过节流窗口再读盘。
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    const raw = memoryStorage.get('myerp.list.anon.delivery_note_list');
    expect(raw).toBeTruthy();
    expect(Object.keys(JSON.parse(raw!)).sort()).toEqual([
      'autoRefresh',
      'customerId',
      'keyword',
      'statuses',
    ]);
  });

  it('写后走前缀失效（一把刷掉本域全部键，而不是只刷当前 list）', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    const invalidations: unknown[] = [];
    const spy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockImplementation(async (filters: unknown) => {
        invalidations.push(filters);
        return Promise.resolve();
      });
    await store.actions.onSoftDelete({
      id: '1',
      version: 1,
      delivery_note_no: 'DN-1',
      customer_id: 'C1',
      customer_name: null,
      customer_path: null,
      status: 'DRAFT',
      submitted_at: null,
      picked_up_at: null,
      driver_worker_name: null,
      part_count: 0,
      note: null,
      delivery_date: null,
    });
    expect(invalidations).toContainEqual({ queryKey: qk.deliveryNotesPrefix });
    spy.mockRestore();
  });

  it('registerRouter 注入导航能力（store 不 import vue-router）', () => {
    const store = boot();
    const pushed: string[] = [];
    store.registerRouter(() => ({ push: (p: string) => pushed.push(p) }));
    store.actions.navigateToDetail('42');
    expect(pushed).toEqual(['/delivery-notes/42']);
    // 未注入时不炸（node 单测无 router 实例）
    const bare = boot();
    expect(() => bare.actions.navigateToDetail('1')).not.toThrow();
  });

  it('$dispose 后重新构造 ⇒ 对话框态 / 页码不泄漏（Pinia hydrate 回归守卫）', async () => {
    const store = boot();
    store.query.restoreState();
    store.query.page = 4;
    store.query.search = 'DN-LEAK';
    await settle();
    store.$dispose();
    const fresh = useDeliveryNoteListStore();
    expect(fresh.query.page).toBe(1);
    expect(fresh.query.search).toBe('');
  });
});

/**
 * 一键送货的司机流程（2026-10-16）。
 *
 * 服务端两条 POST 的顺序是硬约束：`POST /{id}/driver` **推进 version**，所以
 * `POST /{id}/pickup` 必须吃它响应里返回的新 version —— 用打开对话框时那份 version
 * 必 409。这条只能靠 spec 钉住：把 mutationFn 写成「两条并发」或「复用旧 version」
 * 在类型层面完全合法、界面上也看不出差别，只有请求体与顺序能发现。
 */
describe('onDeliver 一键送货：司机流程', () => {
  /** element-plus 是文件头桩出来的 vi.fn，断言前先清调用记录（与「只查调用」的写法配套）。 */
  function clearMock(fn: unknown): void {
    (fn as { mockClear: () => void }).mockClear();
  }

  beforeEach(() => {
    clearMock(ElMessageBox.confirm);
    clearMock(ElMessage.error);
  });

  it('onDeliver 只开对话框：零 POST、不再走 ElMessageBox', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    store.actions.onDeliver(noteRow());
    expect(store.actions.deliverDialogOpen).toBe(true);
    expect(store.actions.deliverTarget).toEqual({
      id: 'N1',
      version: 3,
      delivery_note_no: 'DN-001',
      part_count: 2,
      driver_worker_name: null,
    });
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
  });

  it('选了司机 → 先 POST /{id}/driver，再 POST /{id}/pickup，后者用 driver 返回的新 version', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    mockDriverPostPushesVersion();

    store.actions.onDeliver(noteRow());
    await store.actions.onDeliverConfirm('W2');

    expect(deliverPostUrls()).toEqual([
      '/com/delivery/note/N1/driver',
      '/com/delivery/note/N1/pickup',
    ]);
    expect(apiPostMock.mock.calls[0]![1]).toEqual({ version: 3, driver_worker_id: 'W2' });
    // ⚠️ 这里是整条链最容易写错的一格：4 来自 driver 响应，不是行上的 3。
    expect(apiPostMock.mock.calls[1]![1]).toEqual({ version: 4 });
    expect(store.actions.deliverDialogOpen).toBe(false);
    // 目标快照已清：onDeliverConfirm 后面紧跟一次 closed（视图挂 `:closed`）。
    store.actions.onDeliverDialogClosed();
    expect(store.actions.deliverTarget).toBeNull();
    expect(store.actions.isDelivering('N1')).toBe(false);
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('沿用本单司机（空串）→ 只发 pickup 一条，version 用行上的那份（不重发 driver）', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    mockDriverPostPushesVersion();

    store.actions.onDeliver(noteRow({ driver_worker_name: '李四' }));
    await store.actions.onDeliverConfirm('');

    expect(deliverPostUrls()).toEqual(['/com/delivery/note/N1/pickup']);
    expect(apiPostMock.mock.calls[0]![1]).toEqual({ version: 3 });
    expect(ElMessage.error).not.toHaveBeenCalled();
  });

  it('driver POST 失败 → 不发 pickup，弹错误提示、行内 loading 清掉', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    apiPostMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/driver')) throw new Error('版本已过期，请刷新');
      return { data: null };
    });

    store.actions.onDeliver(noteRow());
    await store.actions.onDeliverConfirm('W2');

    expect(deliverPostUrls()).toEqual(['/com/delivery/note/N1/driver']);
    expect(ElMessage.error).toHaveBeenCalled();
    expect(store.actions.isDelivering('N1')).toBe(false);
  });

  // ⚠️ 「两条 POST 串一步」独有的失败态：driver 已落库（version 3→4、司机已改绑）而
  // pickup 失败。此时列表缓存里的 version 3 与旧司机名**都是过期的**，而本页没有 WS
  // 失效通道、又是 refetchOnWindowFocus:false ⇒ 不失效的话用户再点一次「送货」必然
  // 再吃一次 409。把 onError 里的失效删掉时本条会红。
  it('driver 成功 + pickup 失败 → 失效本域（本端 version 已陈旧，否则重试必 409）', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    apiPostMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/driver')) return { data: noteRow({ version: 4 }) };
      throw new Error('版本已过期，请刷新');
    });
    const invalidations: unknown[] = [];
    const spy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockImplementation(async (filters: unknown) => {
        invalidations.push(filters);
        return Promise.resolve();
      });

    store.actions.onDeliver(noteRow());
    await store.actions.onDeliverConfirm('W2');
    await settle();

    expect(deliverPostUrls()).toEqual([
      '/com/delivery/note/N1/driver',
      '/com/delivery/note/N1/pickup',
    ]);
    expect(invalidations).toContainEqual({ queryKey: qk.deliveryNotesPrefix });
    expect(ElMessage.error).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('关闭过渡结束（closed）之前 target 快照仍在（否则回显闪成「一键送货 — 」/「0 条」）', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    apiPostMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/driver')) return { data: noteRow({ version: 4 }) };
      return { data: null };
    });

    store.actions.onDeliver(noteRow());
    // 不 await：confirm 第一行就把对话框置为关闭，而 close 走 leave 过渡（内容仍在
    // DOM 里可见约 300ms）⇒ 此刻 target 必须还在，否则标题 / 正文闪成空值。
    void store.actions.onDeliverConfirm('W2');
    expect(store.actions.deliverDialogOpen).toBe(false);
    expect(store.actions.deliverTarget?.delivery_note_no).toBe('DN-001');
    expect(store.actions.deliverTarget?.part_count).toBe(2);

    store.actions.onDeliverDialogClosed();
    expect(store.actions.deliverTarget).toBeNull();
  });

  it('关闭对话框（视图的 :closed 回调）才丢 target 快照，下次 onDeliver 重新取行上的 version', async () => {
    const store = boot();
    store.query.restoreState();
    await settle();
    store.actions.onDeliver(noteRow());
    store.actions.onDeliverDialogClose(false);
    // 关闭那一刻只是开始 leave 过渡，快照仍在（上面那条用例守的就是这个窗口）。
    expect(store.actions.deliverTarget).not.toBeNull();
    store.actions.onDeliverDialogClosed();
    expect(store.actions.deliverTarget).toBeNull();
    // 对话框关着时 confirm 是空操作（不会对着上一张单子发请求）
    apiPostMock.mockClear();
    await store.actions.onDeliverConfirm('W2');
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
