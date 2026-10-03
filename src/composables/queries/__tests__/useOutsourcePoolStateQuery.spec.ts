// src/composables/queries/__tests__/useOutsourcePoolStateQuery.spec.ts
//
// 2026-10-03 新增：useOutsourcePoolStateQuery 双 reactive params + enabled 闸门 +
// queryKey + 前缀失效守门。形态照抄 useWorkerStateByWorkerQuery.spec.ts（双参数范本）。
//
// 覆盖：
//   - T1：传静态双参数 → listOutsourcePoolState 收到 outsource_company_id + process_id。
//   - T2：双 Ref 各自变化 → queryFn 从 queryKey[2..3] 读最新值（核心 reactive guard）。
//   - T3：outsourceCompanyId = null → enabled=false，零请求。
//   - T4：processId = null（公司有效） → enabled=false，零请求（双参数闸门）。
//   - T4b：显式 refetch() 绕过闸门时 queryFn 内二次守卫拦下。
//   - T5：queryKey 形态正确（下标 [2]=公司 id / [3]=工序 id）。
//   - T6：两个公司 × 同一工序的 query 缓存独立但共享同一前缀。
//   - T7：invalidateOutsourcePoolStateAll → 域失效并重拉。
//   - T8：失效走 qk.outsourcePoolStatePrefix（共享失效源）。
//   - T9：坏响应（行字段缺失）→ query 进 error 态（Zod 守门挂在通路上）。
//
// 测试策略（沿 useWorkerStateByWorkerQuery.spec.ts 范本）：
//   - vi.mock('@/api/outsource')：listOutsourcePoolState 替换为 vi.fn()，返回值沿后端
//     `vo/pool.rs` 真契约（5 顶层字段裸对象，**无分页信封**）；
//   - vi.mock('element-plus', () => ({ ElMessage: { ...vi.fn() } }))。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

interface PoolState {
  outsource_company_id: string;
  outsource_company_name: string;
  process_id: string;
  current_held: number;
  items: unknown[];
}

const realListOutsourcePoolState = vi.fn<
  (params: { outsource_company_id: string; process_id: string }) => Promise<PoolState>
>(async (params) => ({
  outsource_company_id: params.outsource_company_id,
  outsource_company_name: '外协厂甲',
  process_id: params.process_id,
  current_held: 0,
  items: [],
}));

vi.mock('@/api/outsource', () => ({
  listOutsourcePoolState: (params: { outsource_company_id: string; process_id: string }) =>
    realListOutsourcePoolState(params),
  // 另两个 pool helper 本测试用不到，列出 stub 防止 partial mock 副作用。
  listOutsourcePoolCounts: vi.fn(),
  listOutsourcePoolByProcess: vi.fn(),
}));

import { qk } from '../keys';
import {
  invalidateOutsourcePoolStateAll,
  useOutsourcePoolStateQuery,
} from '../useOutsourcePoolStateQuery';

function lastParams(): { outsource_company_id: string; process_id: string } | undefined {
  const calls = realListOutsourcePoolState.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0] as { outsource_company_id: string; process_id: string } | undefined;
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourcePoolStateQuery — 双 reactive params + enabled 闸门 + 失效（2026-10-03）', () => {
  beforeEach(() => {
    realListOutsourcePoolState.mockClear();
    realListOutsourcePoolState.mockImplementation(async (params) => ({
      outsource_company_id: params.outsource_company_id,
      outsource_company_name: '外协厂甲',
      process_id: params.process_id,
      current_held: 0,
      items: [],
    }));
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

  it('T1：传静态双参数 → api 收到 outsource_company_id + process_id 两个必填参数', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000001',
          () => '2000000000001',
        ),
      );
    });
    await q!.refetch();
    expect(realListOutsourcePoolState).toHaveBeenCalled();
    expect(lastParams()?.outsource_company_id).toBe('9000000000001');
    expect(lastParams()?.process_id).toBe('2000000000001');
    scope.stop();
  });

  it('T2：双 Ref 各自变化 → 改任一 ref.value 后 refetch，api 收到新参数对（queryFn 从 queryKey 读参）', async () => {
    // 核心双参数 reactive guard：queryFn 必须从 queryKey[2..3] 读最新值。若闭包捕获
    // `toValue(...)`，第二次 refetch 仍会打第一对 id。
    const cidRef: Ref<string | null> = ref('9000000000001');
    const pidRef: Ref<string | null> = ref('2000000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => cidRef.value,
          () => pidRef.value,
        ),
      );
    });
    await q!.refetch();
    expect(lastParams()?.outsource_company_id).toBe('9000000000001');
    expect(lastParams()?.process_id).toBe('2000000000001');

    // 只改公司 id
    cidRef.value = '9000000000002';
    await q!.refetch();
    expect(lastParams()?.outsource_company_id).toBe('9000000000002');
    expect(lastParams()?.process_id).toBe('2000000000001');

    // 只改工序 id
    pidRef.value = '2000000000002';
    await q!.refetch();
    expect(lastParams()?.outsource_company_id).toBe('9000000000002');
    expect(lastParams()?.process_id).toBe('2000000000002');
    scope.stop();
  });

  it('T3：outsourceCompanyId = null → enabled=false → 零请求', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => null,
          () => '2000000000001',
        ),
      );
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realListOutsourcePoolState).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T4：processId = null（公司有效） → enabled=false → 零请求（双参数闸门）', async () => {
    // 双参数闸门：公司满足但工序不满足 → 仍不发起请求（后端两个参数都必填）。
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000001',
          () => null,
        ),
      );
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realListOutsourcePoolState).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T4b：显式 refetch() 绕过闸门时 queryFn 内二次守卫拦下（不发请求、query 进 error）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '',
          () => '',
        ),
      );
    });
    await q!.refetch();
    expect(realListOutsourcePoolState).not.toHaveBeenCalled();
    expect(q!.isError.value).toBe(true);
    expect((q!.error.value as Error).message).toContain(
      'outsource_company_id + process_id required',
    );
    scope.stop();
  });

  it('T5：queryKey 形态正确（下标 [2]=公司 id / [3]=工序 id）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000001',
          () => '2000000000001',
        ),
      );
    });
    await q!.refetch();
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((x) => x.queryKey);
    expect(keys).toContainEqual(['outsource-pool', 'state', '9000000000001', '2000000000001']);
    // 键工厂同源（禁止调用点拼字面量数组）
    expect(qk.outsourcePoolState('9000000000001', '2000000000001')).toEqual([
      'outsource-pool',
      'state',
      '9000000000001',
      '2000000000001',
    ]);
    scope.stop();
  });

  it('T6：两个公司 × 同一工序的 query 缓存独立但共享同一前缀', async () => {
    const scope = effectScope();
    let q1: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    let q2: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q1 = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000001',
          () => '2000000000001',
        ),
      );
      q2 = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000002',
          () => '2000000000001',
        ),
      );
    });
    await q1!.refetch();
    await q2!.refetch();
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((x) => x.queryKey);
    expect(keys).toContainEqual(['outsource-pool', 'state', '9000000000001', '2000000000001']);
    expect(keys).toContainEqual(['outsource-pool', 'state', '9000000000002', '2000000000001']);
    scope.stop();
  });

  it('T7：invalidateOutsourcePoolStateAll(qc) → 整个域失效并重拉', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000001',
          () => '2000000000001',
        ),
      );
    });
    await q!.refetch();
    const callsBefore = realListOutsourcePoolState.mock.calls.length;

    await invalidateOutsourcePoolStateAll(testQueryClient);
    await q!.refetch();

    expect(realListOutsourcePoolState.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T8：invalidateOutsourcePoolStateAll 走 qk.outsourcePoolStatePrefix（共享失效源）', async () => {
    // 前缀全失效是唯一正确策略：一次收发同时改多个公司列的持有集合，无法精刷到
    // 某一对 (公司, 工序)。这条锁住「不退回精刷」。
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourcePoolStateAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource-pool', 'state'] });
  });

  it('T9：坏响应（receive_next_process_id 为 null）→ query 进 error 态（"0" 兜底口径守卫）', async () => {
    // 后端沿 `.unwrap_or(0)` 口径把「无下一道工序」兜成 "0"；响应里出现 null 即契约
    // 漂移，守门必须在 API 边界就炸掉（schemas.spec.ts 的 S-OP13 锁同一件事）。
    realListOutsourcePoolState.mockImplementation(async (params) => ({
      outsource_company_id: params.outsource_company_id,
      outsource_company_name: '外协厂甲',
      process_id: params.process_id,
      current_held: 1,
      items: [
        {
          batch_id: '3000000000001',
          part_id: '4000000000001',
          batch_no: 1,
          quantity: 8,
          serial_no: 'SN-001',
          drawing_no: 'DWG-A001',
          name: '法兰盘',
          system_delivery_date: null,
          planned_delivery_date: '2026-10-20',
          is_urgent: false,
          customer_name: '二级客户',
          parent_customer_name: '一级客户',
          applicant_name: '张三',
          location: 'OUTSOURCE_COMPANY',
          note: null,
          version: 5,
          sent_at: '2026-10-01 08:00:00',
          price: '12.50',
          receive_next_process_id: null,
          receive_next_process_name: null,
          chain_resolvable: false,
        },
      ],
    }));
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolStateQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() =>
        useOutsourcePoolStateQuery(
          () => '9000000000001',
          () => '2000000000001',
        ),
      );
    });
    await q!.refetch();
    expect(q!.isError.value).toBe(true);
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });
});
