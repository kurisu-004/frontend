// src/views/dashboard/composables/__tests__/useDashboardSnapshot.spec.ts
//
// 2026-09-28 新增：dashboard 大屏快照 composable 行为回归保护。
//
// 数据流（与 frontend/CLAUDE.md 2026-09-28 新增的 dashboard 域「HTTP 全量 +
// WS 事件 invalidate」架构对齐）：
//   1. setup 顶层 useQuery 拉一次 GET /api/v2/dashboard/snapshot 全量数据；
//   2. 业务事件通过 onDashboardEvent() 回调 → AFFECTS_DASHBOARD 集合过滤 →
//      useDebounceFn 500ms 防扫码雪崩 → qc.invalidateQueries 触发重取；
//   3. error 走 watch + ElMessage.error 桥接。
//
// 覆盖：
//   - U1：HTTP 全量加载 —— mock fetch 返回 sample → useQuery data 等于 sample；
//   - U2：WS 事件触发 invalidate —— mock onDashboardEvent 注册 → 派事件 → refetch；
//   - U3：Debounce 合并 —— 连续派 5 个事件（< 500ms 间隔）→ 只 refetch 1 次；
//   - U4：事件集过滤 —— DELIVERY_NOTE_CREATED（不在 AFFECTS_DASHBOARD）→ 不触发 invalidate；
//   - U5：Zod parse 失败 → query.error 非空；
//   - U6：vi.mock('element-plus') 桩成 no-op，避免 vitest node env document 抛错。
// 2026-10-04（交期口径切换）追加：
//   - U8：basis 进 queryKey —— 两条口径各自一份 cache identity，键 = ['dashboard',
//     'snapshot', basis]；
//   - U9：切 basis 触发自动 refetch，且请求带上新 basis；
//   - U10：WS 事件失效的是**前缀**（qk.dashboardSnapshotPrefix）—— 切到 system 后
//     派事件，planned 那条缓存也被标脏（用户切回去时不能吃到旧数）；
//   - U11：切口径的请求在途期间 data 沿用上一份快照 + isFetching=true（大屏不闪空，
//     同时给调用方出「数字还是旧的」提示的信号）。

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

// dashboard API 模块：fetchDashboardSnapshot + onDashboardEvent。
// 测试中需要拿到 onDashboardEvent 注册的 handler 列表来手动派事件。
const fetchSnapshotMock = vi.fn();
let lastEventHandler:
  | ((ev: { type: 'event'; event_type: string; data: Record<string, unknown>; ts: string }) => void)
  | null = null;
// 跟踪所有注册的 handler 用于回归保护。
// useDashboardSnapshot 必须捕获 off + tryOnScopeDispose，否则多次 mount/unmount
// 会累加永不清理的 handler。原实现 lastEventHandler 单变量无法表达「多次注册」，
// 改用 Set 记录所有未清理的 handler，U7 用例断言 scope.stop() 后 Set 清零。
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
    lastEventHandler = h;
    return () => {
      eventHandlers.delete(h);
      if (lastEventHandler === h) lastEventHandler = null;
    };
  },
);

vi.mock('@/api/dashboard', () => ({
  // 透传入参：口径切换用例要断言 basis 真的进了请求（mock 收到什么就是发什么）。
  fetchDashboardSnapshot: (params?: unknown) => fetchSnapshotMock(params),
  onDashboardEvent: (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => onDashboardEventMock(h),
}));

import { useDashboardSnapshot } from '../useDashboardSnapshot';
import { qk } from '@/composables/queries/keys';
import type { DeliveryBasis } from '@/types/dashboard';

function makeBaseSnapshot(): Record<string, unknown> {
  return {
    on_production_shelves: [
      {
        shelf_id: '150000000000001',
        shelf_code: 'A-01',
        shelf_name: '生产区 A-01',
        total_count: 1,
        items: [
          {
            id: '180000000000001',
            batch_id: null,
            batch_no: null,
            serial_no: 'SN-001',
            name: '零件甲',
            drawing_no: 'DWG-001',
            quantity: 10,
            is_urgent: false,
            planned_delivery_date: null,
            picked_up_at: null,
            current_holder_id: null,
            current_holder_kind: null,
            shelf_code: 'A-01',
            customer_id: null,
            customer_name: null,
            customer_path: null,
            next_process_id: null,
            next_process_name: null,
            worker_name: null,
          },
        ],
      },
    ],
    on_inspection_shelves: [],
    in_process: [],
    upcoming_delivery: [],
    ts: '2026-09-28T10:00:00+08:00',
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useDashboardSnapshot — HTTP 全量 + WS 事件 invalidate（2026-09-28）', () => {
  beforeEach(() => {
    fetchSnapshotMock.mockReset();
    onDashboardEventMock.mockClear();
    lastEventHandler = null;
    eventHandlers.clear();
    fetchSnapshotMock.mockResolvedValue(makeBaseSnapshot());

    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.useRealTimers();
  });

  it('U1：HTTP 全量加载 → useQuery data 等于 sample', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot('planned'));
    });
    await q!.refetch();

    expect(fetchSnapshotMock).toHaveBeenCalled();
    const data = q!.data.value;
    expect(data).not.toBeNull();
    expect(data?.on_production_shelves).toHaveLength(1);
    expect(data?.on_production_shelves[0]?.shelf_code).toBe('A-01');
    scope.stop();
  });

  it('U2：WS 事件触发 invalidate → refetch 被调', async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot('planned'));
    });
    await q!.refetch();
    fetchSnapshotMock.mockClear();

    // 派一个影响 dashboard 的事件
    expect(lastEventHandler).not.toBeNull();
    lastEventHandler!({
      type: 'event',
      event_type: 'PART_TO_SHIP',
      data: { part_id: '180000000000001' },
      ts: '2026-09-28T10:00:00+08:00',
    });

    // 防抖 500ms 前不应触发 invalidate
    expect(fetchSnapshotMock).not.toHaveBeenCalled();

    // 推进 fake timer 500ms，触发 invalidate → query 自动 refetch
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSnapshotMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('U3：Debounce 合并 —— 连续派 5 个事件 → 只 refetch 1 次', async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot('planned'));
    });
    await q!.refetch();
    fetchSnapshotMock.mockClear();

    // 500ms 内连续派 5 个事件（每个间隔 50ms，200ms 总跨度，远小于 500ms 防抖窗口）
    lastEventHandler!({ type: 'event', event_type: 'PART_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    lastEventHandler!({ type: 'event', event_type: 'PART_TO_INSPECTION', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    lastEventHandler!({ type: 'event', event_type: 'PART_TO_PROCESS', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    lastEventHandler!({ type: 'event', event_type: 'BATCH_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    lastEventHandler!({ type: 'event', event_type: 'BATCH_TO_INSPECTION', data: {}, ts: 'x' });

    // 防抖 500ms 未到，refetch 仍 0 次
    expect(fetchSnapshotMock).not.toHaveBeenCalled();

    // 推进到 last event 之后的 500ms（trailing edge），触发 1 次 refetch
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSnapshotMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('U4：事件集过滤 —— DELIVERY_NOTE_CREATED 不在 AFFECTS_DASHBOARD → 不触发 invalidate', async () => {
    vi.useFakeTimers();
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot('planned'));
    });
    await q!.refetch();
    fetchSnapshotMock.mockClear();

    // DELIVERY_NOTE_CREATED / DELIVERY_NOTE_PARTS_ADDED 等不影响 dashboard 大屏数据
    lastEventHandler!({ type: 'event', event_type: 'DELIVERY_NOTE_CREATED', data: {}, ts: 'x' });

    // 推进超过 500ms + maxWait 1500ms 仍不应触发 refetch
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('U5：Zod parse 失败 → query.error 非空', async () => {
    // 后端返回缺 ts（必填字段）→ Zod parse 抛 ZodError → query.error 设置
    fetchSnapshotMock.mockResolvedValue({
      on_production_shelves: [],
      on_inspection_shelves: [],
      in_process: [],
      upcoming_delivery: [],
      // ts: 故意缺
    });

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot('planned'));
    });

    // 等待 refetch + parse 失败（vue-query 在 microtask 链里抛）
    try {
      await q!.refetch();
    } catch {
      // 期望抛错
    }

    expect(q!.error.value).not.toBeNull();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('U7：多次 mount/unmount 不累加 onDashboardEvent handler', () => {
    // 原 DashboardView.vue 用 onBeforeUnmount
    // 调 offSnap?.() 清理 onDashboardEvent 订阅；重构迁到 useDashboardSnapshot 时
    // 漏了清理，每次进入 /dashboard 都往 eventSubs Set 累加一个永不清理的 handler，
    // 闭包持有的 debouncedInvalidate / qc / query 永远无法 GC。本轮修：捕获 off +
    // tryOnScopeDispose。本用例是这条修复的回归保护：5 轮 mount/unmount 后 handler
    // Set 必须清零，否则就是漏了清理逻辑。
    for (let i = 0; i < 5; i++) {
      const scope = effectScope();
      scope.run(() => {
        testApp.runWithContext(() => useDashboardSnapshot('planned'));
      });
      // mount 后应该正好 1 个活跃 handler（本次 scope 注册的那个）
      expect(eventHandlers.size).toBe(1);
      scope.stop();
      // unmount 后 tryOnScopeDispose 触发 off → handler Set 清零
      expect(eventHandlers.size).toBe(0);
    }

    // 5 轮 mount/unmount 后最终状态：eventHandlers 应该清零
    expect(eventHandlers.size).toBe(0);
    expect(onDashboardEventMock).toHaveBeenCalledTimes(5);
  });

  // ==========================================================================
  // 2026-10-04：交期统计口径（planned / system）—— 口径进键，切口径即换键 refetch
  // ==========================================================================

  it('U8：queryKey 含 basis 维度 —— 两条口径各自一份 cache identity', async () => {
    const basis = ref<DeliveryBasis>('planned');
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardSnapshot(basis));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    basis.value = 'system';
    await new Promise((resolve) => setTimeout(resolve, 30));

    const cache = testQueryClient.getQueryCache();
    // 键严格四层：['dashboard', 'snapshot', basis]
    const planned = cache.find({ queryKey: qk.dashboardSnapshot('planned') });
    const system = cache.find({ queryKey: qk.dashboardSnapshot('system') });
    expect(planned).toBeTruthy();
    expect(system).toBeTruthy();
    expect(planned?.queryKey).toEqual(['dashboard', 'snapshot', 'planned']);
    expect(system?.queryKey).toEqual(['dashboard', 'snapshot', 'system']);
    scope.stop();
  });

  it('U9：切 basis → 自动 refetch，且请求带上新 basis', async () => {
    const basis = ref<DeliveryBasis>('planned');
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot(basis));
    });
    await q!.refetch();
    expect(fetchSnapshotMock).toHaveBeenCalledWith({ basis: 'planned' });
    fetchSnapshotMock.mockClear();

    basis.value = 'system';
    // 不调 refetch —— 换键本身就该触发一次自动请求（这正是「切口径自动跟随」的实现）
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fetchSnapshotMock).toHaveBeenCalledWith({ basis: 'system' });
    expect(q!.data.value?.ts).toBe('2026-09-28T10:00:00+08:00');
    scope.stop();
  });

  it('U10：WS 事件失效前缀 —— 切到 system 后 planned 那条（非当前口径）也被标脏', async () => {
    vi.useFakeTimers();
    const basis = ref<DeliveryBasis>('planned');
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardSnapshot(basis));
    });
    await vi.advanceTimersByTimeAsync(30);
    basis.value = 'system';
    await vi.advanceTimersByTimeAsync(30);

    const cache = testQueryClient.getQueryCache();
    const planned = cache.find({ queryKey: qk.dashboardSnapshot('planned') });
    expect(planned).toBeTruthy();
    expect(planned?.state.isInvalidated).toBe(false);
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    fetchSnapshotMock.mockClear();

    lastEventHandler!({ type: 'event', event_type: 'PART_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(500);

    // 关键断言 1：失效键是**前缀**，一次命中 planned / system 两条。
    // 若误用带 basis 的精确键，用户切回 planned 时会直接吃到事件前的旧快照。
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshotPrefix });
    // 关键断言 2：planned 当前无观察者（已切到 system）⇒ 不会被 refetch、标脏状态保留，
    // 这正是「前缀把非当前口径那条也失效了」的可观测证据。
    expect(planned?.state.isInvalidated).toBe(true);
    // 当前口径那条被立即重取
    expect(fetchSnapshotMock).toHaveBeenCalledWith({ basis: 'system' });
    scope.stop();
  });

  // ==========================================================================
  // 2026-10-04：切口径期间保持上一份快照（大屏不闪空）
  // ==========================================================================

  it('U11：切 basis 的请求在途期间 data 仍是上一份快照，且 isFetching=true', async () => {
    const basis = ref<DeliveryBasis>('planned');
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardSnapshot(basis));
    });
    await q!.refetch();
    expect(q!.data.value?.ts).toBe('2026-09-28T10:00:00+08:00');
    expect(q!.isFetching.value).toBe(false);

    // 让新口径的请求挂在未决状态上（模拟慢响应）。
    let releaseSystem: (v: unknown) => void = () => {};
    fetchSnapshotMock.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSystem = resolve; }),
    );

    basis.value = 'system';
    await nextTick();

    // 关键：DashboardView 的 7 个派生量（全从这一个 ref 出）都依赖 data 非空。
    // 不配 keepPreviousData 的话此刻 data 会是 undefined —— 柱状图 14 根柱清零、
    // 今日/两周到期归零，连与口径无关的在制/在检 KPI 也一起归零，整块大屏闪空。
    expect(q!.data.value).toBeDefined();
    expect(q!.data.value?.ts).toBe('2026-09-28T10:00:00+08:00');
    // 数字暂时还是旧口径的 —— 调用方据此出「切换中」提示（DashboardView 把它接到
    // UpcomingDeliveryChart 的 :loading，图上盖一层 .chart-pending）。
    expect(q!.isFetching.value).toBe(true);

    releaseSystem({ ...makeBaseSnapshot(), ts: '2026-10-04T10:00:00+08:00' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(q!.isFetching.value).toBe(false);
    expect(q!.data.value?.ts).toBe('2026-10-04T10:00:00+08:00');
    scope.stop();
  });
});
