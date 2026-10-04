// src/views/dashboard/composables/__tests__/useDashboardUrgentList.spec.ts
//
// useDashboardUrgentList 派生数据回归保护。
//
// 覆盖：
//   - U1：listUnionItems 返回 100 件 → items 派生 = 100 件
//   - U3：fetchList 是 refetch async 包装
//   - U4：listUnionItems 入参硬编码（row_type='PART_FLAT' / statuses / sort_by / sort_dir /
//     limit / offset）
//   - U5：queryFn 走 partListResultSchema.parse(...) 守门 —— 缺必填字段抛错
//   （2026-10-05 新增）
//   - U7：请求带 system_delivery_date_from = 今日 ISO / _to = 今日+6 ISO（窗口两端
//     都有下界，没有下界时逾期件会占满 limit 100 把窗口内的件挤掉），
//     且 planned_delivery_date_from/_to 根本不出现
//   - U8：queryKey 含 today（gcTime 无限 + refetchOnWindowFocus false，today 不进键
//     则跨零点吃昨天窗口的缓存）；键 / 请求参数 / 对外暴露的 windowStartIso 同刻相等

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

// listUnionItems 桩 —— 接受硬编码 params，返回 100 件 mock 工单
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

import { useDashboardUrgentList } from '../useDashboardUrgentList';
import { qk } from '@/composables/queries/keys';
import { partListResultSchema } from '@/composables/queries/schemas';

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
    planned_delivery_date: '2026-09-30',
    is_urgent: false,
    status: 'PENDING',
    order_no: null,
    system_delivery_date: null,
    note: null,
    customer_name: '客户甲',
    l1_customer_name: 'L1 客户',
    location: null,
    has_cnc_program: false,
    row_type: 'PART',
    ...overrides,
  };
}

function makeResultWithParts(parts: Record<string, unknown>[]): Record<string, unknown> {
  return {
    items: parts,
    total: parts.length,
    limit: 100,
    offset: 0,
  };
}

/** 相对今天偏移 n 天的本地 ISO（'YYYY-MM-DD'）—— 与 systemDeliveryOrders 同算法。 */
function isoOffset(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useDashboardUrgentList — items 派生', () => {
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

  it('U1：mock 返回 100 件 → items.value.length === 100', async () => {
    const parts = Array.from({ length: 100 }, (_, i) =>
      makeBasePart({ id: `1800000000${String(i).padStart(5, '0')}` }),
    );
    listUnionItemsMock.mockResolvedValue(makeResultWithParts(parts));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });
    await q!.fetchList();

    expect(q!.items.value).toHaveLength(100);
    scope.stop();
  });

  it('U3：fetchList 是 refetch async 包装（调一次 → listUnionItems 至少被调一次）', async () => {
    const parts = [makeBasePart()];
    listUnionItemsMock.mockResolvedValue(makeResultWithParts(parts));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });

    // 先 await 一次确保初始 fetch 走完
    await q!.fetchList();
    // 清空调用历史，再 refetch 验证
    listUnionItemsMock.mockClear();
    await q!.fetchList();
    expect(listUnionItemsMock).toHaveBeenCalled();
    scope.stop();
  });

  it('U4：listUnionItems 入参硬编码（statuses / sort_by / sort_dir / limit / offset）', async () => {
    listUnionItemsMock.mockResolvedValue(makeResultWithParts([]));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });
    await q!.fetchList();

    expect(listUnionItemsMock).toHaveBeenCalled();
    const params = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['sort_by']).toBe('SYSTEM_DELIVERY_DATE');
    expect(params['sort_dir']).toBe('ASC');
    expect(params['limit']).toBe(100);
    expect(params['offset']).toBe(0);
    expect(params['row_type']).toBe('PART_FLAT');
    const statuses = params['statuses'] as string[];
    expect(statuses).toContain('PENDING');
    expect(statuses).toContain('IN_PROCESS');
    expect(statuses).not.toContain('DELIVERED'); // 终态不在列表内
    expect(statuses).not.toContain('CANCELLED');
    // 2026-10-01 起后端不再产生 REPAIRING（返修改用批次 is_repairing 布尔列），
    // 传它是恒匹配 0 行的死字面量。
    expect(statuses).not.toContain('REPAIRING');
    expect(statuses).toHaveLength(6);
    scope.stop();
  });

  it('U5：queryFn 走 partListResultSchema.parse(...) 守门 —— 缺 has_cnc_program 抛错', async () => {
    // partListResultSchema 守门：listUnionItems 返回的 items 元素缺 has_cnc_program
    // → partSchema 缺必填字段 → parse 抛 ZodError → query.error 非空。
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
          planned_delivery_date: '2026-09-30',
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
      limit: 100,
      offset: 0,
    });

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });
    try {
      await q!.fetchList();
    } catch {
      // 期望 query.error 设置，不一定抛
    }

    expect(q!.query.error.value).not.toBeNull();
    scope.stop();
  });

  it('U6：partListResultSchema 接受合法 100 件 part（schema 守门正向断言）', () => {
    const parts = [makeBasePart()];
    const result = makeResultWithParts(parts);
    const parsed = partListResultSchema.parse(result);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.id).toBe('180000000000001');
    expect(parsed.items[0]?.has_cnc_program).toBe(false);
  });

  // ==========================================================================
  // 2026-10-05：行源切 PART_FLAT + 交期窗口两端下发 + today 进 queryKey
  // ==========================================================================

  it('U7：请求带 system_delivery_date 窗口两端（下界 = 今天），且不夹带 planned 窗口参数', async () => {
    listUnionItemsMock.mockResolvedValue(makeResultWithParts([]));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });
    await q!.fetchList();

    const params = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // 下界是关键：没有下界时逾期件（任意过去日期）在 ASC 排序里占满 limit 100，
    // 7 天窗口内的一件都挤不进 Top 30。
    expect(params['system_delivery_date_from']).toBe(isoOffset(0));
    expect(params['system_delivery_date_to']).toBe(isoOffset(6));
    // 两组窗口参数互斥：同时发会被后端 AND 成交集
    expect(params).not.toHaveProperty('planned_delivery_date_from');
    expect(params).not.toHaveProperty('planned_delivery_date_to');
    scope.stop();
  });

  it('U8：queryKey 含 today —— 键、请求参数与 windowStartIso 窗口下界同刻相等', async () => {
    listUnionItemsMock.mockResolvedValue(makeResultWithParts([]));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });
    await q!.fetchList();

    const today = isoOffset(0);
    // 键形态 = ['dashboard','urgent-list', today]
    const cached = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.dashboardUrgentList(today) });
    expect(cached).toBeTruthy();
    expect(cached?.queryKey).toEqual(['dashboard', 'urgent-list', today]);
    // 前缀键与工厂键同根：WS 事件按前缀能一把命中（跨零点前后的两条都命中）
    expect(cached?.queryKey.slice(0, 2)).toEqual([...qk.dashboardUrgentListPrefix]);
    // 键、queryFn 用的 today、对外暴露的 windowStartIso 三者是同一个瞬间捕获的同一个值：
    // 消费方把它传给 splitForDashboard 即可让客户端窗口与服务端请求窗口同刻。
    // 这里断言的是**同刻相等**，不是「同源」—— 同一天内两次取 Date() 结果必然相同，
    // 跨零点才显形，而跨零点不重挂载就不换窗（故这条不可能区分 queryFn 是否现取 today）。
    const params = listUnionItemsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['system_delivery_date_from']).toBe(cached?.queryKey[2]);
    expect(q!.windowStartIso).toBe(cached?.queryKey[2]);
    scope.stop();
  });
});