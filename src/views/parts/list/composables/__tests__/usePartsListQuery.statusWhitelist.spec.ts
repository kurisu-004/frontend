// @vitest-environment happy-dom
// src/views/parts/list/composables/__tests__/usePartsListQuery.statusWhitelist.spec.ts
//
// 2026-10-03 新增：`statuses` 查询参数白名单化回归保护。
//
// 后端 2026-10-01 起不再产生 REPAIRING 状态（返修改用 t_part_batch.is_repairing
// 布尔列，migration 已把存量行洗成 IN_PROCESS）。但 `statuses` 在后端两个端点都是
// 裸逗号串零校验 + `= ANY` 文本比较 ⇒ 传 REPAIRING 既不降级也不 400，只会恒匹配
// 0 行。而白名单化前它有三条复活路径，每条都能让死字面量重新下发：
//   1) 搜索栏状态下拉的候选项（已白名单化，本 spec 断言其不含 REPAIRING）；
//   2) 表头原生筛选的候选项（`statusNativeOptions`）—— 同一份 search.statuses
//      的第二个写入口；
//   3) 两条「外部输入」恢复分支：`?status=REPAIRING` 的 URL 注入，以及老浏览器
//      localStorage 里已持久化的 ['REPAIRING'] 快照。
//
// 本 spec 逐条钉住上面三个写入口，外加两条易漏边界：
//   1) 搜索栏状态下拉的候选项（`q.statusOptions`）—— W6；
//   2) 表头原生筛选的候选项（`statusNativeOptions`）—— 同一份 search.statuses 的
//      第二个写入口，W7 直接 mount usePartsColumnFilters 断它；
//   3) 两条「外部输入」恢复分支：`?status=REPAIRING` 的 URL 注入（W2），以及老
//      浏览器 localStorage 里已持久化的 ['REPAIRING'] 快照（W3）；
//   - 白名单把 statuses 全过滤空时必须退回初始默认，而不是发出空 `statuses`
//     （空数组在 buildParams 里会被转成 undefined = 不筛选 = 全量返回，与用户
//     「我选了返修中」的预期完全相反）—— W4 / W5。
//
// 环境用 happy-dom：第 3 类路径要写真实 localStorage 快照，node env 无 localStorage。
// localStorage key 由 useListStatePersist 的 storageKey 生成，形如
// `myerp.list.<userId|anon>.parts_list_filter`；本 spec 不注入 auth store
// （useAuthStore 在无 active pinia 时抛错，被 storageKey 的 try/catch 吞掉）⇒ 后缀
// 恒为 `anon`。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { UnionListParams } from '@/api/com/unionList';

import { cleanParams } from '@/api/http';
import {
  initialPartsSearch,
  PARTS_STATUS_FILTER_WHITELIST,
  usePartsListQuery,
  type PartsSearchState,
} from '../usePartsListQuery';
import { URGENT_FILTER_VALUE, usePartsColumnFilters } from '../usePartsColumnFilters';

const realListUnionItemsMock = vi.fn<
  (params: UnionListParams) => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 20, offset: 0 }));

vi.mock('@/api/com/unionList', () => ({
  listUnionItems: (params: UnionListParams) =>
    realListUnionItemsMock(cleanParams(params) as unknown as UnionListParams),
}));

// usePartsListQuery 内 `watch(errorMsg) → ElMessage.error(...)` 桥接在 node 环境会因
// ElMessage 需要 `document` 而抛；桩成 no-op（同 usePartsListQuery.locationsHolderIds.spec.ts）。
vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// W7 挂 usePartsColumnFilters 会经 useCustomerTree 触发一条客户列表 useQuery，桩成
// 空列表避免 spec 发真实请求（location 树是懒加载，onShow 才 load，挂载不发）。
vi.mock('@/api/customer', () => ({
  listCustomers: vi.fn(async () => ({ items: [], total: 0, limit: 200, offset: 0 })),
}));

const PERSIST_KEY = 'myerp.list.anon.parts_list_filter';

/** 取 listUnionItems 首次调用的入参（cleanParams 后形态，即 axios 实际看到的参数）。 */
function firstWire(): Record<string, unknown> {
  return realListUnionItemsMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

/** 构造一份 useListStatePersist.restore() 能接受的完整快照（4 个 dep key 缺一即返回 null）。 */
function writeSnapshot(search: Partial<PartsSearchState>): void {
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({
      search: { ...initialPartsSearch(false), ...search },
      sortBy: 'planned_delivery_date',
      sortDir: 'ASC',
      pageSize: 20,
    }),
  );
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('usePartsListQuery — statuses 白名单（REPAIRING 停用）', () => {
  beforeEach(() => {
    realListUnionItemsMock.mockClear();
    realListUnionItemsMock.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
    localStorage.clear();
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('W1：initialPartsSearch 的默认 statuses 不含 REPAIRING（两种角色默认都验）', () => {
    expect(initialPartsSearch(false).statuses).toEqual(['IN_PROCESS']);
    expect(initialPartsSearch(true).statuses).toEqual(['PENDING', 'IN_PROCESS']);
    expect(initialPartsSearch(false).statuses).not.toContain('REPAIRING');
    expect(initialPartsSearch(true).statuses).not.toContain('REPAIRING');
  });

  it('W2：?status=REPAIRING 恢复分支 → 丢弃该值并落到持久化快照（不发 REPAIRING）', async () => {
    writeSnapshot({ statuses: ['PENDING'] }); // 保证有持久化快照可退回
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.restoreState('REPAIRING');

    // 断成确切值而不是 not.toContain：statuses 被整个过滤成空数组时
    // not.toContain 同样会通过（空集恒不含 REPAIRING），守不住「退回到快照」。
    expect(q.search.statuses).toEqual(['PENDING']);
    await q.fetchList();
    expect(firstWire().statuses).toEqual(['PENDING']);
  });

  it('W2b：?status=PENDING 白名单内的值照常注入（守住 W2 不是「一律不恢复」）', async () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.restoreState('PENDING');

    expect(q.search.statuses).toEqual(['PENDING']);
    await q.fetchList();
    expect(firstWire().statuses).toEqual(['PENDING']);
  });

  it('W3：持久化快照里的 REPAIRING 被过滤，白名单内的值保留', async () => {
    writeSnapshot({ statuses: ['REPAIRING', 'INSPECTION', 'PENDING'] });
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.restoreState(undefined);

    expect(q.search.statuses).toEqual(['INSPECTION', 'PENDING']);
    await q.fetchList();
    expect(firstWire().statuses).toEqual(['INSPECTION', 'PENDING']);
  });

  it('W4：持久化快照的 statuses 全被过滤空 → 退回 initialPartsSearch 默认（不发空 statuses）', async () => {
    writeSnapshot({ statuses: ['REPAIRING'] });
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    q.restoreState(undefined);

    // 退回默认，而不是空数组：空数组在 buildParams 里是 undefined = 不筛选 = 全量返回
    expect(q.search.statuses).toEqual(initialPartsSearch(false).statuses);
    await q.fetchList();
    expect(firstWire().statuses).toEqual(['IN_PROCESS']);
  });

  it('W5：CNC 编程员角色的空 statuses 退回走自己的默认（PENDING + IN_PROCESS）', async () => {
    writeSnapshot({ statuses: ['REPAIRING'] });
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: true }));
    q.restoreState(undefined);

    expect(q.search.statuses).toEqual(['PENDING', 'IN_PROCESS']);
  });

  it('W6：搜索栏下拉候选项（statusOptions）逐项等于白名单，不含 REPAIRING', () => {
    const q = testApp.runWithContext(() => usePartsListQuery({ isCncProgrammer: false }));
    const values = q.statusOptions.map((o) => o.value);

    // 断长度 + 断全等，避免「白名单被清空」时 not.toContain 恒真通过
    expect(values).toHaveLength(PARTS_STATUS_FILTER_WHITELIST.length);
    expect(values).toEqual([...PARTS_STATUS_FILTER_WHITELIST]);
    expect(values).not.toContain('REPAIRING');
  });

  it('W7：表头原生筛选候选项（statusNativeOptions）同样白名单化，只多出「仅加急」哨兵', () => {
    const f = testApp.runWithContext(() =>
      usePartsColumnFilters({
        search: initialPartsSearch(false),
        onSearch: () => {},
        snapshot: () => {},
      }),
    );
    const values = f.statusNativeOptions.map((o) => o.value);

    expect(values).not.toContain('REPAIRING');
    // 白名单 9 项 + 末尾「仅加急」哨兵：同一条链路上的两个写入口必须同源，
    // 任一侧漏改都会让 REPAIRING 从另一侧复活。
    expect(values).toEqual([...PARTS_STATUS_FILTER_WHITELIST, URGENT_FILTER_VALUE]);
  });
});
