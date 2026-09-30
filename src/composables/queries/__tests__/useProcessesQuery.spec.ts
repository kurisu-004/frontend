// src/composables/queries/__tests__/useProcessesQuery.spec.ts
//
// 2026-09-26（B-1 回归保护）新增：useProcessesQuery 接受 MaybeRefOrGetter params，
// queryKey 走 computed → params 变化触发 listProcesses 用新值入参。
//
// 背景（review B-1）：
//   - 首轮实现把 params 在 setup 时一次性 snapshot 给 cleaned，同时塞进 queryKey 与
//     queryFn 闭包 —— user 改 search.code_like / search.category 后，listProcesses
//     收到的还是 setup 时的 {}，后端永远拿到空 filter（持久化筛选也废）。
//   - 修复：params 改 MaybeRefOrGetter；queryKey 走 computed(toValue(params))；
//     queryFn 从 queryKey[2] 读最新 params（不再 snapshot）。
//   - 范本：usePartsListQuery.ts:296-304（queryKey computed + queryFn 读 queryKey[2]）。
//
// 测试策略：
//   - vi.mock('@/api/process')：listProcesses 替换为 vi.fn()，捕获入参；
//   - beforeEach 安装 VueQueryPlugin + QueryClient（vue-query 5.x 需要 inject）；
//   - 不调真实 axios 路径，listProcesses 是 mock 函数不会发请求；
//   - 用 effectScope + runWithContext 拿测试 app 的 provides（与
//     usePartsListQuery.locationsHolderIds.spec.ts:100-115 同模式）。
//
// 覆盖：
//   - T1：传静态对象 → listProcesses 收到该对象（含 limit）
//   - T2：传 Ref<ProcessListParams> → 改 ref.value 后调 refetch，listProcesses
//     收到新 params（核心 regression guard）
//   - T3：传 ComputedRef（与 ProcessTab.vue 的 queryParams 同源） → 改底层
//     reactive.search 后调 refetch，listProcesses 收到新 params
//   - T4：传 undefined → listProcesses 收到 {}
//   - T5：传 getter 函数 () => params → 改 params 后调 refetch，listProcesses
//     收到新 params（MaybeRefOrGetter 第三个分支）
//   - T6：未传参数 → listProcesses 收到 {}（与 T4 等价但走「参数完全缺省」分支）
//   - T7：queryKey 形态正确（包含 reactive params 内容）—— 后续 invalidateProcessesQuery
//     失效路径不走它
//   - T8（2026-09-30 regression guard）：description / color 字段在 JSON 响应中
//     被后端 skip_serializing_if 省略时仍能 parse —— 该 bug 会让
//     processListResultSchema.parse 抛 ZodError → useProcessesQuery.data
//     === undefined → ProcessTab / WorkerQueueBoard / usePartDispatch 全部空。
//     processSchema 已升级 description/color 为 `.nullable().optional()`。
//   - T9（2026-09-30 regression guard）：description / color 字段为显式 null
//     时仍能 parse（向后兼容 schema 升级前的 null 路径）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

// 必须在 vi.mock 之前导入：listProcessesMockImpl 内部用 cleanParams。
import { cleanParams } from '@/api/http';
import { useProcessesQuery } from '../useProcessesQuery';
import type { ProcessListParams } from '../keys';

// listProcessesMock 接收「cleanParams 之后」的 params（与真实 listProcesses 行为一致：
// api.get('/prod/processes', { params: cleanParams(params) })），不是 useProcessesQuery
// 传入的原始 params。这样 'in params' 这类断言才能反映 axios 实际看到的 URL 参数形态。
const realListProcessesMock = vi.fn<
  (
    params: ProcessListParams,
  ) => Promise<{
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
  }>
>(async () => ({ items: [], total: 0, limit: 200, offset: 0 }));

function listProcessesMockImpl(
  params: ProcessListParams,
): Promise<{ items: unknown[]; total: number; limit: number; offset: number }> {
  return realListProcessesMock(cleanParams(params) as ProcessListParams);
}

function firstParams(): Record<string, unknown> {
  const call = realListProcessesMock.mock.calls[0];
  return call[0] as unknown as Record<string, unknown>;
}

function lastParams(): Record<string, unknown> {
  const calls = realListProcessesMock.mock.calls;
  return calls[calls.length - 1]?.[0] as unknown as Record<string, unknown>;
}

vi.mock('@/api/process', () => ({
  listProcesses: (params: ProcessListParams) => listProcessesMockImpl(params),
  getProcess: vi.fn(),
  createProcess: vi.fn(),
  updateProcess: vi.fn(),
  softDeleteProcess: vi.fn(),
}));

// vue-query useQuery 内部 `useQueryClient()` 走 Vue `inject()`，inject 在没有
// currentInstance 且 currentApp=null 时会 throw。必须在 `app.runWithContext(() => ...)`
// 里调 useProcessesQuery，让 Vue 把 currentApp 临时切到本测试 app，inject(key) 才能
// 在 `app._context.provides` 里命中 VueQueryPlugin 注册的 client。
let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useProcessesQuery — reactive params + queryKey 响应式回归保护（B-1 2026-09-26）', () => {
  beforeEach(() => {
    realListProcessesMock.mockClear();
    realListProcessesMock.mockResolvedValue({
      items: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
    testQueryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    // 释放每测试 app 的 VueQueryPlugin + QueryClient，避免测试间残留导致
    // unhandled rejection 串扰（与 usePartsListQuery.locationsHolderIds.spec.ts
    // 同模式）。
    testQueryClient.unmount();
    testApp = null as unknown as ReturnType<typeof createApp>;
    testQueryClient = null as unknown as QueryClient;
    vi.restoreAllMocks();
  });

  it('T1：传静态对象 → listProcesses 收到该对象（含 limit）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useProcessesQuery({ code_like: 'A', category: 'INHOUSE', limit: 200 }),
      );
    });
    await q!.refetch();
    // listProcesses 被调用，code_like / category / limit 都发送
    expect(realListProcessesMock).toHaveBeenCalled();
    expect(lastParams().code_like).toBe('A');
    expect(lastParams().category).toBe('INHOUSE');
    expect(lastParams().limit).toBe(200);
    scope.stop();
  });

  it('T2：传 Ref<ProcessListParams> → 改 ref.value 后调 refetch，listProcesses 收到新 code_like', async () => {
    // 背景（review B-1）：首轮实现把 cleaned 在 setup 时一次性 snapshot，
    // refetch 时 listProcesses 拿到的是空 filter。本用例是该 regression 的核心 guard。
    const scope = effectScope();
    const paramsRef: Ref<ProcessListParams> = ref({ code_like: 'INIT', limit: 200 });
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery(paramsRef));
    });

    // 首次 refetch —— 收到 INIT
    await q!.refetch();
    expect(lastParams().code_like).toBe('INIT');

    // 改 ref.value —— vue-query 内部 observer 监听 queryKey computed，
    // 触发 refetch（queryKey 自动响应 reactive 变化）。
    paramsRef.value = { code_like: 'NEW', limit: 200 };
    await q!.refetch();
    expect(lastParams().code_like).toBe('NEW');
    scope.stop();
  });

  it('T3：传 ComputedRef（与 ProcessTab.vue 的 queryParams 同源） → 改底层 reactive 后 listProcesses 收到新 params', async () => {
    // 背景：ProcessTab.vue 用 search reactive + queryParams computed 包装 code_like /
    // category。本用例模拟该形态，验证 reactive 源头变化能驱动 listProcesses 入参变化。
    const scope = effectScope();
    const search = ref({ code_like: '', category: undefined as 'INHOUSE' | 'OUTSOURCE' | undefined });
    const queryParams = computed<ProcessListParams>(() => ({
      code_like: search.value.code_like || undefined,
      category: search.value.category,
      limit: 200,
    }));
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery(queryParams));
    });

    // 默认态 —— code_like 为空字符串，cleanParams 剥成 undefined
    await q!.refetch();
    expect(lastParams().code_like).toBeUndefined();
    expect(lastParams().category).toBeUndefined();

    // 模拟用户在「代码」输入框打字 → search.code_like 变化
    search.value = { code_like: 'XYZ', category: 'OUTSOURCE' };
    await q!.refetch();
    // listProcesses 入参应该带新 code_like + category（这是 B-1 修复前会回归失败的断言）
    expect(lastParams().code_like).toBe('XYZ');
    expect(lastParams().category).toBe('OUTSOURCE');
    scope.stop();
  });

  it('T4：传 undefined → listProcesses 收到 {}', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery(undefined));
    });
    await q!.refetch();
    // cleanParams 后是空对象
    expect(realListProcessesMock).toHaveBeenCalled();
    const params = lastParams();
    expect(Object.keys(params).length).toBe(0);
    scope.stop();
  });

  it('T5：传 getter () => params → 改 source 后调 refetch，listProcesses 收到新 params', async () => {
    // 覆盖 MaybeRefOrGetter 第三种用法 —— 调用方传 getter 函数，每次 queryKey
    // computed 重新计算都会再调 getter 取最新值。
    const scope = effectScope();
    const source = ref<ProcessListParams>({ code_like: 'GETTER-INIT', limit: 200 });
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery(() => source.value));
    });
    await q!.refetch();
    expect(lastParams().code_like).toBe('GETTER-INIT');

    source.value = { code_like: 'GETTER-NEW', limit: 200 };
    await q!.refetch();
    expect(lastParams().code_like).toBe('GETTER-NEW');
    scope.stop();
  });

  it('T6：参数完全缺省（不传） → listProcesses 收到 {}', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery());
    });
    await q!.refetch();
    expect(realListProcessesMock).toHaveBeenCalled();
    // cleanParams 剥 undefined → 空对象
    expect(Object.keys(lastParams()).length).toBe(0);
    scope.stop();
  });

  it('T7：queryKey 形态正确（包含 reactive params 内容）—— 后续 invalidateProcessesQuery 失效路径不走它', async () => {
    // 背景：qk.processesOptions(params) 形态是 ['processes', 'options', params ?? null]。
    // 本用例验证 queryKey[2] 确实是 reactive params 对象（queryFn 读这个位置）。
    const scope = effectScope();
    const paramsRef: Ref<ProcessListParams> = ref({ code_like: 'A', limit: 200 });
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery(paramsRef));
    });

    // 首次 refetch 触发后，从 mock 入参可以反推 queryFn 走的路径：
    // queryKey[2] = paramsRef.value = { code_like: 'A', limit: 200 } → listProcesses(...)
    await q!.refetch();
    expect(firstParams().code_like).toBe('A');
    expect(firstParams().limit).toBe(200);
    scope.stop();
  });

  it('T8（2026-09-30 regression guard）：description / color 字段在 JSON 响应中被后端 skip_serializing_if 省略 → 仍能 parse', async () => {
    // 背景（2026-09-30 回归）：后端 ProcessOut
    // (backend-rust src/modules/prod/process/vo/process.rs:15-20) 对
    // description (line 15) / color (line 19) 两个 Option<String> 字段加了
    // #[serde(skip_serializing_if = "Option::is_none")] —— None 时整个字段从 JSON
    // 响应中省略（不是序列化为 null）。老 schema 只 .nullable() 不 .optional()，
    // 字段缺失时 Zod 抛 Required error → 整表 parse 失败 → queryFn 抛错 →
    // data === undefined → ProcessTab.vue 表格空 / WorkerQueueBoard.vue
    // 没有 INHOUSE 工序 tab / usePartDispatch.ts 工序下拉空（3 处走 Zod parse
    // 的共用 caller）。processSchema 已升级 description / color 为
    // `.nullable().optional()`，本用例锁死「字段缺失」场景。
    //
    // mockResolvedValue（持久）而非 Once —— useQuery 在 setup 时会自动发起首调，
    // 紧接的 refetch 是第二调，两次都必须命中我们的 mock；Once 只够一次，会让
    // refetch 落到 beforeEach 默认的 mockResolvedValue（空 items）→ 误判
    // data.value.items.length === 0。
    realListProcessesMock.mockResolvedValue({
      items: [
        {
          id: '170000000000001',
          version: 1,
          code: 'CNC',
          name: '数控加工',
          category: 'INHOUSE',
          sort_order: 1,
          requires_approval: false,
          is_cnc: true,
          created_at: '',
          updated_at: '',
          // description / color 字段被后端跳过序列化（None），整个 key 不出现
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    });

    const scope = effectScope();
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery({ limit: 200 }));
    });

    await q!.refetch();
    expect(q!.isError.value).toBe(false);
    expect(q!.data.value?.items.length).toBe(1);
    // 字段缺失在 Zod 默认 strip 模式下被吃成 undefined（不是 null）。
    expect(q!.data.value?.items[0]?.description).toBeUndefined();
    expect(q!.data.value?.items[0]?.color).toBeUndefined();
    // 必填字段未被本回归牵连，保持原值。
    expect(q!.data.value?.items[0]?.is_cnc).toBe(true);
    scope.stop();
  });

  it('T9（2026-09-30 regression guard）：description / color 字段显式为 null → 仍能 parse（向后兼容）', async () => {
    // 背景（2026-09-30）：T8 是 skip_serializing_if 缺字段场景，本用例是显式
    // null 场景 —— schema 升级不能破坏旧契约：原 .nullable() 接受 null 的行为
    // 必须保留。.nullable() + .optional() 正交并存后两条路径都通。
    // 同样用持久 mockResolvedValue 让首调 + refetch 都拿到我们的 null 响应。
    realListProcessesMock.mockResolvedValue({
      items: [
        {
          id: '170000000000002',
          version: 1,
          code: 'OUT',
          name: '外协',
          category: 'OUTSOURCE',
          sort_order: 0,
          description: null,
          requires_approval: true,
          color: null,
          is_cnc: false,
          created_at: '',
          updated_at: '',
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    });

    const scope = effectScope();
    let q: ReturnType<typeof useProcessesQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useProcessesQuery({ limit: 200 }));
    });

    await q!.refetch();
    expect(q!.isError.value).toBe(false);
    expect(q!.data.value?.items.length).toBe(1);
    expect(q!.data.value?.items[0]?.description).toBeNull();
    expect(q!.data.value?.items[0]?.color).toBeNull();
    scope.stop();
  });
});