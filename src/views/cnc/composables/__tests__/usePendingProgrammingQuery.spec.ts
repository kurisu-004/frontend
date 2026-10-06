// src/views/cnc/composables/__tests__/usePendingProgrammingQuery.spec.ts
//
// 「待编程一览」主查询 hook（usePendingProgrammingQuery）的回归保护。
//
// 覆盖：
//   - Q1：queryKey 形态 = ['programming','list',params]（params 直接进键）。
//   - Q2：queryFn **从 queryKey 读 params**（reactive params 范式）—— 改 params 后
//     调 fetchList，发出的必须是新值而不是 setup 那次的快照（闭包捕获 stale 的 guard）。
//   - Q3：enabled 闸门 —— false 时**不发请求**；翻 true 后自动首屏 fetch。
//   - Q4：fetchList 别名能驱动 refetch（视图「刷新」按钮 / 写后刷新都走它）。
//   - Q5：Zod 守门在 queryFn —— 响应缺必填字段（batch_id / batch_version）→
//     query.error 非空、data 不落脏数据、错误经 ElMessage 桥接。
//   - Q6：换 params 走 keepPreviousData 占位（旧数据不闪空）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick, ref, type MaybeRefOrGetter } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

const fetchMock = vi.fn();

vi.mock('@/api/programming', () => ({
  fetchPendingProgramming: (params: unknown) => fetchMock(params),
}));

import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { ListPendingProgrammingParams } from '@/api/programming';
import { usePendingProgrammingQuery } from '../usePendingProgrammingQuery';

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '190000000000099',
    version: 3,
    serial_no: 'SN-001',
    name: '法兰盘',
    drawing_no: 'DWG-A001',
    quantity: 5,
    status: 'PROGRAMMING',
    is_urgent: true,
    planned_delivery_date: '2026-10-10',
    system_delivery_date: null,
    customer_name: '客户A-子',
    parent_customer_name: '客户A',
    has_cnc_program: false,
    batch_id: '190000000000123',
    batch_version: 7,
    ...overrides,
  };
}

function makeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { items: [makeRow()], total: 1, limit: 20, offset: 0, ...overrides };
}

function baseParams(overrides: Partial<ListPendingProgrammingParams> = {}) {
  return {
    has_cnc_program: false,
    keyword: undefined,
    serial_no: undefined,
    sort_by: 'PLANNED_DELIVERY_DATE',
    sort_dir: 'ASC' as const,
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountHook(opts: {
  params: MaybeRefOrGetter<ListPendingProgrammingParams>;
  enabled: MaybeRefOrGetter<boolean>;
  autoRefresh?: MaybeRefOrGetter<boolean>;
}) {
  const scope = effectScope();
  let c: ReturnType<typeof usePendingProgrammingQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() =>
      usePendingProgrammingQuery({ ...opts, autoRefresh: opts.autoRefresh ?? false }),
    );
  });
  return { scope, comp: c! };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('usePendingProgrammingQuery — 待编程列表主查询', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(makeResult());
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

  it('Q1：queryKey = ["programming","list",params]', async () => {
    const params = ref(baseParams());
    const { scope } = mountHook({ params, enabled: true });
    await sleep(30);

    const found = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.programmingList(params.value) });
    expect(found).toBeTruthy();
    expect(found?.queryKey[0]).toBe('programming');
    expect(found?.queryKey[1]).toBe('list');
    expect(found?.queryKey[2]).toEqual(params.value);
    scope.stop();
  });

  it('Q2：queryFn 从 queryKey 读 params（改 params 后发新值，不发 stale 快照）', async () => {
    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await comp.fetchList();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));

    // 翻页：offset 进 params → 换键 → 新请求带新 offset（若 queryFn 闭包捕获了
    // setup 时的 buildParams，这里会仍然是 offset=0）
    params.value = baseParams({ offset: 40 });
    await sleep(30);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 40 }));
    expect(comp.data.value?.total).toBe(1);
    scope.stop();
  });

  it('Q3：enabled=false 时不发请求；翻 true 后自动首屏 fetch', async () => {
    const params = ref(baseParams());
    const enabled = ref(false);
    const { scope } = mountHook({ params, enabled });
    await sleep(30);
    expect(fetchMock).not.toHaveBeenCalled();

    enabled.value = true;
    await sleep(30);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('Q4：fetchList 别名驱动 refetch（保持当前页码，不重写 queryKey）', async () => {
    const params = ref(baseParams({ offset: 40 }));
    const { scope, comp } = mountHook({ params, enabled: true });
    await sleep(30);
    fetchMock.mockClear();

    await comp.fetchList();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 40 }));
    scope.stop();
  });

  it('Q5：Zod 守门在 queryFn —— 缺必填字段（batch_id / batch_version）→ error 态 + ElMessage', async () => {
    // 后端删键时最危险的表现是「静默通过 + 全表下发按钮恒 disabled」，所以守门必须
    // 抛错而不是 strip 后放行。
    fetchMock.mockResolvedValue(makeResult({ items: [{ ...makeRow(), batch_id: undefined }] }));

    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await sleep(30);

    expect(comp.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    await nextTick();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('Q6：换 params 期间走 keepPreviousData 占位（旧数据不闪空表）', async () => {
    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await sleep(30);
    expect(comp.query.isPlaceholderData.value).toBe(false);

    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    params.value = baseParams({ offset: 20 });
    await nextTick();

    // 换键未清空数据：响应到达前仍是上一份（代价：调用方要能区分 isPlaceholderData）
    expect(comp.data.value?.items).toHaveLength(1);
    expect(comp.query.isPlaceholderData.value).toBe(true);

    release(makeResult());
    await sleep(30);
    expect(comp.query.isPlaceholderData.value).toBe(false);
    scope.stop();
  });
});
