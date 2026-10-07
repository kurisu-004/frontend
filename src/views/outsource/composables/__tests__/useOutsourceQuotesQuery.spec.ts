// src/views/outsource/composables/__tests__/useOutsourceQuotesQuery.spec.ts
//
// 外协报价一览主查询（`GET /api/v2/outsource-quotes`）的接线 guard。与公司一览 / 对账
// 两套同构，额外覆盖状态筛选（`statuses[]`）这条链路 —— 它是本域最隐蔽的故障点：
// 后端此前 DTO 少字段 + service 恒传 `&[]`，前端发的 `statuses[]` 被 serde **静默忽略**
// （不报错），于是「状态筛选恒不生效」而表头因 active 变蓝加粗、视觉上在说「已生效」。
//
// 覆盖：
//   - QQ1：全套筛选进 api 入参，`statuses` 以**数组**形态交给 api 层（序列化成 CSV 单值
//     由 `src/api/http.ts` 的 `ARRAY_AS_CSV_KEYS` 负责，hook 不自己 join）。
//   - QQ2：改 statuses / 排序 / 分页后 refetch 收到新值（queryFn 从 queryKey 读）。
//   - QQ3：enabled=false → 零请求。
//   - QQ4：queryKey 走 qk.outsourceQuotes 工厂。
//   - QQ5：行缺 `version` → error 态（submit / approve / reject / soft-delete 的 OCC 锚）。
//   - QQ6：行缺展示用补全字段之一（process_name）→ error 态。
//   - QQ7：status 收 string —— legacy 值（OUTSOURCING / BILLED / …）不得让整页 parse 失败。
//   - QQ8：invalidateOutsourceQuotesAll 走前缀键。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 后端 `OutsourceQuoteOut` 全字段（22）。 */
function makeQuote() {
  return {
    id: '700000000000001',
    version: 1,
    part_id: '400000000000001',
    outsource_company_id: '190000000000900',
    process_id: '200000000000001',
    price: '12.50',
    note: null,
    status: 'DRAFT',
    submitted_at: null,
    reviewed_at: null,
    review_note: null,
    created_at: '2026-10-01T08:00:00',
    updated_at: '2026-10-01T08:00:00',
    part_serial_no: 'SN-1',
    part_drawing_no: 'DWG-1',
    part_name: '连杆',
    outsource_company_name: '福州精工外协',
    process_code: 'PPSEND',
    process_name: '外协-切割',
    customer_path: '一级/二级',
    part_unit_price: '100.00',
    is_urgent: false,
  };
}

const realList = vi.fn<(params: unknown) => Promise<unknown>>();

vi.mock('@/api/outsource', () => ({
  listOutsourceQuotes: (params: unknown) => realList(params),
}));

import { invalidateOutsourceQuotesAll, useOutsourceQuotesQuery } from '../useOutsourceQuotesQuery';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourceQuotesQuery — 外协报价一览主查询', () => {
  beforeEach(() => {
    realList.mockClear();
    realList.mockImplementation(async () => ({
      items: [makeQuote()],
      total: 1,
      limit: 20,
      offset: 0,
    }));
    testQueryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
    });
    testApp = createApp({});
    testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  });

  afterEach(() => {
    testQueryClient.unmount();
    vi.restoreAllMocks();
  });

  it('QQ1：全套筛选进 api 入参，statuses 以数组形态交出（不自己 join）', async () => {
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceQuotesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceQuotesQuery({
          params: () => ({
            statuses: ['DRAFT', 'SUBMITTED'],
            drawing_no: 'DWG',
            name: '连杆',
            outsource_company_id: '190000000000900',
            customer_id: 'CU1',
            is_urgent: true,
            sort_by: 'PRICE',
            sort_dir: 'ASC',
            limit: 20,
            offset: 0,
          }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(realList).toHaveBeenCalledWith({
      statuses: ['DRAFT', 'SUBMITTED'],
      drawing_no: 'DWG',
      name: '连杆',
      outsource_company_id: '190000000000900',
      customer_id: 'CU1',
      is_urgent: true,
      sort_by: 'PRICE',
      sort_dir: 'ASC',
      limit: 20,
      offset: 0,
    });
    scope.stop();
  });

  it('QQ2：改 statuses / 排序 / 分页后 refetch 收到新值', async () => {
    const paramsRef: Ref<Record<string, unknown>> = ref({
      statuses: ['DRAFT'],
      limit: 20,
      offset: 0,
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceQuotesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceQuotesQuery({ params: paramsRef, enabled: true }),
      );
    });
    await q.query.refetch();
    expect(realList).toHaveBeenLastCalledWith({ statuses: ['DRAFT'], limit: 20, offset: 0 });

    paramsRef.value = { statuses: ['SUBMITTED'], sort_by: 'PRICE', sort_dir: 'ASC', limit: 50, offset: 50 };
    await q.query.refetch();
    expect(realList).toHaveBeenLastCalledWith({
      statuses: ['SUBMITTED'],
      sort_by: 'PRICE',
      sort_dir: 'ASC',
      limit: 50,
      offset: 50,
    });
    scope.stop();
  });

  it('QQ3：enabled=false → 零请求', async () => {
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() =>
        useOutsourceQuotesQuery({ params: () => ({ limit: 20, offset: 0 }), enabled: false }),
      );
    });
    await Promise.resolve();
    expect(realList).not.toHaveBeenCalled();
    scope.stop();
  });

  it('QQ4：queryKey 走 qk 工厂（含 params 维度）', () => {
    expect(qk.outsourceQuotes({ limit: 20, offset: 0 })).toEqual([
      'outsource',
      'quotes',
      { limit: 20, offset: 0 },
    ]);
    expect(qk.outsourceQuotesPrefix).toEqual(['outsource', 'quotes']);
  });

  it('QQ5：行缺 version → error 态（四条写路径的 OCC 锚）', async () => {
    realList.mockImplementation(async () => {
      const quote = makeQuote() as Record<string, unknown>;
      delete quote.version;
      return { items: [quote], total: 1, limit: 20, offset: 0 };
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceQuotesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceQuotesQuery({ params: () => ({ limit: 20, offset: 0 }), enabled: true }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeTruthy();
    scope.stop();
  });

  it('QQ6：行缺展示用补全字段（process_name）→ error 态', async () => {
    realList.mockImplementation(async () => {
      const quote = makeQuote() as Record<string, unknown>;
      delete quote.process_name;
      return { items: [quote], total: 1, limit: 20, offset: 0 };
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceQuotesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceQuotesQuery({ params: () => ({ limit: 20, offset: 0 }), enabled: true }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeTruthy();
    scope.stop();
  });

  // 锁相反方向：legacy 状态**不该**让整页 parse 失败（它们没有操作按钮，但行必须在）。
  it('QQ7：legacy status 值照常 parse（锁枚举会把历史行整页打掉）', async () => {
    realList.mockImplementation(async () => ({
      items: [{ ...makeQuote(), status: 'BILLED' }],
      total: 1,
      limit: 20,
      offset: 0,
    }));
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceQuotesQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceQuotesQuery({ params: () => ({ limit: 20, offset: 0 }), enabled: true }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeNull();
    expect(q.query.data.value?.items[0]?.status).toBe('BILLED');
    scope.stop();
  });

  it('QQ8：invalidateOutsourceQuotesAll 走前缀键（任意 params 一把全失效）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourceQuotesAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource', 'quotes'] });
  });
});