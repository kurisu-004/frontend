// src/views/dashboard/composables/__tests__/useDashboardSnapshot.spec.ts
//
// dashboard 大屏快照 composable 行为回归保护。
//
// 数据流：
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
//   - U7：scope 停止后 onDashboardEvent handler 从 Set 清零（不累加订阅）；
//   - U8：queryKey 是**无维度常量键** —— 快照不再承载口径，交期分桶在独立 query；
//   - U9：WS 事件失效走**前缀键**（qk.dashboardSnapshotPrefix）。

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

// dashboard API 模块：fetchDashboardSnapshot + onDashboardEvent。
// 测试中需要拿到 onDashboardEvent 注册的 handler 列表来手动派事件。
const fetchSnapshotMock = vi.fn();
// 跟踪所有注册的 handler 用于回归保护。useDashboardSnapshot 必须捕获 off +
// tryOnScopeDispose，否则多次 mount/unmount 会累加永不清理的 handler。
// 单变量 lastEventHandler 无法表达「多次注册」，改用 Set 记录所有未清理的 handler，
// U7 用例断言 scope.stop() 后 Set 清零。
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
  // 无参调用：端点不接受任何 query 参数（2026-10-07 起 fetchDashboardSnapshot 去掉
  // params 形参）。mock 保留一个 args 透传便于断言「真的没传参」。
  fetchDashboardSnapshot: (...args: unknown[]) => fetchSnapshotMock(...args),
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

function makeBaseSnapshot(): Record<string, unknown> {
  return {
    overdue_count: 12,
    in_inspection_count: 4,
    in_process: [
      {
        id: '180000000000001',
        batch_id: '190000000000001',
        serial_no: 'F1234',
        quantity: 20,
        is_urgent: false,
        current_holder_id: '170000000000001',
        worker_name: '张三',
      },
    ],
    system_delivery_orders: {
      urgent: [
        {
          id: '180000000000002',
          serial_no: 'F5678',
          name: '连杆总成左前',
          quantity: 100,
          status: 'IN_PROCESS',
          system_delivery_date: '2026-10-08',
          customer_name: '南海路厂区',
          is_urgent: true,
          delivered_quantity: 0,
        },
      ],
      partial: [],
    },
    ts: '2026-10-07T14:30:00.123+08:00',
  };
}

/** 造一个只差 ts 的 snapshot —— Zod 必填字段缺失，parse 必抛。 */
function makeSnapshotMissingTs(): Record<string, unknown> {
  const snapshot = makeBaseSnapshot();
  delete snapshot['ts'];
  return snapshot;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 在 effectScope 内实例化 composable，返回 query 与 scope（caller 负责 stop）。 */
function mountSnapshot() {
  const scope = effectScope();
  let q: ReturnType<typeof useDashboardSnapshot> | undefined;
  scope.run(() => {
    q = testApp.runWithContext(() => useDashboardSnapshot());
  });
  return { scope, query: q! };
}

describe('useDashboardSnapshot — HTTP 全量 + WS 事件 invalidate', () => {
  beforeEach(() => {
    fetchSnapshotMock.mockReset();
    onDashboardEventMock.mockClear();
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
    const { scope, query } = mountSnapshot();
    await query.refetch();

    expect(fetchSnapshotMock).toHaveBeenCalled();
    // 端点无 query 参数：一次参数都不许传。
    expect(fetchSnapshotMock).toHaveBeenCalledWith();
    const data = query.data.value;
    expect(data).not.toBeNull();
    expect(data?.overdue_count).toBe(12);
    expect(data?.in_inspection_count).toBe(4);
    expect(data?.in_process).toHaveLength(1);
    expect(data?.in_process[0]?.batch_id).toBe('190000000000001');
    expect(data?.system_delivery_orders.urgent).toHaveLength(1);
    expect(data?.system_delivery_orders.urgent[0]?.customer_name).toBe('南海路厂区');
    scope.stop();
  });

  it('U2：WS 事件触发 invalidate → refetch 被调', async () => {
    vi.useFakeTimers();
    const { scope, query } = mountSnapshot();
    await query.refetch();
    fetchSnapshotMock.mockClear();

    // 派一个影响 dashboard 的事件
    const handler = [...eventHandlers].at(-1);
    expect(handler).toBeDefined();
    handler!({
      type: 'event',
      event_type: 'PART_TO_SHIP',
      data: { part_id: '180000000000001' },
      ts: '2026-10-07T14:30:00.123+08:00',
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
    const { scope, query } = mountSnapshot();
    await query.refetch();
    fetchSnapshotMock.mockClear();

    const handler = [...eventHandlers].at(-1)!;
    // 500ms 内连续派 5 个事件（每个间隔 50ms，200ms 总跨度，远小于 500ms 防抖窗口）
    handler({ type: 'event', event_type: 'PART_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    handler({ type: 'event', event_type: 'PART_TO_INSPECTION', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    handler({ type: 'event', event_type: 'PART_TO_PROCESS', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    handler({ type: 'event', event_type: 'BATCH_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(50);
    handler({ type: 'event', event_type: 'BATCH_TO_INSPECTION', data: {}, ts: 'x' });

    // 防抖 500ms 未到，refetch 仍 0 次
    expect(fetchSnapshotMock).not.toHaveBeenCalled();

    // 推进到 last event 之后的 500ms（trailing edge），触发 1 次 refetch
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSnapshotMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('U4：事件集过滤 —— DELIVERY_NOTE_CREATED 不在 AFFECTS_DASHBOARD → 不触发 invalidate', async () => {
    vi.useFakeTimers();
    const { scope, query } = mountSnapshot();
    await query.refetch();
    fetchSnapshotMock.mockClear();

    // DELIVERY_NOTE_CREATED / DELIVERY_NOTE_PARTS_ADDED 等不影响 dashboard 大屏数据
    const handler = [...eventHandlers].at(-1)!;
    handler({ type: 'event', event_type: 'DELIVERY_NOTE_CREATED', data: {}, ts: 'x' });

    // 推进超过 500ms + maxWait 1500ms 仍不应触发 refetch
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('U5：Zod parse 失败 → query.error 非空', async () => {
    // 后端返回缺 ts（必填字段）→ Zod parse 抛 ZodError → query.error 设置
    fetchSnapshotMock.mockResolvedValue(makeSnapshotMissingTs());

    const { scope, query } = mountSnapshot();

    // 等待 refetch + parse 失败（vue-query 在 microtask 链里抛）
    try {
      await query.refetch();
    } catch {
      // 期望抛错
    }

    expect(query.error.value).not.toBeNull();
    expect(query.data.value).toBeUndefined();
    scope.stop();
  });

  it('U7：多次 mount/unmount 不累加 onDashboardEvent handler', () => {
    // 迁到 useDashboardSnapshot 时曾漏掉 off 清理，每次进入 /dashboard 都往 eventSubs
    // Set 累加一个永不清理的 handler，闭包持有的 debouncedInvalidate / qc / query
    // 永远无法 GC。本用例是清理逻辑的回归保护：5 轮 mount/unmount 后 handler Set 必须
    // 清零，否则就是漏了清理。
    for (let i = 0; i < 5; i++) {
      const { scope } = mountSnapshot();
      // mount 后应该正好 1 个活跃 handler（本次 scope 注册的那个）
      expect(eventHandlers.size).toBe(1);
      scope.stop();
      // unmount 后 tryOnScopeDispose 触发 off → handler Set 清零
      expect(eventHandlers.size).toBe(0);
    }

    expect(eventHandlers.size).toBe(0);
    expect(onDashboardEventMock).toHaveBeenCalledTimes(5);
  });

  it('U8：queryKey 是无维度常量键 = ["dashboard","snapshot"]', async () => {
    const { scope } = mountSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const cache = testQueryClient.getQueryCache();
    const found = cache.find({ queryKey: qk.dashboardSnapshot() });
    expect(found).toBeTruthy();
    // 键严格两层：没有 basis 维度 —— 交期分桶已拆到独立的 dashboardUpcoming query，
    // 快照本身不承载口径，后端也不接受任何 query 参数。
    expect(found?.queryKey).toEqual(['dashboard', 'snapshot']);
    scope.stop();
  });

  it('U9：WS 事件失效走前缀键 qk.dashboardSnapshotPrefix', async () => {
    vi.useFakeTimers();
    const { scope } = mountSnapshot();
    await vi.advanceTimersByTimeAsync(30);

    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    fetchSnapshotMock.mockClear();

    const handler = [...eventHandlers].at(-1)!;
    handler({ type: 'event', event_type: 'PART_TO_SHIP', data: {}, ts: 'x' });
    await vi.advanceTimersByTimeAsync(500);

    // 走前缀而非「当前那条精确键」是本域约定：即便当前是无维度键，前缀键也让后续
    // 给快照再加维度时不至于静默漏失效。
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.dashboardSnapshotPrefix });
    expect(fetchSnapshotMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
