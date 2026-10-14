// src/composables/queries/__tests__/useCustomersQuery.spec.ts
//
// 2026-10-17 新增：useCustomersQuery 的 **queryFn Zod 守门**守卫（今天该 hook 完全
// 没有 spec，守门点是一次裸 `.parse`，删掉它测试仍全绿）。
//
// 为什么必须有：客户是**共享基础数据层**，全站 12 个客户筛选器 + 客户一览页 + 报工
// 台/外协/返修的行内编辑都从这条 query 取数。守门一失效，后端字段漂移会一路静默
// strip 到底（表现为「按某个车间筛客户时筛不出东西」这种查不到根因的怪现象）。
//
// ⚠️ 这条与 `src/api/__tests__/customer.spec.ts` 是一**对**：那边守「api 层不 parse」，
// 本文件守「parse 真的接在 queryFn 的返回路径上」。少了任一方，把 parse 在两层之间
// 搬来搬去都是零测试信号（详见 CLAUDE.md「守门点随分层搬家」）。
//
// 覆盖：
//   - Q1：正常响应 → data 落到 query，字段逐字透传
//   - Q2：坏响应（items 里少 customer_path）→ **抛错**、data 为 undefined、error 非空
//     （2026-10-17 客户无限层级改造：customer_path 是必填键；后端没先上就是这条形态）
//   - Q3：结构整体不对（items 不是数组）→ 抛错
//   - Q4：staleTime / gcTime 仍是共享基础数据层的 30s / 5min（不是 POSITIVE_INFINITY）
//   - Q5：queryKey 走 qk.customersList（键工厂是全仓唯一来源）
//
// 环境：`vi.mock('element-plus')` 把 ElMessage 桩成 no-op —— node env 下真实
// ElMessage 走 normalizeAppendTo 会撞 `document is not defined`；且
// `app.use(VueQueryPlugin)` + 传 QueryClient 是实例化任何用 query 的 composable 的
// 硬要求（缺插件直接抛 "No QueryClient set"）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const listCustomersMock = vi.fn<
  () => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 0, offset: 0 }));

vi.mock('@/api/customer', () => ({
  listCustomers: () => listCustomersMock(),
}));

import { useCustomersQuery } from '../useCustomersQuery';
import { qk } from '../keys';

/** 一条后端 wire 形态的客户（含 2026-10-17 新增的必填 customer_path）。 */
const GOOD_ITEM = {
  id: '190000000000001',
  name: '华强',
  parent_id: null,
  parent_name: null,
  serial_prefix: 'H',
  customer_path: '华强',
  version: 3,
  created_at: '2026-10-17 10:00:00',
  updated_at: '2026-10-17 11:00:00',
};

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 在插件上下文 + effectScope 里建一个 query，返回其 handles。 */
function mountQuery(): { query: ReturnType<typeof useCustomersQuery>; stop: () => void } {
  const scope = effectScope();
  let query: ReturnType<typeof useCustomersQuery> | undefined;
  scope.run(() => {
    query = testApp.runWithContext(() => useCustomersQuery());
  });
  return { query: query!, stop: () => scope.stop() };
}

describe('useCustomersQuery — queryFn Zod 守门（2026-10-17）', () => {
  beforeEach(() => {
    listCustomersMock.mockReset();
    listCustomersMock.mockResolvedValue({
      items: [GOOD_ITEM],
      total: 1,
      limit: 50,
      offset: 0,
    });
    testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    vi.restoreAllMocks();
  });

  it('Q1：正常响应 → data 落到 query，字段逐字透传', async () => {
    const { query, stop } = mountQuery();
    await query.refetch();
    expect(query.isError.value).toBe(false);
    expect(query.data.value?.items).toHaveLength(1);
    expect(query.data.value?.items[0]?.customer_path).toBe('华强');
    expect(query.data.value?.items[0]?.serial_prefix).toBe('H');
    expect(query.data.value?.total).toBe(1);
    expect(listCustomersMock).toHaveBeenCalled();
    stop();
  });

  it('Q2：坏响应（少 customer_path）→ 抛错、data 为 undefined、error 非空', async () => {
    // 部署顺序守卫：后端没上 customer_path 时，前端必须当场炸，而不是让全站客户
    // 筛选器拿到「路径名全空」的数据后静默筛不出东西。
    listCustomersMock.mockResolvedValue({
      items: [{ ...GOOD_ITEM, customer_path: undefined }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const { query, stop } = mountQuery();
    // refetch 本身不抛（错误落在 query.error 上），所以断言错误态而不是 try/catch
    await query.refetch().catch(() => undefined);
    expect(query.isError.value).toBe(true);
    expect(query.data.value).toBeUndefined();
    expect(query.error.value).toBeTruthy();
    stop();
  });

  it('Q2b：整项缺 customer_path（后端旧版本形态）→ 同样抛错', async () => {
    const { customer_path: _omitted, ...legacy } = GOOD_ITEM;
    listCustomersMock.mockResolvedValue({ items: [legacy], total: 1, limit: 50, offset: 0 });
    const { query, stop } = mountQuery();
    await query.refetch().catch(() => undefined);
    expect(query.isError.value).toBe(true);
    expect(query.data.value).toBeUndefined();
    stop();
  });

  it('Q3：整体结构不对（items 不是数组）→ 抛错', async () => {
    listCustomersMock.mockResolvedValue({
      items: 'not-an-array',
      total: 1,
      limit: 50,
      offset: 0,
    } as unknown as { items: unknown[]; total: number; limit: number; offset: number });
    const { query, stop } = mountQuery();
    await query.refetch().catch(() => undefined);
    expect(query.isError.value).toBe(true);
    stop();
  });

  it('Q4：缓存参数仍是共享基础数据层的 30s staleTime / 5min gcTime', async () => {
    const { query, stop } = mountQuery();
    await query.refetch();
    const opts = testQueryClient.getQueryCache().find({ queryKey: qk.customersList })?.options as
      { staleTime?: number; gcTime?: number } | undefined;
    // staleTime / gcTime 是「客户端侧」选项，不在 QueryOptions 的 TS 类型上，但
    // 运行时就在 options 里（_defaulted 已把 defaults 合并进来）—— 这里断言的是
    // 「没被改成 POSITIVE_INFINITY 会话级缓存」，那是 dashboard 域靠 WS 失效才
    // 成立的例外，本域没有失效通道。
    expect(opts?.staleTime).toBe(30_000);
    expect(opts?.gcTime).toBe(5 * 60 * 1000);
    stop();
  });

  it('Q5：queryKey 走 qk.customersList 键工厂（调用点不拼字面量数组）', async () => {
    const { query, stop } = mountQuery();
    await query.refetch();
    // 缓存里恰好一条 entry，且 queryKey 与键工厂逐段相同 —— 若调用点改成
    // `['customers', 'list']` 之类的字面量数组，这里既找不到也会多出第二条。
    const entries = testQueryClient.getQueryCache().getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.queryKey).toEqual(qk.customersList);
    stop();
  });
});
