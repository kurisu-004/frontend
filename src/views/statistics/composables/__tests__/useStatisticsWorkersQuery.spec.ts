// src/views/statistics/composables/__tests__/useStatisticsWorkersQuery.spec.ts
//
// 2026-10-12 新新增：工人贡献度列表主查询（tab2 工人表 + tab3 工人下拉共用）。
//
// ⚠️ **W3 是本 spec 存在的理由，也是本域唯一能挡住「守门失效」的防线**：
// api 层按 CLAUDE.md「queryFn Zod 守门」只发请求、不做 parse（parse 返回深拷贝，
// 在 api 层再走一遍等于每屏数据被校验并克隆两遍），所以一旦有人把 queryFn 里的
// `workerStatsListOutSchema.parse(...)` 整段删掉，api 层那份负向守卫
// （`src/api/__tests__/statistics.spec.ts` 断言 api 不 parse）**照样全绿**，
// 而线上是「后端漏发一个字段 → 界面照常渲染那一列的 undefined」。只有在这里 mock 一份
// **缺必填字段的坏响应**、断言它进不了 data，才能把这个洞补上。
//
// 覆盖：
//   - W1：queryKey = ['statistics','workers',params]，键取自 keys.ts 工厂；
//   - W2：params 为 null ⇒ enabled=false，零网络请求（后端两个日期参数是必填 NaiveDate）；
//   - W3：坏响应（缺 effective_minutes）⇒ query.error 非空且 data 不落值（parse 守门在
//     返回路径上）；
//   - W4：queryFn 从 queryKey 读 params（reactive params 范式，不闭包捕获 stale 值）；
//   - W5：切日期换键自动 refetch。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick, ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { MaybeRefOrGetter } from 'vue';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const fetchWorkerStatsMock = vi.fn();

vi.mock('@/api/statistics', () => ({
  fetchWorkerStats: (params: unknown) => fetchWorkerStatsMock(params),
}));

import { useStatisticsWorkersQuery } from '../useStatisticsWorkersQuery';
import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { StatisticsQuery } from '@/types/statistics';

const RANGE: StatisticsQuery = { date_from: '2026-10-01', date_to: '2026-10-12' };

function makeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker_id: '1900000000000000001',
    worker_name: '张三',
    badge_code: 'A001',
    work_type_id: '1900000000000000010',
    work_type_name: '铣工',
    is_active: true,
    pickup_count: 37,
    pickup_quantity: 41,
    participated_part_count: 18,
    contribution_pct: 23.5,
    effective_minutes: 150,
    worked_process_count: 4,
    worked_batch_count: 22,
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountWorkers(params: MaybeRefOrGetter<StatisticsQuery | null>) {
  const scope = effectScope();
  let c: ReturnType<typeof useStatisticsWorkersQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() => useStatisticsWorkersQuery(params));
  });
  return { scope, comp: c! };
}

describe('useStatisticsWorkersQuery — 工人贡献度列表（2026-10-12）', () => {
  beforeEach(() => {
    fetchWorkerStatsMock.mockReset();
    fetchWorkerStatsMock.mockResolvedValue({ items: [makeWorker()] });

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

  it('W1：queryKey = ["statistics","workers",params]（键一律取自 keys.ts 工厂）', async () => {
    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope } = mountWorkers(range);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const found = testQueryClient.getQueryCache().find({ queryKey: qk.statisticsWorkers(RANGE) });
    expect(found).toBeTruthy();
    expect(found?.queryKey).toEqual(['statistics', 'workers', RANGE]);
    scope.stop();
  });

  it('W2：params 为 null ⇒ enabled=false，零网络请求', async () => {
    const range = ref<StatisticsQuery | null>(null);
    const { scope } = mountWorkers(range);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fetchWorkerStatsMock).not.toHaveBeenCalled();
    // 补一个占位键，验证「未选日期」不是异常态而是「不发请求」。
    expect(
      testQueryClient.getQueryCache().find({ queryKey: qk.statisticsWorkers(null) }),
    ).toBeTruthy();
    scope.stop();
  });

  // ⚠️ 本 spec 的核心断言：把 queryFn 里的 `.parse()` 整段删掉时，本条立刻红，
  // 而 api 层的负向守卫（断言 api 不 parse）仍然是绿的 —— 守门只能在这里被守住。
  it('W3：坏响应（缺 effective_minutes）⇒ query.error 非空且数据不落到 data', async () => {
    const broken = makeWorker();
    delete broken['effective_minutes'];
    fetchWorkerStatsMock.mockResolvedValue({ items: [broken] });

    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope, comp } = mountWorkers(range);
    try {
      await comp.fetchList();
    } catch {
      // v5 的 refetch 默认不抛（返回 result），这里只是兜住「抛了也别炸测试」
    }

    expect(comp.query.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    await nextTick();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('W4：queryFn 从 queryKey 读 params 下发请求（reactive params 范式）', async () => {
    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope, comp } = mountWorkers(range);
    await comp.fetchList();

    expect(fetchWorkerStatsMock).toHaveBeenCalledWith(RANGE);
    expect(comp.data.value?.items[0]?.effective_minutes).toBe(150);
    expect(comp.data.value?.items[0]?.worker_id).toBe('1900000000000000001');
    scope.stop();
  });

  it('W5：切日期换键并自动 refetch（不依赖显式 refetch）', async () => {
    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope } = mountWorkers(range);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fetchWorkerStatsMock.mockClear();

    const next: StatisticsQuery = { date_from: '2026-09-01', date_to: '2026-09-30' };
    range.value = next;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fetchWorkerStatsMock).toHaveBeenCalledWith(next);
    scope.stop();
  });
});
