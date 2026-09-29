// src/views/dashboard/composables/__tests__/useDashboardInvalidation.spec.ts
//
// 2026-09-29 新增：useDashboardInvalidation WS 事件 → invalidate 回归保护。
//
// 覆盖：
//   - I1：22 个 AFFECTS_DASHBOARD 事件命中 → 触发 debounced invalidate
//   - I2：连续 5 个 AFFECTS_DASHBOARD 事件 → debounce 500ms 内合并 → 1 次 invalidate
//   - I3：maxWait 1500ms flush —— 持续超过 1500ms 必须强制 invalidate
//   - I4：非 AFFECTS_DASHBOARD 事件（如 DELIVERY_NOTE_CREATED）不触发 invalidate
//   - I5：component unmount → offDashboardEvent 触发 → handler Set 清零（review N1 guard）
//   - I6：传单个 QueryKey → 单次 invalidateQueries({ queryKey: key })
//   - I7：传 QueryKey[] → 遍历每个 key 各 invalidate 一次

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
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

// 22 个 AFFECTS_DASHBOARD 事件类型白名单（与 useDashboardInvalidation.ts 同源）
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
];

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

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
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.useRealTimers();
  });

  it('I1：AFFECTS_DASHBOARD 集合大小为 23（与方案 §WS 失效联动对齐）', () => {
    expect(AFFECTS_DASHBOARD_SIZE).toBe(23);
    expect(AFFECTS_DASHBOARD_EVENTS).toHaveLength(23);
  });

  it('I2：AFFECTS_DASHBOARD 内事件触发 invalidate', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshot));
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshot });
    scope.stop();
  });

  it('I3：连续 5 个 AFFECTS_DASHBOARD 事件 → debounce 500ms 内合并为 1 次 invalidate', async () => {
    vi.useFakeTimers();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardUrgentList));
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
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshot));
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
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshot));
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
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() =>
        useDashboardInvalidation([qk.dashboardSnapshot, qk.dashboardUrgentList]),
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
    // 两次 invalidate（dashboardSnapshot + dashboardUrgentList）
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshot });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardUrgentList });
    scope.stop();
  });

  it('I7：22 个 AFFECTS_DASHBOARD 事件全部触发 invalidate（白名单回归保护）', async () => {
    vi.useFakeTimers();
    for (const evType of AFFECTS_DASHBOARD_EVENTS) {
      const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
      const scope = effectScope();
      scope.run(() => {
        testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshot));
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

  it('I8：scope.stop() → offDashboardEvent 触发 → handler Set 清零（review N1 guard）', () => {
    for (let i = 0; i < 5; i++) {
      const scope = effectScope();
      scope.run(() => {
        testApp.runWithContext(() => useDashboardInvalidation(qk.dashboardSnapshot));
      });
      expect(eventHandlers.size).toBe(1);
      scope.stop();
      expect(eventHandlers.size).toBe(0);
    }
    expect(eventHandlers.size).toBe(0);
    expect(onDashboardEventMock).toHaveBeenCalledTimes(5);
  });
});