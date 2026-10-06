// src/views/inspection/composables/__tests__/useInspectionQueueQuery.spec.ts
//
// 「待品检一览」主查询 hook（useInspectionQueueQuery）的回归保护。
//
// 覆盖：
//   - Q1：queryKey 形态 = ['inspection','queue',params]（params 直接进键）。
//   - Q2：queryFn **从 queryKey 读 params**（reactive params 范式）—— 改 params 后
//     调 fetchList 发出的必须是新值（闭包捕获 stale 的 guard）。
//   - Q3：enabled 闸门 —— false 时**不发请求**；翻 true 后自动首屏 fetch。
//   - Q4：fetchList 别名能驱动 refetch（视图「刷新」/ 写后刷新 / OCC 冲突都走它）。
//   - Q5：Zod 守门在 queryFn —— 行缺必填字段（part_id）→ error 态 + ElMessage 桥接；
//     分页信封 total 传 number 也抛错（后端是 JSON string）。

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

vi.mock('@/api/inspection', () => ({
  listInspectionBatches: (params: unknown) => fetchMock(params),
}));

import { ElMessage } from 'element-plus';
import { qk } from '@/composables/queries/keys';
import type { ListInspectionQueueParams } from '@/api/inspection';
import { useInspectionQueueQuery } from '../useInspectionQueueQuery';

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: '3000000000001',
    batch_no: 1,
    quantity: 5,
    version: 2,
    part_id: '4000000000001',
    serial_no: 'SN-2026-001',
    drawing_no: 'DWG-A001',
    name: '零件A',
    system_delivery_date: '2026-10-08',
    is_urgent: false,
    customer_id: '9000000000001',
    customer_name: '客户A-子',
    l1_customer_name: '客户A',
    ...overrides,
  };
}

/** 分页信封：total / limit / offset 是 JSON **string**（后端 serialize_i64）。 */
function makeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { items: [makeRow()], total: '1', limit: '20', offset: '0', ...overrides };
}

function baseParams(overrides: Partial<ListInspectionQueueParams> = {}) {
  return {
    drawing_no: undefined,
    name: undefined,
    serial_no: undefined,
    customer_id: undefined,
    system_delivery_date_from: undefined,
    system_delivery_date_to: undefined,
    sort_by: 'SYSTEM_DELIVERY_DATE' as const,
    sort_dir: 'ASC' as const,
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

function mountHook(opts: {
  params: MaybeRefOrGetter<ListInspectionQueueParams>;
  enabled: MaybeRefOrGetter<boolean>;
  autoRefresh?: MaybeRefOrGetter<boolean>;
}) {
  const scope = effectScope();
  let c: ReturnType<typeof useInspectionQueueQuery> | undefined;
  scope.run(() => {
    c = testApp.runWithContext(() =>
      useInspectionQueueQuery({ ...opts, autoRefresh: opts.autoRefresh ?? false }),
    );
  });
  return { scope, comp: c! };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('useInspectionQueueQuery — 待品检队列主查询', () => {
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

  it('Q1：queryKey = ["inspection","queue",params]', async () => {
    const params = ref(baseParams());
    const { scope } = mountHook({ params, enabled: true });
    await sleep(30);

    const found = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.inspectionQueueList(params.value) });
    expect(found).toBeTruthy();
    expect(found?.queryKey[0]).toBe('inspection');
    expect(found?.queryKey[1]).toBe('queue');
    expect(found?.queryKey[2]).toEqual(params.value);
    scope.stop();
  });

  it('Q2：queryFn 从 queryKey 读 params（改 params 后发新值，不发 stale 快照）', async () => {
    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await comp.fetchList();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));

    // 改筛选 + 翻页：params 变化换键 → 新请求带新值
    params.value = baseParams({ serial_no: 'SN-2026-001', offset: 40 });
    await sleep(30);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ serial_no: 'SN-2026-001', offset: 40 }),
    );
    expect(comp.data.value?.total).toBe('1');
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

  it('Q5a：行缺必填字段 part_id → error 态 + ElMessage 桥接（守门在 queryFn）', async () => {
    fetchMock.mockResolvedValue(makeResult({ items: [{ ...makeRow(), part_id: undefined }] }));

    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await sleep(30);

    expect(comp.error.value).not.toBeNull();
    expect(comp.data.value).toBeUndefined();
    await nextTick();
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });

  it('Q5b：分页计数传 number → 抛错（后端 total 是 JSON string）', async () => {
    fetchMock.mockResolvedValue({
      items: [makeRow()],
      total: 1,
      limit: 20,
      offset: 0,
    });

    const params = ref(baseParams());
    const { scope, comp } = mountHook({ params, enabled: true });
    await sleep(30);

    expect(comp.error.value).not.toBeNull();
    scope.stop();
  });
});
