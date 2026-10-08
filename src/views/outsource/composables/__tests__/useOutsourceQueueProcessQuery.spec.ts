// src/views/outsource/composables/__tests__/useOutsourceQueueProcessQuery.spec.ts
//
// 单工序外协看板 query 的接线 guard：reactive params + enabled 闸门 + queryFn 二次守卫
// + Zod 守门 + **前缀**失效。
//
// 覆盖：
//   - PQ1：传静态 string → fetchOutsourceQueueProcess 收到该 processId。
//   - PQ2：传 Ref → 改 ref.value 后 refetch，收到新 processId（reactive params guard：
//     queryFn 从 queryKey 读最新值，不闭包捕获 stale 值）。
//   - PQ3：processId 为 null / 空串 → enabled=false，**零请求**。
//   - PQ4：enabled=false 时显式 refetch 仍不发请求（queryFn 的二次守卫；防打出
//     `/outsource-queue/processes/` 空路径）。
//   - PQ5：queryKey 走 qk.outsourceQueueProcess 工厂（禁止调用点拼字面量数组）。
//   - PQ6：出参缺 companies[].held_batches → query 进 error 态（守门承重字段：在途卡
//     内联在列上，漏声明会让整个右列空掉）。
//   - PQ7：staleTime 30s / gcTime 5min（有限值，本域零 WS 订阅）。
//   - PQ8：invalidateOutsourceQueueProcessAll 走前缀键（**任意 processId 形态**一把全
//     失效 —— 一次移动同时改左列与右列，mutation 回调拿不到受影响的 processId）。
//
// 测试策略：
//   - vi.mock('@/api/outsource')：fetchOutsourceQueueProcess 替换为 vi.fn()；
//   - vi.mock('element-plus')：ElMessage 桩成 no-op；
//   - effectScope + createApp(VueQueryPlugin) 拿到真实的 useQuery 生命周期。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 候选卡 fixture（APPROVAL 形态，26 字段）。 */
const candidate = {
  version: 3,
  send_mode: 'APPROVAL',
  part_id: '4000000000001',
  part_serial_no: 'SN-0001',
  part_drawing_no: 'DRW-1',
  part_name: '连杆',
  quantity: 12,
  batch_id: '3000000000001',
  batch_no: 1024,
  planned_delivery_date: '2026-10-20',
  is_urgent: false,
  has_process_chain: true,
  customer_name: '某某零件厂',
  parent_customer_name: '某某集团',
  shelf_code: 'A-01',
  shelf_id: '5000000000001',
  outsource_company_id: '9000000000001',
  outsource_company_name: '外协厂甲',
  quote_id: '7000000000001',
  company_options: [],
  price: '12.50',
  has_cnc_program: true,
  applicant_name: '张三',
  note: null,
  system_delivery_date: '2026-10-18',
  can_send: true,
};

/** 在途卡 fixture（22 字段）。 */
const heldBatch = {
  batch_id: '3000000000002',
  part_id: '4000000000002',
  batch_no: 1025,
  quantity: 8,
  serial_no: null,
  drawing_no: 'DRW-2',
  name: '齿轮',
  system_delivery_date: null,
  planned_delivery_date: '2026-10-25',
  is_urgent: true,
  customer_name: '某某零件厂',
  parent_customer_name: null,
  applicant_name: null,
  location: 'OUTSOURCE_COMPANY',
  note: null,
  version: 5,
  sent_at: '2026-10-01T09:00:00',
  price: '8.00',
  receive_next_process_id: '2000000000002',
  receive_next_process_name: '外协热处理',
  chain_resolvable: true,
  has_cnc_program: false,
};

/** 单工序看板响应。companies[] 特意含一个 `held_count = 0` 的空列（合法投放落点）。 */
function makeDetail(processId: string) {
  return {
    process: {
      process_id: processId,
      process_code: 'PPSEND',
      process_name: '外协-切割',
      color: null,
    },
    companies: [
      { company_id: '9000000000001', name: '外协厂甲', held_count: 1, held_batches: [heldBatch] },
      { company_id: '9000000000002', name: '外协厂乙', held_count: 0, held_batches: [] },
    ],
    items: [candidate],
    total: 1,
    ts: '2026-10-08T10:00:00+08:00',
  };
}

const realFetchProcess = vi.fn<(processId: string) => Promise<unknown>>(
  async (processId) => makeDetail(processId),
);

vi.mock('@/api/outsource', () => ({
  fetchOutsourceQueueProcess: (processId: string) => realFetchProcess(processId),
  fetchOutsourceQueueSnapshot: vi.fn(),
  moveOutsourceBatch: vi.fn(),
}));

import {
  useOutsourceQueueProcessQuery,
  invalidateOutsourceQueueProcessAll,
} from '../useOutsourceQueueProcessQuery';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourceQueueProcessQuery — 单工序外协看板 query', () => {
  beforeEach(() => {
    realFetchProcess.mockClear();
    realFetchProcess.mockImplementation(async (pid: string) => makeDetail(pid));
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
    vi.restoreAllMocks();
  });

  it('PQ1：传静态 string → fetchOutsourceQueueProcess 收到该 processId', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => '9000000000000000501'));
    });
    await q!.refetch();
    expect(realFetchProcess).toHaveBeenCalledWith('9000000000000000501');
    scope.stop();
  });

  it('PQ2：传 Ref → 改值后 refetch 收到新 processId（queryFn 从 queryKey 读最新值）', async () => {
    const pidRef: Ref<string | null> = ref('9000000000000000501');
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => pidRef.value));
    });
    await q!.refetch();
    expect(realFetchProcess).toHaveBeenLastCalledWith('9000000000000000501');

    pidRef.value = '9000000000000000502';
    await q!.refetch();
    // 若 queryFn 闭包捕获了入参快照，这里会拿到上一个工序的响应 / 旧 processId
    expect(realFetchProcess).toHaveBeenLastCalledWith('9000000000000000502');
    scope.stop();
  });

  it('PQ3：processId 为 null / 空串 → enabled=false，零请求', async () => {
    for (const pid of [null, '']) {
      const scope = effectScope();
      scope.run(() => {
        testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => pid));
      });
      await Promise.resolve();
      expect(realFetchProcess).not.toHaveBeenCalled();
      scope.stop();
    }
  });

  it('PQ4：enabled=false 时显式 refetch 也不发请求（queryFn 二次守卫）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => ''));
    });
    // refetch 绕过 enabled 是显式调用路径；queryFn 内必须有二次守卫，否则会打出
    // `/outsource-queue/processes/` 空路径（后端 404 / 422）。
    await q!.refetch().catch(() => undefined);
    expect(realFetchProcess).not.toHaveBeenCalled();
    expect(q!.error.value?.message).toContain('processId required');
    scope.stop();
  });

  it('PQ5：queryKey 走 qk 工厂（含 processId 维度）', () => {
    expect(qk.outsourceQueueProcess('9000000000000000501')).toEqual([
      'outsource-queue',
      'process',
      '9000000000000000501',
    ]);
    expect(qk.outsourceQueueProcessPrefix).toEqual(['outsource-queue', 'process']);
  });

  it('PQ6：出参缺 companies[].held_batches → query 进 error 态', async () => {
    // 回归 guard：在途卡内联在公司列上（公司列零请求），`held_batches` 漏声明会被
    // strip 静默丢掉 ⇒ 整个右列恒空，且 parse 照过不报错。
    realFetchProcess.mockImplementation(async (pid: string) => {
      const detail = makeDetail(pid) as unknown as Record<string, unknown>;
      const companies = detail.companies as Array<Record<string, unknown>>;
      delete companies[0]!.held_batches;
      return detail;
    });
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => '9000000000000000503'));
    });
    await q!.refetch();
    expect(q!.error.value).toBeTruthy();
    scope.stop();
  });

  it('PQ7：staleTime 30s / gcTime 5min（有限值）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => '9000000000000000504'));
    });
    await q!.refetch();
    const entry = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.outsourceQueueProcess('9000000000000000504') });
    const opts = entry?.options as { staleTime?: number; gcTime?: number };
    expect(opts?.staleTime).toBe(30_000);
    expect(opts?.gcTime).toBe(5 * 60 * 1000);
    scope.stop();
  });

  it('PQ8：invalidateOutsourceQueueProcessAll 走前缀键（任意 processId 一把全失效）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourceQueueProcessAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource-queue', 'process'] });
  });

  it('PQ9：空公司列（held_count = 0）原样保留 —— 空列是合法投放落点，不能被守门滤掉', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueProcessQuery(() => '9000000000000000505'));
    });
    await q!.refetch();
    expect(q!.data.value?.companies).toHaveLength(2);
    expect(q!.data.value?.companies[1]?.held_count).toBe(0);
    scope.stop();
  });
});