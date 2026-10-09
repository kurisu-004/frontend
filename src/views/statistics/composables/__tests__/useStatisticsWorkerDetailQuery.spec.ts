// src/views/statistics/composables/__tests__/useStatisticsWorkerDetailQuery.spec.ts
//
// 2026-10-12 新增：单工人详情主查询（tab3）。
//
// ⚠️ **D3 是本 spec 存在的理由**：另两个 hook 都有「坏响应进不了 data」的用例，
// 只有这个 hook 没有 ⇒ 把 `workerDetailOutSchema.parse(...)` 整段从 queryFn 删掉时，
// api 层那份负向守卫（`src/api/__tests__/statistics.spec.ts` 断言 api 不 parse）
// 照样全绿，而线上是「后端漏发 `process_breakdown` → 界面把按工序表渲染成空」。
// CLAUDE.md「statistics 域的 schema 归位」一节要求这两个守卫**成对存在**。
//
// 覆盖：
//   - D1：queryKey = ['statistics','worker-detail',workerId,params]，键取自 keys.ts
//     工厂（workerId 走独立键位，不塞进 params）；
//   - D2：workerId 为 null / 空串 ⇒ enabled=false，零网络请求；
//   - D3：坏响应（缺 effective_minutes 或缺 process_breakdown）⇒ query.error 非空
//     且 data 不落值（parse 守门在返回路径上）；
//   - D4：queryFn 从 queryKey 读 workerId + params（reactive 入参范式）；
//   - D5：切工人换整条 queryKey 自动 refetch（不复用上一个工人的缓存）。

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

const fetchWorkerDetailMock = vi.fn();

vi.mock('@/api/statistics', () => ({
  fetchWorkerDetail: (workerId: string, params: unknown) =>
    fetchWorkerDetailMock(workerId, params),
}));

import { useStatisticsWorkerDetailQuery } from '../useStatisticsWorkerDetailQuery';
import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { StatisticsQuery } from '@/types/statistics';

const RANGE: StatisticsQuery = { date_from: '2026-10-01', date_to: '2026-10-12' };
const WID = '1900000000000000001';

function makeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worker: {
      id: WID,
      name: '张三',
      badge_code: 'A001',
      work_type_name: '铣工',
      is_active: true,
    },
    pickup_count: 12,
    pickup_quantity: 30,
    participated_part_count: 7,
    return_count: 9,
    daily_pickups: [{ date: '2026-10-01', count: 4 }],
    parts: [
      {
        part_id: '1900000000000000002',
        serial_no: 'P-0001',
        name: '法兰盘',
        drawing_no: 'DWG-1',
        status: 'IN_PROCESS',
        pickup_count: 3,
        last_pickup_at: '2026-10-05T08:00:00',
      },
    ],
    effective_minutes: 240,
    process_breakdown: [
      { process_id: '1900000000000000010', process_name: '铣削', step_count: 5, effective_minutes: 200 },
      { process_id: null, process_name: '(已删除)', step_count: 1, effective_minutes: 40 },
    ],
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountDetail(
  workerId: MaybeRefOrGetter<string | null | undefined>,
  params: MaybeRefOrGetter<StatisticsQuery | null>,
) {
  const scope = effectScope();
  let c: ReturnType<typeof useStatisticsWorkerDetailQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() => useStatisticsWorkerDetailQuery(workerId, params));
  });
  return { scope, comp: c! };
}

describe('useStatisticsWorkerDetailQuery — 单工人详情（2026-10-12）', () => {
  beforeEach(() => {
    fetchWorkerDetailMock.mockReset();
    fetchWorkerDetailMock.mockResolvedValue(makeDetail());

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

  it('D1：queryKey = ["statistics","worker-detail",workerId,params]（workerId 走独立键位）', async () => {
    const id = ref<string | null>(WID);
    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope } = mountDetail(id, range);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const found = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.statisticsWorkerDetail(WID, RANGE) });
    expect(found).toBeTruthy();
    expect(found?.queryKey).toEqual(['statistics', 'worker-detail', WID, RANGE]);
    scope.stop();
  });

  it('D2：workerId 为 null / 空串 ⇒ enabled=false，零网络请求', async () => {
    for (const badId of [null, '', undefined]) {
      const range = ref<StatisticsQuery | null>(RANGE);
      const { scope } = mountDetail(ref<string | null | undefined>(badId), range);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchWorkerDetailMock).not.toHaveBeenCalled();
      scope.stop();
    }
    fetchWorkerDetailMock.mockClear();
  });

  // ⚠️ 本 spec 的核心断言：把 queryFn 里的 `.parse()` 整段删掉时，本条立刻红，
  // 而 api 层的负向守卫（断言 api 不 parse）仍然是绿的 —— 守门只能在这里被守住。
  it.each([
    ['缺 effective_minutes', 'effective_minutes'],
    ['缺 process_breakdown', 'process_breakdown'],
  ])('D3：坏响应（%s）⇒ query.error 非空且数据不落到 data', async (_label, field) => {
    const broken = makeDetail();
    delete broken[field];
    fetchWorkerDetailMock.mockResolvedValue(broken);

    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope, comp } = mountDetail(ref<string | null>(WID), range);
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

  it('D4：queryFn 从 queryKey 读 workerId + params 下发请求（reactive 入参范式）', async () => {
    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope, comp } = mountDetail(ref<string | null>(WID), range);
    await comp.fetchList();

    expect(fetchWorkerDetailMock).toHaveBeenCalledWith(WID, RANGE);
    expect(comp.data.value?.effective_minutes).toBe(240);
    // 服务端已排序，消费侧不重排 —— breakdown 原序透传
    expect(comp.data.value?.process_breakdown.map((b) => b.process_name)).toEqual([
      '铣削',
      '(已删除)',
    ]);
    scope.stop();
  });

  it('D5：切工人换整条 queryKey 并自动 refetch（不复用上一个工人的缓存）', async () => {
    const id = ref<string | null>(WID);
    const range = ref<StatisticsQuery | null>(RANGE);
    const { scope } = mountDetail(id, range);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fetchWorkerDetailMock.mockClear();

    const other = '1900000000000000009';
    id.value = other;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fetchWorkerDetailMock).toHaveBeenCalledWith(other, RANGE);
    scope.stop();
  });
});