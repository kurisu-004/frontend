// src/composables/queries/__tests__/useWorkTypesQuery.spec.ts
//
// 2026-10-02 新增：useWorkTypesQuery / useWorkTypeProcessesQuery 的
// reactive params + enabled 闸门 + Zod 守门回归保护。
//
// 背景：本域此前**零 schema、零 queryKey**（ProcessWorkTypeMappingTab.vue 裸调
//   listWorkTypes / getWorkTypeProcesses），于是 v1 影子类型（`WorkTypeWithProcesses
//   .processes`）的错误读法与 `{process_ids: [...]}` 的错误 payload 都能编译通过并
//   上线：点工种报 `undefined.map`，保存把该工种全部映射静默清空。共享 query 化的
//   首要交付物就是「reactive params 不被 snapshot」+「queryFn Zod 守门」这两层。
//
// 测试策略（与 useProcessesQuery.spec.ts 同款，两个手法必须照做）：
//   - vi.mock('@/api/workType')：listWorkTypes / getWorkTypeProcesses 换成 vi.fn()，
//     捕获入参；不调真实 axios；
//   - ⚠️ **必须在 vi.mock 之前 import**：mock 实现内部要用 cleanParams
//     （useProcessesQuery.spec.ts:45-46 显式注明了这条）。本文件的 mock 不需要
//     cleanParams，但 import 顺序仍照抄，避免将来加断言时踩坑。
//   - ⚠️ **必须用 app.runWithContext**：vue-query 的 useQueryClient() 走 Vue
//     `inject()`，node env 下没有组件 setup 上下文、currentApp 为 null 时 inject
//     直接抛（useProcessesQuery.spec.ts:88-91 注释）。install VueQueryPlugin +
//     QueryClient 后，用 `testApp.runWithContext(() => useXxxQuery(...))` 让 Vue
//     临时把 currentApp 切到测试 app，inject 才能在 `app._context.provides` 命中。
//     该 app 不挂组件、不 mount，仅作 provide channel。
//   - mockResolvedValue（持久）而非 Once：useQuery 在 setup 时会自动首调，紧接的
//     refetch 是第二调，两次都必须命中 mock。
//
// 覆盖：
//   - T1：传静态对象 → listWorkTypes 收到该对象（含 limit）。
//   - T2：传 Ref<WorkTypeListParams> → 改 ref.value 后 refetch，listWorkTypes 收到
//         新 code_like（首轮 review B-1 同形态 regression 的核心 guard：params 在
//         setup 期被 snapshot ⇒ 后端永远收空 filter）。
//   - T3：传 ComputedRef → 改底层 reactive 后收到新 params。
//   - T4：传 getter（MaybeRefOrGetter 第三分支）→ 改 source 后收到新 params。
//   - T5：传 undefined / 完全不传 → 收到 {}（cleanParams 后空对象）。
//   - T6：useWorkTypeProcessesQuery('') **零请求**（未选中工种不发）。
//   - T7：useWorkTypeProcessesQuery(id) 正常发且 URL 入参正确。
//   - T8（Zod 守门）：listWorkTypes 响应缺 process_ids → parse 抛错 → data 为
//         undefined、isError 为 true（M-1 strip 陷阱 guard：本域 10 个字段全显式
//         声明，漏一个就静默丢；这条用例是「漏声明必须变红」的证据）。
//   - T9（Zod 守门）：映射响应缺 sort_order → parse 抛错 → data undefined。
//   - T10：total / limit / offset 是**裸 i64** ⇒ 必须是 JSON number（与
//         repairBatchListResultSchema 的 z.string() 方向相反，照抄就红）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// 必须在 vi.mock 之前导入：mock 工厂被提升到文件顶部。
import { cleanParams } from '@/api/http';
import { useWorkTypeProcessesQuery, useWorkTypesQuery } from '../useWorkTypesQuery';
import type { WorkTypeListParams } from '@/api/workType';

const realListWorkTypesMock = vi.fn<
  (
    params: WorkTypeListParams,
  ) => Promise<{ items: unknown[]; total: number; limit: number; offset: number }>
>(async () => ({ items: [], total: 0, limit: 200, offset: 0 }));

const realGetWorkTypeProcessesMock = vi.fn<(id: string) => Promise<{ items: unknown[] }>>(
  async () => ({ items: [] }),
);

function listImpl(params: WorkTypeListParams) {
  return realListWorkTypesMock(cleanParams(params) as WorkTypeListParams);
}

function lastParams(): Record<string, unknown> {
  const calls = realListWorkTypesMock.mock.calls;
  return calls[calls.length - 1]?.[0] as unknown as Record<string, unknown>;
}

vi.mock('@/api/workType', () => ({
  listWorkTypes: (params: WorkTypeListParams) => listImpl(params),
  getWorkTypeProcesses: (id: string) => realGetWorkTypeProcessesMock(id),
  // 这两个纯函数是「读/写形态收口」，已被 src/api/workType.spec.ts 逐字钉死；
  // 本文件 importOriginal 走真实现（与 ShelfList.processMapping.spec.ts 同款理由：
  // 端到端仍用真代码，只桩发请求的函数）。
  toWorkTypeProcessIds: (r: { items: Array<{ process_id: string; sort_order: number }> }) =>
    [...r.items].sort((a, b) => a.sort_order - b.sort_order).map((p) => p.process_id),
  toWorkTypeProcessesPayload: (ids: readonly string[]) => ({
    items: [...new Set(ids)].map((process_id, idx) => ({ process_id, sort_order: idx })),
  }),
  setWorkTypeProcesses: vi.fn(),
}));

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

/** 后端 WorkTypeOut 10 字段的最小完整形态（vo/work_type.rs）。 */
function validWorkType() {
  return {
    id: '8800000000001',
    code: 'WELDER',
    name: '焊工',
    description: null,
    sort_order: 1,
    max_held_batches: null,
    process_ids: ['190000000000001'],
    version: 1,
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-01 10:00:00',
  };
}

/** 后端 WorkTypeProcessMappingItem 4 字段。 */
function validLink(process_id: string, sort_order: number) {
  return { work_type_id: '8800000000001', process_id, process_code: 'CUT', sort_order };
}

describe('useWorkTypesQuery — reactive params + Zod 守门（2026-10-02）', () => {
  beforeEach(() => {
    realListWorkTypesMock.mockClear();
    realListWorkTypesMock.mockResolvedValue({
      items: [validWorkType()],
      total: 1,
      limit: 200,
      offset: 0,
    });
    realGetWorkTypeProcessesMock.mockClear();
    realGetWorkTypeProcessesMock.mockResolvedValue({
      items: [validLink('190000000000001', 0)],
    });
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  it('T1：传静态对象 → listWorkTypes 收到该对象（含 limit）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypesQuery({ code_like: 'W', limit: 200 }));
    });
    await q!.refetch();
    expect(realListWorkTypesMock).toHaveBeenCalled();
    expect(lastParams().code_like).toBe('W');
    expect(lastParams().limit).toBe(200);
    scope.stop();
  });

  it('T2：传 Ref → 改 ref.value 后 refetch，listWorkTypes 收到新 code_like', async () => {
    // 核心 regression guard：params 若在 setup 期被 snapshot，reactive 筛选变化
    // 永远传不到后端（useProcessesQuery 首轮 review B-1 即此问题）。
    const scope = effectScope();
    const paramsRef: Ref<WorkTypeListParams> = ref({ code_like: 'INIT', limit: 200 });
    let q: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypesQuery(paramsRef));
    });

    await q!.refetch();
    expect(lastParams().code_like).toBe('INIT');

    paramsRef.value = { code_like: 'NEW', limit: 200 };
    await q!.refetch();
    expect(lastParams().code_like).toBe('NEW');
    scope.stop();
  });

  it('T3：传 ComputedRef → 改底层 reactive 后 listWorkTypes 收到新 params', async () => {
    const scope = effectScope();
    const search = ref({ code_like: '' });
    const params = computed<WorkTypeListParams>(() => ({
      code_like: search.value.code_like || undefined,
      limit: 200,
    }));
    let q: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypesQuery(params));
    });

    await q!.refetch();
    expect(lastParams().code_like).toBeUndefined();

    search.value = { code_like: 'XYZ' };
    await q!.refetch();
    expect(lastParams().code_like).toBe('XYZ');
    scope.stop();
  });

  it('T4：传 getter（MaybeRefOrGetter 第三分支）→ 改 source 后收到新 params', async () => {
    const scope = effectScope();
    const source = ref<WorkTypeListParams>({ code_like: 'GETTER-INIT', limit: 200 });
    let q: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypesQuery(() => source.value));
    });
    await q!.refetch();
    expect(lastParams().code_like).toBe('GETTER-INIT');

    source.value = { code_like: 'GETTER-NEW', limit: 200 };
    await q!.refetch();
    expect(lastParams().code_like).toBe('GETTER-NEW');
    scope.stop();
  });

  it('T5：传 undefined / 完全不传 → listWorkTypes 收到 {}', async () => {
    const scope = effectScope();
    let q1: ReturnType<typeof useWorkTypesQuery> | undefined;
    let q2: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q1 = testApp.runWithContext(() => useWorkTypesQuery(undefined));
      q2 = testApp.runWithContext(() => useWorkTypesQuery());
    });
    await q1!.refetch();
    expect(Object.keys(lastParams()).length).toBe(0);
    await q2!.refetch();
    expect(Object.keys(lastParams()).length).toBe(0);
    scope.stop();
  });

  it('T6：useWorkTypeProcessesQuery("") → enabled=false，零请求', async () => {
    // 未选中工种时右侧是「请选择工种」，不该发请求。
    const scope = effectScope();
    let q: ReturnType<typeof useWorkTypeProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypeProcessesQuery(''));
    });
    await q!.refetch();
    expect(realGetWorkTypeProcessesMock).not.toHaveBeenCalled();
    scope.stop();
  });

  it('T7：useWorkTypeProcessesQuery(id) → 正常发请求且入参是工种 id', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useWorkTypeProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypeProcessesQuery(ref('8800000000001')));
    });
    await q!.refetch();
    expect(realGetWorkTypeProcessesMock).toHaveBeenCalledWith('8800000000001');
    expect(q!.isError.value).toBe(false);
    expect(q!.data.value?.items).toHaveLength(1);
    scope.stop();
  });

  it('T8（Zod 守门）：工种响应缺 process_ids → parse 抛错，data 为 undefined', async () => {
    // M-1 strip 陷阱 guard：Zod 默认 strip 模式下漏声明的字段被**静默丢弃**，下游
    // 拿到 undefined 却毫无察觉。workTypeSchema 显式声明 10 字段就是为了这个 ——
    // 本用例是「删掉 process_ids 声明就必须变红」的证据。
    const { process_ids: _omit, ...rest } = validWorkType();
    void _omit;
    realListWorkTypesMock.mockResolvedValue({ items: [rest], total: 1, limit: 200, offset: 0 });

    const scope = effectScope();
    let q: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypesQuery({ limit: 200 }));
    });
    await q!.refetch();
    expect(q!.isError.value).toBe(true);
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T9（Zod 守门）：映射响应缺 sort_order → parse 抛错，data 为 undefined', async () => {
    // sort_order 是必填（后端 SQL `ORDER BY sort_order ASC, id ASC` 恒返非空）。
    // 不用 `?? 0` 兜底 —— 那会把契约漂移静默吞掉。
    const { sort_order: _omit, ...rest } = validLink('190000000000001', 0);
    void _omit;
    realGetWorkTypeProcessesMock.mockResolvedValue({ items: [rest] });

    const scope = effectScope();
    let q: ReturnType<typeof useWorkTypeProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypeProcessesQuery('8800000000001'));
    });
    await q!.refetch();
    expect(q!.isError.value).toBe(true);
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T10：total / limit / offset 是裸 i64 → 必须是 JSON number（z.number()）', async () => {
    // ⚠️ 与 repairBatchListResultSchema（那边**有** serialize_i64 ⇒ z.string()）
    // 方向相反。照抄那一个会让本域整列表不可用。
    realListWorkTypesMock.mockResolvedValue({
      items: [validWorkType()],
      total: 1,
      limit: 200,
      offset: 0,
    });

    const scope = effectScope();
    let q: ReturnType<typeof useWorkTypesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useWorkTypesQuery({ limit: 200 }));
    });
    await q!.refetch();
    expect(q!.isError.value).toBe(false);
    expect(q!.data.value?.total).toBe(1);
    expect(q!.data.value?.limit).toBe(200);
    expect(q!.data.value?.offset).toBe(0);
    scope.stop();
  });
});
