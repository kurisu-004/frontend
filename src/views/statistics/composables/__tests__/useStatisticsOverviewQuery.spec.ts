// src/views/statistics/composables/__tests__/useStatisticsOverviewQuery.spec.ts
//
// 2026-10-12 新增：车间生产总览主查询的**冒烟**用例。
//
// 本 hook 的完整契约（queryKey 形态 / params 闸门 / reactive params）与
// `useStatisticsWorkersQuery.spec.ts` 同款，不重复铺一遍；这里只守总览特有的两点：
//   - O1：queryKey = ['statistics','overview',params]（tab1 与 tab2/3 的三把键互不串扰）；
//   - O2：坏响应（缺一个必填的图表段）⇒ error 非空 —— 冒烟守住「parse 接在返回路径上」
//     这条不变式，防止将来有人「顺手简化」时把守门摘掉。

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

const fetchOverviewMock = vi.fn();

vi.mock('@/api/statistics', () => ({
  fetchOverview: (params: unknown) => fetchOverviewMock(params),
}));

import { useStatisticsOverviewQuery } from '../useStatisticsOverviewQuery';
import { qk } from '@/composables/queries/keys';
import type { StatisticsQuery } from '@/types/statistics';

const RANGE: StatisticsQuery = { date_from: '2026-10-01', date_to: '2026-10-12' };

function makeOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date_from: '2026-10-01',
    date_to: '2026-10-12',
    created_count: 120,
    completed_count: 96,
    in_process_count: 24,
    delivered_count: 80,
    delivered_value: '153800.50',
    late_orange_count: 3,
    late_red_count: 1,
    overdue_undelivered_count: 2,
    repair_part_count: 4,
    daily_created: [{ date: '2026-10-01', count: 12 }],
    daily_completed: [{ date: '2026-10-01', count: 9 }],
    delivery_performance: { on_time: 70, orange: 8, red: 2 },
    status_distribution: [{ status_value: 'IN_PROCESS', count: 24 }],
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useStatisticsOverviewQuery — 车间生产总览（2026-10-12）', () => {
  beforeEach(() => {
    fetchOverviewMock.mockReset();
    fetchOverviewMock.mockResolvedValue(makeOverview());

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
  });

  it('O1：queryKey = ["statistics","overview",params]，params 从 queryKey 读出发给 api', async () => {
    const scope = effectScope();
    const range = ref<StatisticsQuery | null>(RANGE);
    let comp!: ReturnType<typeof useStatisticsOverviewQuery>;
    scope.run(() => {
      comp = testApp.runWithContext(() => useStatisticsOverviewQuery(range));
    });
    await comp.fetchList();

    expect(fetchOverviewMock).toHaveBeenCalledWith(RANGE);
    expect(
      testQueryClient.getQueryCache().find({ queryKey: qk.statisticsOverview(RANGE) })?.queryKey,
    ).toEqual(['statistics', 'overview', RANGE]);
    expect(comp.data.value?.created_count).toBe(120);
    scope.stop();
  });

  it('O2：坏响应（缺 daily_completed）⇒ error 非空、数据不落到 data', async () => {
    const broken = makeOverview();
    delete broken['daily_completed'];
    fetchOverviewMock.mockResolvedValue(broken);

    const scope = effectScope();
    const range = ref<StatisticsQuery | null>(RANGE);
    let comp!: ReturnType<typeof useStatisticsOverviewQuery>;
    scope.run(() => {
      comp = testApp.runWithContext(() => useStatisticsOverviewQuery(range));
    });
    try {
      await comp.fetchList();
    } catch {
      // v5 的 refetch 默认不抛，这里兜住「抛了也别炸测试」
    }

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    scope.stop();
  });
});
