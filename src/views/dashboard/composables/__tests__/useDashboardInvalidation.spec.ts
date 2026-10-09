// src/views/dashboard/composables/__tests__/useDashboardInvalidation.spec.ts
//
// 2026-09-29 新增：useDashboardInvalidation WS 事件 → invalidate 回归保护。
//
// 覆盖：
//   - I1：25 个 AFFECTS_DASHBOARD 事件命中 → 触发 debounced invalidate
//   - I2：连续 5 个 AFFECTS_DASHBOARD 事件 → debounce 500ms 内合并 → 1 次 invalidate
//   - I3：maxWait 1500ms flush —— 持续超过 1500ms 必须强制 invalidate
//   - I4：非 AFFECTS_DASHBOARD 事件（如 DELIVERY_NOTE_CREATED）不触发 invalidate
//   - I5：component unmount → offDashboardEvent 触发 → handler Set 清零
//   - I6：传单个 QueryKey → 单次 invalidateQueries({ queryKey: key })
//   - I7：传 QueryKey[] → 遍历每个 key 各 invalidate 一次
//   - I9（2026-10-02 新增）：window 事件 'dashboard:full-refetch'
//     （后端 4003 慢消费方丢事件）→ **立即** invalidate，不走 500ms 防抖
//   - I10：scope.stop() → 'dashboard:full-refetch' listener 一并摘除（防泄漏）
//
// 2026-10-04：dashboardSnapshot 键改为含 basis 维度的工厂后，本文件的 snapshot
// 失效点全部改用 qk.dashboardSnapshotPrefix —— WS 事件到达时 planned / system 两条
// 缓存都要失效（前缀 partial match 一次命中两条），用带 basis 的精确键会漏掉用户
// 没在看的那个口径，切回去时吃到旧数。断言语义不变（仍是「WS 事件 → invalidate
// 该前缀」）。
//
// 2026-10-07：dashboard 域只余 3 个 query（snapshot / upcoming / deliveryOrders），
// 本文件用 qk.dashboardUpcomingPrefix 作「第二个 key」样本 —— 交期分桶键含
// basis × days 两个维度，事件到达时任意口径 / 任意天数的缓存同样该失效。
//
// 2026-10-02 取舍：用例内显式 `scope.stop()` 只是正常路径的清理；真正的
// 安全网是文件级 `makeScope()` 记账 + afterEach 统一 stop —— 断言中途失败时用例末尾的
// stop() 不会执行，泄漏的 listener 会把「一个真实失败」放大成级联假失败。
//
// 2026-10-02：本文件新增 window 事件接入点（4003 全量重取），node 环境下 window
// 不存在、composable 内的 `typeof window !== 'undefined'` 守卫会静默跳过注册 ⇒ 必须
// 切 happy-dom 才覆盖得到 I9 / I10。本文件触及的 DOM 只有 window 事件 API。
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, type EffectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

let lastEventHandler:
  | ((ev: { type: 'event'; event_type: string; data: Record<string, unknown>; ts: string }) => void)
  | null = null;
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
  onDashboardEvent: (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => onDashboardEventMock(h),
}));

import { useDashboardInvalidation, AFFECTS_DASHBOARD_SIZE } from '../useDashboardInvalidation';
import { qk } from '@/composables/queries/keys';

// 25 个 AFFECTS_DASHBOARD 事件类型白名单（与 useDashboardInvalidation.ts 同源）
const AFFECTS_DASHBOARD_EVENTS: string[] = [
  'PART_TO_SHIP',
  'PART_TO_INSPECTION',
  'PART_TO_PROCESS',
  'BATCH_TO_SHIP',
  'BATCH_TO_INSPECTION',
  'PART_SOFT_DELETED',
  'PART_DELIVERED',
  'PART_BATCH_SPLIT',
  'PART_BATCH_CANCELLED',
  'PART_SCAN_INSPECT_PASSED',
  'PART_SCAN_INSPECT_FAILED',
  'PART_BATCH_WITH_PDFS_CREATED',
  'PART_PICKED_UP',
  'WORKER_SCAN_RETURNED',
  'WORKER_SCAN_INSPECTED',
  'WORKER_POOL_REFILL_DONE',
  'WORKER_POOL_EMPTY',
  'WORKER_POOL_ADMIN_REMOVED',
  'WORKER_POOL_AUTO_ALLOCATE_DONE',
  'ASSEMBLY_CREATED',
  'ASSEMBLY_DELETED',
  'ASSEMBLY_CANCELLED',
  'ASSEMBLY_UPDATED',
  'PART_FORCE_COMPLETED',
  'ASSEMBLY_FORCE_COMPLETED',
];

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 2026-10-02：本文件所有用例创建的 effectScope 统一记账。
 *
 *  每个 scope 都会注册两处订阅：eventSubs 里的 WS 事件 handler + window 上的
 *  'dashboard:full-refetch' listener（均走 tryOnScopeDispose 摘除）。用例把
 *  `scope.stop()` 写在末尾的 `expect()` 之后，一旦断言失败它就不会执行 ⇒ 订阅泄漏到
 *  后续用例，把「一个真实失败」放大成「后续用例计数对不上」的**级联假失败**，掩盖
 *  真实原因。这里由文件级 afterEach 兜底 stop 全部 scope：`EffectScope.stop()` 幂等，
 *  用例内显式 stop 不受影响、也不会重复摘除。 */
const activeScopes = new Set<EffectScope>();

/** 取代裸 `effectScope()`：建 scope 并登记，供 afterEach 统一清理。 */
function makeScope(): EffectScope {
  const scope = effectScope();
  activeScopes.add(scope);
  return scope;
}

describe('useDashboardInvalidation — WS 事件 → debounce → invalidate（2026-09-29）', () => {
  beforeEach(() => {
    lastEventHandler = null;
    eventHandlers.clear();
    onDashboardEventMock.mockClear();
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    // 先摘订阅（stop 幂等，重复调用安全），再拆 queryClient
    for (const scope of Array.from(activeScopes)) {
      activeScopes.delete(scope);
      scope.stop();
    }
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.useRealTimers();
  });

  it('I1：AFFECTS_DASHBOARD 集合大小为 25（与 useDashboardInvalidation 同源）', () => {
    expect(AFFECTS_DASHBOARD_SIZE).toBe(25);
    expect(AFFECTS_DASHBOARD_EVENTS).toHaveLength(25);
  });

  it('I2：AFFECTS_DASHBOARD 内事件触发 invalidate', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
    });
    expect(lastEventHandler).not.toBeNull();
    invalidateSpy.mockClear();

    lastEventHandler!({
      type: 'event',
      event_type: 'PART_TO_SHIP',
      data: {},
      ts: '2026-09-29T10:00:00+08:00',
    });
    // 500ms 防抖窗口内未 invalidate
    expect(invalidateSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshotPrefix });
    scope.stop();
  });

  it('I3：连续 5 个 AFFECTS_DASHBOARD 事件 → debounce 500ms 内合并为 1 次 invalidate', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardUpcomingPrefix));
    });
    invalidateSpy.mockClear();

    for (let i = 0; i < 5; i++) {
      lastEventHandler!({
        type: 'event',
        event_type: AFFECTS_DASHBOARD_EVENTS[i]!,
        data: {},
        ts: 'x',
      });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(invalidateSpy).not.toHaveBeenCalled();
    // 推进到 last event 后 500ms（trailing edge）→ 1 次 invalidate
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('I4：maxWait 1500ms —— 持续超过 1500ms 强制 flush invalidate', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
    });
    invalidateSpy.mockClear();

    // 持续触发事件超过 1500ms（每次间隔 100ms，15 次 = 1500ms）
    for (let i = 0; i < 15; i++) {
      lastEventHandler!({
        type: 'event',
        event_type: 'PART_TO_SHIP',
        data: {},
        ts: 'x',
      });
      await vi.advanceTimersByTimeAsync(100);
    }
    // 1500ms 内肯定已经 flush 至少一次（maxWait 1500 触发）
    expect(invalidateSpy).toHaveBeenCalled();
    scope.stop();
  });

  it('I5：DELIVERY_NOTE_CREATED 不在 AFFECTS_DASHBOARD → 不触发 invalidate', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
    });
    invalidateSpy.mockClear();

    lastEventHandler!({
      type: 'event',
      event_type: 'DELIVERY_NOTE_CREATED',
      data: {},
      ts: 'x',
    });
    // 推进超过 500ms + maxWait 1500ms 仍不应触发 refetch
    await vi.advanceTimersByTimeAsync(2000);
    expect(invalidateSpy).not.toHaveBeenCalled();
    scope.stop();
  });

  it('I6：传 QueryKey[] → 遍历每个 key 各 invalidate 一次', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() =>
        useDashboardInvalidation([qk.dashboardSnapshotPrefix, qk.dashboardUpcomingPrefix]),
      );
    });
    invalidateSpy.mockClear();

    lastEventHandler!({
      type: 'event',
      event_type: 'PART_TO_SHIP',
      data: {},
      ts: 'x',
    });
    await vi.advanceTimersByTimeAsync(500);
    // 两次 invalidate（dashboardSnapshotPrefix + dashboardUpcomingPrefix）
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshotPrefix });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardUpcomingPrefix });
    scope.stop();
  });

  it('I7：25 个 AFFECTS_DASHBOARD 事件全部触发 invalidate（白名单回归保护）', async () => {
    vi.useFakeTimers();
    for (const evType of AFFECTS_DASHBOARD_EVENTS) {
      const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
      const scope = makeScope();
      scope.run(() => {
        testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
      });
      invalidateSpy.mockClear();

      lastEventHandler!({
        type: 'event',
        event_type: evType,
        data: {},
        ts: 'x',
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(invalidateSpy, `event ${evType} should trigger invalidate`).toHaveBeenCalled();
      scope.stop();
      vi.useFakeTimers();
    }
  });

  it('I8：scope.stop() → offDashboardEvent 触发 → handler Set 清零', () => {
    for (let i = 0; i < 5; i++) {
      const scope = makeScope();
      scope.run(() => {
        testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
      });
      expect(eventHandlers.size).toBe(1);
      scope.stop();
      expect(eventHandlers.size).toBe(0);
    }
    expect(eventHandlers.size).toBe(0);
    expect(onDashboardEventMock).toHaveBeenCalledTimes(5);
  });

  // ==========================================================================
  // I9 / I10：4003「慢消费方」全量重取接入点（2026-10-02 新增）
  //
  // 与 I2~I4 的关键差别是**不防抖**：4003 是后端明确告知「广播队列溢出，永久丢了
  // n 条事件」，重连补不回来（重连后的首帧 snapshot 在 api/dashboard.ts 里被显式
  // no-op 丢弃），所以每多等 500ms 都在展示已知过期的数据。
  // ==========================================================================

  it('I9：window 事件 dashboard:full-refetch → 立即 invalidate（0ms，不等 500ms 防抖）', () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
    });
    invalidateSpy.mockClear();

    window.dispatchEvent(
      new CustomEvent('dashboard:full-refetch', { detail: { code: 4003, reason: 'lagged' } }),
    );

    // 同步就触发 —— 若误走 debouncedInvalidate，这里会是 0 次
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshotPrefix });
    scope.stop();
  });

  it('I9b：多 key 形态 → 全量重取时逐 key 各 invalidate 一次', () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() =>
        useDashboardInvalidation([qk.dashboardSnapshotPrefix, qk.dashboardUpcomingPrefix]),
      );
    });
    invalidateSpy.mockClear();

    window.dispatchEvent(new CustomEvent('dashboard:full-refetch', { detail: { code: 4003 } }));
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshotPrefix });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardUpcomingPrefix });
    scope.stop();
  });

  it('I10：scope.stop() → dashboard:full-refetch listener 摘除（unmount 后不再失效）', () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    const scope = makeScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshotPrefix));
    });
    // 挂载期间收得到
    window.dispatchEvent(new CustomEvent('dashboard:full-refetch', { detail: { code: 4003 } }));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    scope.stop();
    invalidateSpy.mockClear();
    // 卸载后不该再收（否则每次进 /dashboard 累加一个永不清理的 handler）
    window.dispatchEvent(new CustomEvent('dashboard:full-refetch', { detail: { code: 4003 } }));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
