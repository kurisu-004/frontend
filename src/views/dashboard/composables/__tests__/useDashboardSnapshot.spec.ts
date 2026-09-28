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
let lastEventHandler:
  | ((ev: { type: 'event'; event_type: string; data: Record<string, unknown>; ts: string }) => void)
  | null = null;
const onDashboardEventMock = vi.fn(
  (
    h: (ev: {
      type: 'event';
      event_type: string;
      data: Record<string, unknown>;
      ts: string;
    }) => void,
  ) => {
    lastEventHandler = h;
    return () => {
      lastEventHandler = null;
    };
  },
);

vi.mock('@/api/dashboard', () => ({
  fetchDashboardSnapshot: () => fetchSnapshotMock(),
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
      q = testApp.runWithContext(() => useDashboardSnapshot());
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
      q = testApp.runWithContext(() => useDashboardSnapshot());
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
      q = testApp.runWithContext(() => useDashboardSnapshot());
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
      q = testApp.runWithContext(() => useDashboardSnapshot());
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
      q = testApp.runWithContext(() => useDashboardSnapshot());
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
});
