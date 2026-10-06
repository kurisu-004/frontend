// src/views/dashboard/composables/__tests__/useDashboardDeliveryOrders.spec.ts
//
// 2026-10-07 新增：useDashboardDeliveryOrders（柱状图按层下钻明细）reactive params +
// enabled 闸门 + Zod 守门回归保护。
//
// 覆盖：
//   - W1：queryKey 形态 — ['dashboard','delivery-orders',{date,statuses,basis}]；
//   - W2：params=null 时 enabled=false，请求不发；
//   - W3：params.statuses 为空数组时 enabled=false（防御性：后端对空白 statuses
//     走 validation 40001，前端不发比发必失败的请求更省）；
//   - W4：换 params 后不调 fetchList，自动 refetch 直接带新 params（请求参数 ≡ 当前
//     缓存键，queryFn 不捕获 setup 期的旧值）；
//   - W4b：响应只落在与请求同源的缓存键下（键与请求参数不得各说各话）；
//   - W5：切日期 / 切层 / 切口径各换键并自动 refetch；
//   - W6：WS 事件触发 invalidate —— 走前缀键（精确键只会失效当前那一条）；
//   - W7：total 不受 items 截断影响（抽屉头部「共 N 件」的来源）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const fetchDeliveryOrdersMock = vi.fn();
const eventHandlers = new Set<
  (ev: { type: 'event'; event_type: string; data: Record<string, unknown>; ts: string }) => void
>();
const onDashboardEventMock = vi.fn(
  (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => {
    eventHandlers.add(h);
    return () => {
      eventHandlers.delete(h);
    };
  },
);

vi.mock('@/api/dashboard', () => ({
  fetchDeliveryOrders: (params: unknown) => fetchDeliveryOrdersMock(params),
  onDashboardEvent: (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => onDashboardEventMock(h),
}));

import { useDashboardDeliveryOrders } from '../useDashboardDeliveryOrders';
import { qk } from '@/composables/queries/keys';
import type { DeliveryBasis } from '@/types/dashboard';
import type { OrderStatus } from '@/types/parts';
import type { MaybeRefOrGetter } from 'vue';

interface Params {
  date: string;
  statuses: OrderStatus[];
  basis: DeliveryBasis;
}

function makeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    serial_no: 'SN-001',
    drawing_no: 'DWG-001',
    name: '零件甲',
    l1_customer_name: 'L1 客户',
    customer_name: '客户甲',
    status: 'PENDING',
    planned_delivery_date: '2026-10-01',
    system_delivery_date: null,
    ...overrides,
  };
}

function makeOut(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-10-01',
    basis: 'planned',
    total: 1,
    items: [makeDetail()],
    ts: '2026-10-07T14:30:00.123+08:00',
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountOrders(params: MaybeRefOrGetter<Params | null>) {
  const scope = effectScope();
  let c: ReturnType<typeof useDashboardDeliveryOrders> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() => useDashboardDeliveryOrders(params));
  });
  return { scope, comp: c! };
}

describe('useDashboardDeliveryOrders — 下钻明细 query（2026-10-07）', () => {
  beforeEach(() => {
    fetchDeliveryOrdersMock.mockReset();
    onDashboardEventMock.mockClear();
    eventHandlers.clear();
    fetchDeliveryOrdersMock.mockResolvedValue(makeOut());

    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.useRealTimers();
  });

  it('W1：queryKey = ["dashboard","delivery-orders",{date,statuses,basis}]', async () => {
    const params = ref<Params | null>({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
      basis: 'planned',
    });
    const { scope } = mountOrders(params);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const cache = testQueryClient.getQueryCache();
    const found = cache.find({
      queryKey: qk.dashboardDeliveryOrders({
        date: '2026-10-01',
        statuses: ['PENDING', 'PROGRAMMING'],
        basis: 'planned',
      }),
    });
    expect(found).toBeTruthy();
    expect(found?.queryKey[0]).toBe('dashboard');
    expect(found?.queryKey[1]).toBe('delivery-orders');
    scope.stop();
  });

  it('W2：params=null（抽屉未打开）→ enabled=false，请求不发', async () => {
    const { scope } = mountOrders(ref(null));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchDeliveryOrdersMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('W3：statuses 为空数组 → enabled=false，请求不发', async () => {
    const { scope } = mountOrders(
      ref<Params | null>({ date: '2026-10-01', statuses: [], basis: 'system' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchDeliveryOrdersMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('W4：换 params 后不调 fetchList，自动 refetch 直接带新 params（不闭包捕获 stale）', async () => {
    const params = ref<Params | null>({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
      basis: 'planned',
    });
    const { scope, comp } = mountOrders(params);
    // 只靠挂载时的自动取数，不调 fetchList —— fetchList 会强制 refetch，把
    // 「queryFn 读到的是不是新值」这件事整个盖掉。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchDeliveryOrdersMock).toHaveBeenCalledWith({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
      basis: 'planned',
    });

    // 证伪力：若 queryFn 在 setup 期就把 params 求值捕获下来（闭包 stale 实现），
    // 这次换键触发的请求仍会带 10-01，断言即失败。
    fetchDeliveryOrdersMock.mockClear();
    params.value = { date: '2026-10-09', statuses: ['DELIVERED'], basis: 'system' };
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fetchDeliveryOrdersMock).toHaveBeenCalledTimes(1);
    expect(fetchDeliveryOrdersMock).toHaveBeenCalledWith({
      date: '2026-10-09',
      statuses: ['DELIVERED'],
      basis: 'system',
    });
    expect(comp.data.value).toHaveLength(1);
    scope.stop();
  });

  it('W4b：响应只落在与请求同源的缓存键下（键与请求参数不得各说各话）', async () => {
    // 键与请求参数同源是这个 composable 的核心不变量：一旦某天改成「键算一份、
    // 请求参数从别处再取一份」，响应就会被写进错误的键，前端随后从该键读出别的日期的
    // 数据且毫无报错。这里让 mock 按收到的 date 回带标记数据，再逐键对账。
    fetchDeliveryOrdersMock.mockImplementation((p: Params) =>
      Promise.resolve(makeOut({ date: p.date, total: Number(p.date.slice(8)) })),
    );
    const params = ref<Params | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });
    const { scope } = mountOrders(params);

    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      params.value = { date: day, statuses: ['PENDING'], basis: 'planned' };
      await new Promise((resolve) => setTimeout(resolve, 30));
      const entry = testQueryClient
        .getQueryCache()
        .find({ queryKey: qk.dashboardDeliveryOrders(params.value) });
      // 该键下缓存的必须是「按这一天请求回来的」那份 total（= 日期的日号）。
      expect(entry?.state.data).toMatchObject({ date: day, total: Number(day.slice(8)) });
    }
    scope.stop();
  });

  it('W5：切日期 / 切层 / 切口径各换键并自动 refetch', async () => {
    const params = ref<Params | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });
    const { scope } = mountOrders(params);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fetchDeliveryOrdersMock.mockClear();

    params.value = { date: '2026-10-02', statuses: ['PENDING'], basis: 'planned' };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchDeliveryOrdersMock).toHaveBeenCalledWith({
      date: '2026-10-02',
      statuses: ['PENDING'],
      basis: 'planned',
    });

    params.value = {
      date: '2026-10-02',
      statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'OUTSOURCE'],
      basis: 'planned',
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchDeliveryOrdersMock).toHaveBeenCalledWith({
      date: '2026-10-02',
      statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'OUTSOURCE'],
      basis: 'planned',
    });

    params.value = {
      date: '2026-10-02',
      statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'OUTSOURCE'],
      basis: 'system',
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchDeliveryOrdersMock).toHaveBeenCalledWith({
      date: '2026-10-02',
      statuses: ['PENDING', 'PROGRAMMING', 'IN_PROCESS', 'OUTSOURCE'],
      basis: 'system',
    });
    scope.stop();
  });

  it('W6：WS 事件触发 invalidate —— 走前缀键，已切走的查询同样被标脏', async () => {
    vi.useFakeTimers();
    const params = ref<Params | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });
    const { scope } = mountOrders(params);
    await vi.advanceTimersByTimeAsync(30);
    // 切到另一条，制造「非当前」的旧查询
    params.value = { date: '2026-10-05', statuses: ['DELIVERED'], basis: 'system' };
    await vi.advanceTimersByTimeAsync(30);

    const cache = testQueryClient.getQueryCache();
    const stale = cache.find({
      queryKey: qk.dashboardDeliveryOrders({
        date: '2026-10-01',
        statuses: ['PENDING'],
        basis: 'planned',
      }),
    });
    expect(stale).toBeTruthy();
    expect(stale?.state.isInvalidated).toBe(false);

    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const handler = [...eventHandlers].at(-1)!;
    handler({ type: 'event', event_type: 'PART_DELIVERED', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(500);

    // 精确键只能失效当前那一条；已切走的那条同样过期，故必须用前缀。
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardDeliveryOrdersPrefix });
    expect(stale?.state.isInvalidated).toBe(true);
    scope.stop();
  });

  it('W7：total 不受 items 截断影响（抽屉头部「共 N 件」的来源）', async () => {
    fetchDeliveryOrdersMock.mockResolvedValue(
      makeOut({
        total: 9,
        items: [makeDetail({ id: '1' }), makeDetail({ id: '2' })],
      }),
    );
    const params = ref<Params | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });
    const { scope, comp } = mountOrders(params);
    await comp.fetchList();

    expect(comp.total.value).toBe(9);
    expect(comp.data.value).toHaveLength(2);
    scope.stop();
  });
});
