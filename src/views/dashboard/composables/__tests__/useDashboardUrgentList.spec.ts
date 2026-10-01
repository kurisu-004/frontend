// src/views/dashboard/composables/__tests__/useDashboardUrgentList.spec.ts
//
// 2026-09-29 新增：useDashboardUrgentList 派生数据回归保护。
//
// 覆盖：
//   - U1：listUnionItems 返回 100 件 → items 派生 = 100 件
//   - U2：urgentCount 派生 = items.filter(p => p.is_urgent).length
//   - U3：fetchList 是 refetch async 包装（alias 沿 2026-09-26 约定 #7）
//   - U4：listUnionItems 入参硬编码（statuses / sort_by / sort_dir / limit / offset）
//   - U5：queryFn 走 partListResultSchema.parse(...) 守门 —— 缺必填字段抛错

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

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useDashboardUrgentList — items + urgentCount 派生（2026-09-29）', () => {
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

  it('U2：urgentCount 派生 = items.filter(is_urgent).length（100 件中 12 件紧急）', async () => {
    const parts: Record<string, unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      parts.push(
        makeBasePart({
          id: `1800000000${String(i).padStart(5, '0')}`,
          // 每 100/12 ≈ 8 件设紧急 → 12 件标记
          is_urgent: i % 8 === 0,
        }),
      );
    }
    listUnionItemsMock.mockResolvedValue(makeResultWithParts(parts));

    const scope = effectScope();
    let q: ReturnType<typeof useDashboardUrgentList> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useDashboardUrgentList());
    });
    await q!.fetchList();

    expect(q!.urgentCount.value).toBe(13); // i=0,8,16,24,32,40,48,56,64,72,80,88,96
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
    // 2026-10-01 修正：本断言原写死 'PLANNED_DELIVERY_DATE'，但 URGENT_LIST_PARAMS
    // 已于 2026-09-30 改为 'SYSTEM_DELIVERY_DATE'（见 useDashboardUrgentList.ts 的
    // sort_by 说明：改按系统交期排，PartSortKey 已含该值），测试没跟上 → 长期红灯。
    expect(params['sort_by']).toBe('SYSTEM_DELIVERY_DATE');
    expect(params['sort_dir']).toBe('ASC');
    expect(params['limit']).toBe(100);
    expect(params['offset']).toBe(0);
    expect(params['row_type']).toBe('ALL');
    const statuses = params['statuses'] as string[];
    expect(statuses).toContain('PENDING');
    expect(statuses).toContain('IN_PROCESS');
    expect(statuses).not.toContain('DELIVERED'); // 终态不在列表内
    expect(statuses).not.toContain('CANCELLED');
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
});