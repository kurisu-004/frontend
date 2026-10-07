// src/views/outsource/composables/__tests__/useOutsourceSentPartsQuery.spec.ts
//
// 外协对账主查询（`GET /api/v2/outsource-companies/{id}/sent-parts`）的接线 guard。
// 与公司一览那套同构，额外覆盖 companyId 相关的三条：
//   - companyId 空串 → `enabled=false`，零请求；
//   - 切公司换键（companyId 走**独立键位**，不与 filters 混在一个对象里）；
//   - queryFn 二次守卫（防显式 refetch 打出 `/outsource-companies//sent-parts`）。
//
// 覆盖：
//   - SQ1：companyId + 全套筛选进 api 入参。
//   - SQ2：改 params（筛选 / 分页）后 refetch 收到新值（queryFn 从 queryKey 读）。
//   - SQ3：companyId 为空 → 零请求。
//   - SQ4：queryKey 走 qk.outsourceSentParts 工厂（companyId 单独占键位）。
//   - SQ5：信封缺 `outsource_company_name` → error 态（页头公司名的唯一来源）。
//   - SQ6：行缺 `process_id` → error 态（「外协工序」列与该列筛选都按它渲染）。
//   - SQ7：invalidateOutsourceSentPartsAll 走前缀键。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 后端 `OutsourceSentPartOut` 全字段（16）。 */
const sentPartFixture = {
  shipment_id: '800000000000001',
  version: 2,
  part_drawing_no: 'DWG-1',
  part_name: '连杆',
  customer_path: '一级/二级',
  batch_no: 7,
  process_id: '200000000000001',
  process_name: '外协-切割',
  quantity: 10,
  unit_price: '12.50',
  total_price: '125.00',
  sent_at: '2026-10-01T08:00:00',
  received_at: null,
  status: 'OUTSOURCING',
  is_billed: false,
  is_urgent: true,
};

function makeEnvelope(companyId: string, companyName: string | null = '福州精工外协') {
  return {
    outsource_company_id: companyId,
    outsource_company_name: companyName,
    items: [sentPartFixture],
    total: 1,
    limit: 50,
    offset: 0,
  };
}

const realList = vi.fn<(companyId: string, params: unknown) => Promise<unknown>>();

vi.mock('@/api/outsource', () => ({
  listCompanySentParts: (companyId: string, params: unknown) => realList(companyId, params),
}));

import {
  invalidateOutsourceSentPartsAll,
  useOutsourceSentPartsQuery,
} from '../useOutsourceSentPartsQuery';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourceSentPartsQuery — 外协对账主查询', () => {
  beforeEach(() => {
    realList.mockClear();
    realList.mockImplementation(async (companyId) => makeEnvelope(companyId));
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

  it('SQ1：companyId + 全套筛选进 api 入参（公司 id 走路径、不在 params 里）', async () => {
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceSentPartsQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({
          params: () => ({
            company_id: '190000000000900',
            drawing_no: 'DWG',
            name: '连杆',
            customer_id: 'CU1',
            process_id: 'PR1',
            is_billed: false,
            sent_from: '2026-10-01T00:00:00',
            received_to: '2026-10-09T23:59:59',
            sort_by: 'SENT_AT',
            sort_dir: 'DESC',
            limit: 50,
            offset: 0,
          }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(realList).toHaveBeenCalledWith('190000000000900', {
      drawing_no: 'DWG',
      name: '连杆',
      customer_id: 'CU1',
      process_id: 'PR1',
      is_billed: false,
      sent_from: '2026-10-01T00:00:00',
      received_to: '2026-10-09T23:59:59',
      sort_by: 'SENT_AT',
      sort_dir: 'DESC',
      limit: 50,
      offset: 0,
    });
    scope.stop();
  });

  it('SQ2：改 params（筛选 / 分页）后 refetch 收到新值（queryFn 从 queryKey 读）', async () => {
    const paramsRef: Ref<Record<string, unknown>> = ref({
      company_id: '190000000000900',
      limit: 50,
      offset: 0,
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceSentPartsQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({ params: paramsRef, enabled: true }),
      );
    });
    await q.query.refetch();
    expect(realList).toHaveBeenLastCalledWith('190000000000900', { limit: 50, offset: 0 });

    paramsRef.value = { company_id: '190000000000900', limit: 20, offset: 60 };
    await q.query.refetch();
    expect(realList).toHaveBeenLastCalledWith('190000000000900', { limit: 20, offset: 60 });
    scope.stop();
  });

  it('SQ3：companyId 为空串 → 零请求（enabled 闸门）', async () => {
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({
          params: () => ({ company_id: '', limit: 50, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await Promise.resolve();
    expect(realList).not.toHaveBeenCalled();
    scope.stop();
  });

  it('SQ3b：enabled=false 时显式 refetch 仍不发请求（queryFn 二次守卫）', async () => {
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceSentPartsQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({
          params: () => ({ company_id: '', limit: 50, offset: 0 }),
          enabled: true,
        }),
      );
    });
    // refetch 绕过 enabled 是显式调用路径；queryFn 内必须有二次守卫，否则会打出
    // `/outsource-companies//sent-parts`（后端 404 / 422）。
    await q.query.refetch().catch(() => undefined);
    expect(realList).not.toHaveBeenCalled();
    expect(q.query.error.value?.message).toContain('company_id required');
    scope.stop();
  });

  it('SQ4：queryKey 走 qk 工厂，companyId 单独占键位（切公司换缓存身份）', () => {
    expect(qk.outsourceSentParts({ companyId: 'C1', filters: { limit: 50, offset: 0 } })).toEqual([
      'outsource',
      'sent-parts',
      'C1',
      { limit: 50, offset: 0 },
    ]);
    expect(qk.outsourceSentPartsPrefix).toEqual(['outsource', 'sent-parts']);
  });

  it('SQ5：信封缺 outsource_company_name → error 态（页头公司名的唯一来源）', async () => {
    realList.mockImplementation(async () => {
      const envelope = makeEnvelope('C1') as Record<string, unknown>;
      delete envelope.outsource_company_name;
      return envelope;
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceSentPartsQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({
          params: () => ({ company_id: 'C1', limit: 50, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeTruthy();
    scope.stop();
  });

  it('SQ6：行缺 process_id → error 态（「外协工序」列与该列筛选都按它渲染）', async () => {
    realList.mockImplementation(async (companyId) => {
      const envelope = makeEnvelope(companyId);
      const row = { ...(envelope.items[0] as Record<string, unknown>) };
      delete row.process_id;
      return { ...envelope, items: [row] };
    });
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceSentPartsQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({
          params: () => ({ company_id: 'C1', limit: 50, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeTruthy();
    scope.stop();
  });

  it('SQ7：公司不存在时 outsource_company_name = null 仍放行（端点不 404）', async () => {
    realList.mockImplementation(async (companyId) => makeEnvelope(companyId, null));
    const scope = effectScope();
    let q!: ReturnType<typeof useOutsourceSentPartsQuery>;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourceSentPartsQuery({
          params: () => ({ company_id: 'C1', limit: 50, offset: 0 }),
          enabled: true,
        }),
      );
    });
    await q.query.refetch();
    expect(q.query.error.value).toBeNull();
    expect(q.query.data.value?.outsource_company_name).toBeNull();
    scope.stop();
  });

  it('SQ8：invalidateOutsourceSentPartsAll 走前缀键（任意 companyId 一把全失效）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourceSentPartsAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource', 'sent-parts'] });
  });
});