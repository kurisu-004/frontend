// src/views/dashboard/composables/__tests__/useDashboardUpcomingList.spec.ts
//
// 2026-09-30 新增：useDashboardUpcomingList reactive params + enabled 闸门 +
// Zod parse 守门回归保护（与 plan §2.7 对齐）。
//
// 覆盖：
//   - L1：queryKey 形态 — 含 ['dashboard','upcoming-list', { date, statuses }] 三层
//   - L2：params=null 时 enabled=false，listUnionItems 不被调
//   - L3：params.statuses 空数组时 enabled=false（防御性）
//   - L4：成功路径走 partListResultSchema.parse(...) 守门
//   - L5：listUnionItems 入参硬编码 row_type='PART' / sort_by / sort_dir / limit / offset

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

  it('L1：queryKey 形态 = ["dashboard","upcoming-list",{date,statuses}]', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });

    const params = ref<{ date: string; statuses: ('PENDING' | 'PROGRAMMING')[] } | null>({
      date: '2026-10-01',
      statuses: ['PENDING', 'PROGRAMMING'],
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 直接通过 QueryClient cache 拉真实 queryKey 断言形态（不用 onDashboardEventMock
    // .toHaveBeenCalled 这种「WS 订阅挂上」的名实不符断言）
    const expectedKey = qk.dashboardUpcomingList({ date: '2026-10-01', statuses: ['PENDING', 'PROGRAMMING'] });
    const cached = testQueryClient.getQueryCache().find({ queryKey: expectedKey });
    expect(cached).toBeTruthy();
    expect(cached?.queryKey).toEqual(expectedKey);
    // queryKey 必须严格三层：['dashboard', 'upcoming-list', { date, statuses }]
    expect(cached?.queryKey).toHaveLength(3);
    expect(cached?.queryKey[0]).toBe('dashboard');
    expect(cached?.queryKey[1]).toBe('upcoming-list');
    expect(cached?.queryKey[2]).toEqual({ date: '2026-10-01', statuses: ['PENDING', 'PROGRAMMING'] });
    scope.stop();
  });

  it('L2：params=null 时 enabled=false → listUnionItems 不被调', async () => {
    const params = ref<{ date: string; statuses: ('PENDING')[] } | null>(null);

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('L3：params.statuses.length === 0 时 enabled=false → listUnionItems 不被调', async () => {
    const params = ref<{ date: string; statuses: never[] } | null>({
      date: '2026-10-01',
      statuses: [],
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
      limit: 500,
      offset: 0,
    });

    const params = ref<{ date: string; statuses: ('PENDING')[] } | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
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

  it('L5：listUnionItems 入参 = row_type=PART / sort_by=PLANNED_DELIVERY_DATE / limit=500', async () => {
    listUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });

    const params = ref<{ date: string; statuses: ('INSPECTION' | 'READY_TO_SHIP')[] } | null>({
      date: '2026-10-03',
      statuses: ['INSPECTION', 'READY_TO_SHIP'],
    });

    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useDashboardUpcomingList(() => params.value));
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listUnionItemsMock).toHaveBeenCalled();
    const args = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['row_type']).toBe('PART');
    expect(args['sort_by']).toBe('PLANNED_DELIVERY_DATE');
    expect(args['sort_dir']).toBe('ASC');
    expect(args['limit']).toBe(500);
    expect(args['offset']).toBe(0);
    expect(args['planned_delivery_date_from']).toBe('2026-10-03');
    expect(args['planned_delivery_date_to']).toBe('2026-10-03');
    expect((args['statuses'] as string[]).sort()).toEqual(['INSPECTION', 'READY_TO_SHIP'].sort());
    scope.stop();
  });

  it('L6：合法 1 件 part → rows.length === 1（正向断言守门）', async () => {
    listUnionItemsMock.mockResolvedValue({
      items: [makeBasePart({ id: '180000000000099' })],
      total: 1,
      limit: 500,
      offset: 0,
    });

    const params = ref<{ date: string; statuses: ('PENDING')[] } | null>({
      date: '2026-10-01',
      statuses: ['PENDING'],
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
});
