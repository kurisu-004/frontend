// src/views/dashboard/composables/__tests__/useDashboardUpcoming.spec.ts
//
// 2026-10-07 新增：useDashboardUpcoming（交期分桶）reactive params + 占位 + WS 失效
// 回归保护。
//
// 覆盖：
//   - V1：queryKey 含 basis + days 两个维度（['dashboard','upcoming',basis,days]）；
//   - V2：queryFn 从 queryKey 读 basis / days 下发请求（不闭包捕获 stale 值）；
//   - V3：切 basis / 切 days 各换键并自动 refetch；
//   - V4：换键占位（keepPreviousData）—— data 沿用上一份 + isPlaceholderData=true，
//     同键后台 refetch 时 isPlaceholderData=false（提示层的信号只能取后者）；
//   - V5：WS 事件触发 invalidate（走前缀键，一次命中全部 basis × days 组合）；
//   - V6：Zod parse 失败（缺 today 必填字段）→ query.error 非空；
//   - V7：Zod refine 失配（today 与 buckets[0].date 漂移）→ query.error 非空 +
//     错误经 ElMessage 桥接暴露成显式故障。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const fetchUpcomingMock = vi.fn();
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
  fetchUpcomingDelivery: (params: unknown) => fetchUpcomingMock(params),
  onDashboardEvent: (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => onDashboardEventMock(h),
}));

import { useDashboardUpcoming } from '../useDashboardUpcoming';
import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { DeliveryBasis } from '@/types/dashboard';
import type { MaybeRefOrGetter } from 'vue';

function makeBuckets(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    today: '2026-10-07',
    buckets: [{ date: '2026-10-07', count: 8, by_status: { IN_PROCESS: 3, DELIVERED: 5 } }],
    ts: '2026-10-07T14:30:00.123+08:00',
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountUpcoming(basis: MaybeRefOrGetter<DeliveryBasis>, days: MaybeRefOrGetter<number>) {
  const scope = effectScope();
  let c: ReturnType<typeof useDashboardUpcoming> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() => useDashboardUpcoming(basis, days));
  });
  return { scope, comp: c! };
}

describe('useDashboardUpcoming — 交期分桶 query（2026-10-07）', () => {
  beforeEach(() => {
    fetchUpcomingMock.mockReset();
    onDashboardEventMock.mockClear();
    eventHandlers.clear();
    fetchUpcomingMock.mockResolvedValue(makeBuckets());

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

  it('V1：queryKey = ["dashboard","upcoming",basis,days]（两个维度都进键）', async () => {
    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope } = mountUpcoming(basis, days);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const cache = testQueryClient.getQueryCache();
    const found = cache.find({ queryKey: qk.dashboardUpcoming('system', 14) });
    expect(found).toBeTruthy();
    expect(found?.queryKey).toEqual(['dashboard', 'upcoming', 'system', 14]);
    scope.stop();
  });

  it('V2：queryFn 从 queryKey 读 basis / days 下发请求（reactive params 范式）', async () => {
    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope, comp } = mountUpcoming(basis, days);
    await comp.fetchList();

    expect(fetchUpcomingMock).toHaveBeenCalledWith({ basis: 'system', days: 14 });
    expect(comp.data.value?.today).toBe('2026-10-07');
    expect(comp.data.value?.buckets[0]?.count).toBe(8);
    scope.stop();
  });

  it('V3：切 basis / 切 days 各换键并自动 refetch（不依赖显式 refetch）', async () => {
    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope } = mountUpcoming(basis, days);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fetchUpcomingMock.mockClear();

    basis.value = 'planned';
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchUpcomingMock).toHaveBeenCalledWith({ basis: 'planned', days: 14 });

    days.value = 30;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchUpcomingMock).toHaveBeenCalledWith({ basis: 'planned', days: 30 });

    const cache = testQueryClient.getQueryCache();
    expect(cache.find({ queryKey: qk.dashboardUpcoming('system', 14) })).toBeTruthy();
    expect(cache.find({ queryKey: qk.dashboardUpcoming('planned', 14) })).toBeTruthy();
    expect(cache.find({ queryKey: qk.dashboardUpcoming('planned', 30) })).toBeTruthy();
    scope.stop();
  });

  it('V4：换键占位期间 data 沿用上一份 + isPlaceholderData=true；同键后台 refetch 时为 false', async () => {
    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope, comp } = mountUpcoming(basis, days);
    await comp.fetchList();
    expect(comp.data.value?.ts).toBe('2026-10-07T14:30:00.123+08:00');
    expect(comp.isPlaceholderData.value).toBe(false);

    // 挂起新键的响应，模拟慢网络
    let release: (v: unknown) => void = () => {};
    fetchUpcomingMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    days.value = 30;
    await nextTick();

    // 换键不清空数据：柱状图 7/14/30 根柱子不闪零，两个 KPI 也不归零。
    expect(comp.data.value).toBeDefined();
    expect(comp.data.value?.buckets).toHaveLength(1);
    // 提示层信号取 isPlaceholderData（不是 isFetching），调用方据此盖「口径切换中」。
    expect(comp.isPlaceholderData.value).toBe(true);

    release(makeBuckets({ ts: '2026-10-07T15:00:00.123+08:00' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(comp.isPlaceholderData.value).toBe(false);
    expect(comp.data.value?.ts).toBe('2026-10-07T15:00:00.123+08:00');

    // 同键后台 refetch：isFetching 为 true 但 isPlaceholderData 保持 false ——
    // 此刻图上数字是当前且正确的，不该被提示层说成「切换中」。
    vi.useFakeTimers();
    let release2: (v: unknown) => void = () => {};
    fetchUpcomingMock.mockImplementationOnce(
      () => new Promise((resolve) => { release2 = resolve; }),
    );
    void comp.query.refetch();
    await vi.advanceTimersByTimeAsync(0);
    expect(comp.query.isFetching.value).toBe(true);
    expect(comp.isPlaceholderData.value).toBe(false);
    release2(makeBuckets());
    scope.stop();
  });

  it('V5：WS 事件触发 invalidate —— 走前缀键，一次命中全部 basis × days 组合', async () => {
    vi.useFakeTimers();
    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope } = mountUpcoming(basis, days);
    await vi.advanceTimersByTimeAsync(30);
    // 先切出一个没有观察者的旧组合，制造「非当前那条缓存」
    days.value = 30;
    await vi.advanceTimersByTimeAsync(30);
    days.value = 7;
    await vi.advanceTimersByTimeAsync(30);

    const cache = testQueryClient.getQueryCache();
    const stale30 = cache.find({ queryKey: qk.dashboardUpcoming('system', 30) });
    expect(stale30).toBeTruthy();
    expect(stale30?.state.isInvalidated).toBe(false);

    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const handler = [...eventHandlers].at(-1)!;
    handler({ type: 'event', event_type: 'PART_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(500);

    // 失效的是整个 upcoming 维度（此前挂载过、现已切走的查询同样过期）。
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardUpcomingPrefix });
    expect(stale30?.state.isInvalidated).toBe(true);
    scope.stop();
  });

  it('V6：Zod parse 失败（缺 today）→ query.error 非空', async () => {
    const broken = makeBuckets();
    delete broken['today'];
    fetchUpcomingMock.mockResolvedValue(broken);

    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope, comp } = mountUpcoming(basis, days);
    try {
      await comp.fetchList();
    } catch {
      // 期望抛错
    }
    expect(comp.query.error.value).not.toBeNull();
    scope.stop();
  });

  it('V7：refine 失配（today 与 buckets[0].date 漂移）→ query.error 非空 + ElMessage 桥接', async () => {
    // 三个顶层字段全部齐全，只有 refine 能抓住这条：服务端若从别的日期起零填充，
    // 「今日到期」KPI（取首桶 count）就会静默显示错日的数字，必须在守门处炸掉。
    fetchUpcomingMock.mockResolvedValue(
      makeBuckets({
        buckets: [{ date: '2026-10-06', count: 8, by_status: { IN_PROCESS: 3, DELIVERED: 5 } }],
      }),
    );

    const basis = ref<DeliveryBasis>('system');
    const days = ref(14);
    const { scope, comp } = mountUpcoming(basis, days);
    try {
      await comp.fetchList();
    } catch {
      // 期望抛错
    }
    expect(comp.query.error.value).not.toBeNull();
    // 漂移数据不得落到 data 上（否则柱状图与 KPI 会画出错的今天）。
    expect(comp.data.value).toBeUndefined();
    await nextTick();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });
});
