// src/views/dashboard/composables/__tests__/useDashboardUpcomingList.spec.ts
//
// 2026-09-30 新增：useDashboardUpcomingList reactive params + enabled 闸门 +
// Zod parse 守门回归保护（与 plan §2.7 对齐）。
//
// 覆盖：
//   - L1：queryKey 形态 — 含 ['dashboard','upcoming-list', { date, statuses, basis }] 三层
//   - L2：params=null 时 enabled=false，listUnionItems 不被调
//   - L3：params.statuses 空数组时 enabled=false（防御性）
//   - L4：成功路径走 partListResultSchema.parse(...) 守门
//   - L5：listUnionItems 入参硬编码 row_type='PART_FLAT' / sort_by / sort_dir / limit / offset
//   （2026-10-04 新增）L7：system 口径发 system_delivery_date_from/to +
//     sort_by='SYSTEM_DELIVERY_DATE'，且 planned 那组参数**根本不在请求里**；
//     L8：切 basis 换键自动 refetch
//   （2026-10-05 新增）L9：暴露 total（服务端匹配总数，与取回条数解耦）
//     L10：未落数据前 total 派生为 0

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

const listUnionItemsMock = vi.fn();
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

vi.mock('@/api/com/unionList', () => ({
  listUnionItems: (params: Record<string, unknown>) => listUnionItemsMock(params),
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

import { useDashboardUpcomingList } from '../useDashboardUpcomingList';
import { qk } from '@/composables/queries/keys';
import type { DeliveryBasis } from '@/types/dashboard';

function makeBasePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    version: 1,
    serial_no: 'SN-001',
    name: '零件甲',
    drawing_no: 'DWG-001',
    applicant_name: null,
    quantity: 10,
    unit_price: '0',
    total_price: '0',
    request_date: '2026-09-29',
    planned_delivery_date: '2026-10-01',
    is_urgent: false,
    status: 'PENDING',
    order_no: null,
    system_delivery_date: null,
    note: null,
    customer_name: null,
    l1_customer_name: null,
    location: null,
    has_cnc_program: false,
    row_type: 'PART',
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useDashboardUpcomingList — reactive params + enabled 闸门（2026-09-30）', () => {
  beforeEach(() => {
    listUnionItemsMock.mockReset();
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

  it('L1：queryKey 形态 = ["dashboard","upcoming-list",{date,statuses,basis}]', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });

    const params = ref<{
      date: string;
      statuses: ('PENDING' | 'PROGRAMMING')[];
      basis: DeliveryBasis;
    } | null>({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
      basis: 'planned',
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 直接通过 QueryClient cache 拉真实 queryKey 断言形态（不用 onDashboardEventMock
    // .toHaveBeenCalled 这种「WS 订阅挂上」的名实不符断言）
    const expectedKey = qk.dashboardUpcomingList({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
      basis: 'planned',
    });
    const cached = testQueryClient.getQueryCache().find({ queryKey: expectedKey });
    expect(cached).toBeTruthy();
    expect(cached?.queryKey).toEqual(expectedKey);
    // queryKey 必须严格三层：['dashboard', 'upcoming-list', { date, statuses, basis }]
    expect(cached?.queryKey).toHaveLength(3);
    expect(cached?.queryKey[0]).toBe('dashboard');
    expect(cached?.queryKey[1]).toBe('upcoming-list');
    expect(cached?.queryKey[2]).toEqual({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
      basis: 'planned',
    });
    scope.stop();
  });

  it('L2：params=null 时 enabled=false → listUnionItems 不被调', async () => {
    const params = ref<{ date: string; statuses: ('PENDING')[]; basis: DeliveryBasis } | null>(null);

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('L3：params.statuses.length === 0 时 enabled=false → listUnionItems 不被调', async () => {
    const params = ref<{ date: string; statuses: never[]; basis: DeliveryBasis } | null>({
      date: '2026-10-01',
      statuses: [],
      basis: 'planned',
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('L4：成功路径走 partListResultSchema.parse(...) 守门 — 缺 has_cnc_program 抛错', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [
        {
          // 故意缺 has_cnc_program
          id: '180000000000001',
          version: 1,
          serial_no: null,
          name: '零件甲',
          drawing_no: 'DWG-001',
          applicant_name: null,
          quantity: 10,
          unit_price: '0',
          total_price: '0',
          request_date: '2026-09-29',
          planned_delivery_date: '2026-10-01',
          is_urgent: false,
          status: 'PENDING',
          order_no: null,
          system_delivery_date: null,
          note: null,
          customer_name: null,
          l1_customer_name: null,
          location: null,
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    });

    const params = ref<{ date: string; statuses: ('PENDING')[]; basis: DeliveryBasis } | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUpcomingList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).toHaveBeenCalled();
    // 必须断言 query.error 被 ZodError 填充，否则缺字段时
    // partListResultSchema.parse 静默通过、整份守门失效。
    expect(q!.error.value).not.toBeNull();
    scope.stop();
  });

  it('L5：planned 口径入参 = row_type=PART_FLAT / sort_by=PLANNED_DELIVERY_DATE / limit=200', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });

    const params = ref<{
      date: string;
      statuses: ('INSPECTION' | 'READY_TO_SHIP')[];
      basis: DeliveryBasis;
    } | null>({
      date: '2026-10-03',
      statuses: ['INSPECTION', 'READY_TO_SHIP'],
      basis: 'planned',
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).toHaveBeenCalled();
    const args = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['row_type']).toBe('PART_FLAT');
    expect(args['sort_by']).toBe('PLANNED_DELIVERY_DATE');
    expect(args['sort_dir']).toBe('ASC');
    expect(args['limit']).toBe(200);
    expect(args['offset']).toBe(0);
    expect(args['planned_delivery_date_from']).toBe('2026-10-03');
    expect(args['planned_delivery_date_to']).toBe('2026-10-03');
    // planned 口径不得夹带 system 窗口参数（两组同时发会被后端 AND 成交集）
    expect(args).not.toHaveProperty('system_delivery_date_from');
    expect(args).not.toHaveProperty('system_delivery_date_to');
    expect((args['statuses'] as string[]).sort()).toEqual(['INSPECTION', 'READY_TO_SHIP'].sort());
    scope.stop();
  });

  it('L6：合法 1 件 part → rows.length === 1（正向断言守门）', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makeBasePart({ id: '180000000000099' })],
      total: 1,
      limit: 200,
      offset: 0,
    });

    const params = ref<{ date: string; statuses: ('PENDING')[]; basis: DeliveryBasis } | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUpcomingList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(q!.data.value).toHaveLength(1);
    expect(q!.data.value[0]?.id).toBe('180000000000099');
    scope.stop();
  });

  // ==========================================================================
  // 2026-10-04：交期统计口径（planned / system）下钻
  // ==========================================================================

  it('L7：system 口径发 system 窗口 + sort_by=SYSTEM_DELIVERY_DATE，且不夹带 planned 参数', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });

    const params = ref<{ date: string; statuses: ('PENDING')[]; basis: DeliveryBasis } | null>({
      date: '2026-10-05',
      statuses: ['PENDING'],
      basis: 'system',
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).toHaveBeenCalled();
    const args = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['system_delivery_date_from']).toBe('2026-10-05');
    expect(args['system_delivery_date_to']).toBe('2026-10-05');
    expect(args['sort_by']).toBe('SYSTEM_DELIVERY_DATE');
    // 关键断言：两组窗口参数互斥。若两组同时发，后端按 AND 取交集 → 抽屉恒空，
    // 而且这个 bug 表现为「点得到柱但列不出工单」，排查成本很高。
    expect(args).not.toHaveProperty('planned_delivery_date_from');
    expect(args).not.toHaveProperty('planned_delivery_date_to');
    // 两口径共用的字段不变（row_type 恒 PART_FLAT：行源 = t_part 全表行）
    expect(args['row_type']).toBe('PART_FLAT');
    expect(args['sort_dir']).toBe('ASC');
    expect(args['limit']).toBe(200);
    expect(args['offset']).toBe(0);
    scope.stop();
  });

  it('L8：切 basis → 换键自动 refetch，且两次请求的口径参数各归各位', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 });

    const params = ref<{ date: string; statuses: ('PENDING')[]; basis: DeliveryBasis } | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listUnionItemsMock).toHaveBeenCalledTimes(1);

    params.value = { ...params.value!, basis: 'system' };
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).toHaveBeenCalledTimes(2);
    const first = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const second = listUnionItemsMock.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(first['sort_by']).toBe('PLANNED_DELIVERY_DATE');
    expect(second['sort_by']).toBe('SYSTEM_DELIVERY_DATE');
    // 两条 cache identity 都在（键含 basis）
    const cache = testQueryClient.getQueryCache();
    expect(
      cache.find({
        queryKey: qk.dashboardUpcomingList({
          date: '2026-10-01',
          statuses: ['PENDING'],
          basis: 'planned',
        }),
      }),
    ).toBeTruthy();
    expect(
      cache.find({
        queryKey: qk.dashboardUpcomingList({
          date: '2026-10-01',
          statuses: ['PENDING'],
          basis: 'system',
        }),
      }),
    ).toBeTruthy();
    scope.stop();
  });

  // ==========================================================================
  // 2026-10-05：行源切 PART_FLAT + 暴露 total（头部件数不再拿 rows.length 顶替）
  // ==========================================================================

  it('L9：暴露 total —— 服务端匹配总数与取回条数解耦（9 件只回 2 条时 total 为 9）', async () => {
    // 请求 limit 与端点页长上限一致（200），rows.length 恒 ≤ 200；头部件数必须按
    // 服务端 total 渲染，否则条数触顶时谎报件数。
    listUnionItemsMock.mockResolvedValue({
      items: [makeBasePart({ id: '180000000000001' }), makeBasePart({ id: '180000000000002' })],
      total: 9,
      limit: 200,
      offset: 0,
    });

    const params = ref<{ date: string; statuses: 'PENDING'[]; basis: DeliveryBasis } | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
      basis: 'planned',
    });

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUpcomingList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(q!.data.value).toHaveLength(2);
    expect(q!.total.value).toBe(9);
    scope.stop();
  });

  it('L10：请求未落数据前 total 派生为 0（不返 undefined，抽屉头不显示 NaN）', async () => {
    const params = ref<{ date: string; statuses: 'PENDING'[]; basis: DeliveryBasis } | null>(null);

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUpcomingList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(q!.total.value).toBe(0);
    scope.stop();
  });
});
