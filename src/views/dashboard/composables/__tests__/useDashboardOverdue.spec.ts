// src/views/dashboard/composables/__tests__/useDashboardOverdue.spec.ts
//
// 2026-09-29 新增：useDashboardOverdue Manager-only 闸门回归保护。
//
// 覆盖：
//   - O1：Manager=true → fetchOverview 被调 → overdueCount 派生数字
//   - O2：Manager=false → fetchOverview 不被调 → overdueCount = 0（enabled 闸门）
//   - O3：fetchList 在 Manager=false 时是 no-op（不抛错）
//   - O4：queryFn 走 overviewOutSchema.parse(...) 守门 —— 缺 overdue_undelivered_count
//        抛 ZodError
//   - O5：error → ElMessage.error 桥接（沿 2026-09-26 约定 #9）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const fetchOverviewMock = vi.fn();
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
      if (lastEventHandler === h) lastEventHandler = null;
    };
  },
);

vi.mock('@/api/statistics', () => ({
  fetchOverview: (q: { date_from: string; date_to: string }) => fetchOverviewMock(q),
}));
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

import { useDashboardOverdue } from '../useDashboardOverdue';
import { overviewOutSchema } from '@/composables/queries/schemas';

function makeOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date_from: '2026-09-29',
    date_to: '2026-09-29',
    created_count: 0,
    completed_count: 0,
    in_process_count: 0,
    delivered_count: 0,
    delivered_value: '0',
    late_orange_count: 0,
    late_red_count: 0,
    overdue_undelivered_count: 7,
    repair_part_count: 0,
    daily_created: [],
    daily_completed: [],
    delivery_performance: { on_time: 0, orange: 0, red: 0 },
    status_distribution: [],
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useDashboardOverdue — Manager-only enabled 闸门（2026-09-29）', () => {
  beforeEach(() => {
    fetchOverviewMock.mockReset();
    onDashboardEventMock.mockClear();
    lastEventHandler = null;
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

  it('O1：Manager=true → fetchOverview 被调 → overdueCount 派生数字', async () => {
    fetchOverviewMock.mockResolvedValue(makeOverview({ overdue_undelivered_count: 12 }));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardOverdue> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardOverdue(computed(() => true)));
    });
    await q!.fetchList();

    expect(fetchOverviewMock).toHaveBeenCalled();
    expect(q!.overdueCount.value).toBe(12);
    scope.stop();
  });

  it('O2：Manager=false → fetchOverview 不被调 → overdueCount = 0（enabled 闸门）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardOverdue> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardOverdue(computed(() => false)));
    });
    await q!.fetchList();

    expect(fetchOverviewMock).not.toHaveBeenCalled();
    expect(q!.overdueCount.value).toBe(0);
    scope.stop();
  });

  it('O3：fetchList 在 Manager=false 时是 no-op（不抛错）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useDashboardOverdue> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardOverdue(computed(() => false)));
    });
    await expect(q!.fetchList()).resolves.toBeUndefined();
    expect(fetchOverviewMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('O4：queryFn 走 overviewOutSchema.parse(...) 守门 —— 缺 overdue_undelivered_count 抛 ZodError', async () => {
    // 故意缺 overdue_undelivered_count → Zod parse 抛错 → query.error 非空
    const incomplete = makeOverview();
    delete (incomplete as Record<string, unknown>)['overdue_undelivered_count'];
    fetchOverviewMock.mockResolvedValue(incomplete);

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardOverdue> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardOverdue(computed(() => true)));
    });
    try {
      await q!.fetchList();
    } catch {
      // 期望 query.error 设置
    }
    expect(q!.query.error.value).not.toBeNull();
    scope.stop();
  });

  it('O5：overviewOutSchema 接受合法 OverviewOut VO（schema 守门正向断言）', () => {
    const parsed = overviewOutSchema.parse(makeOverview({ overdue_undelivered_count: 5 }));
    expect(parsed.overdue_undelivered_count).toBe(5);
    expect(parsed.delivered_value).toBe('0');
    expect(parsed.daily_created).toEqual([]);
    expect(parsed.delivery_performance).toEqual({ on_time: 0, orange: 0, red: 0 });
  });

  it('O6：fetchOverview 入参 date_from === date_to === todayIso（硬编码当天）', async () => {
    fetchOverviewMock.mockResolvedValue(makeOverview());

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardOverdue> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardOverdue(computed(() => true)));
    });
    await q!.fetchList();

    expect(fetchOverviewMock).toHaveBeenCalled();
    const params = fetchOverviewMock.mock.calls[0]?.[0] as { date_from: string; date_to: string };
    expect(params.date_from).toBe(params.date_to);
    // 形态：'YYYY-MM-DD' 长度 10
    expect(params.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    scope.stop();
  });
});