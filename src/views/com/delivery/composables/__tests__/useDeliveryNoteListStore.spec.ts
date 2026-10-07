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
//   - 前缀失效（写后一把刷掉本域全部键）。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import type * as HttpModule from '@/api/http';
import { qk } from '@/composables/queries/keys';
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

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
