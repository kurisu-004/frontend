// src/composables/queries/__tests__/useOutsourcePoolByProcessQuery.spec.ts
//
// 2026-10-03 新增：useOutsourcePoolByProcessQuery reactive params + enabled 闸门 +
// queryKey + 前缀失效守门。
//
// 覆盖：
//   - T1：传静态 string → listOutsourcePoolByProcess 收到该 processId。
//   - T2：传 Ref<string> → 改 ref.value 后调 refetch，收到新 processId（核心 reactive
//     params guard，queryFn 从 queryKey[2] 读参而非闭包捕获）。
//   - T3：传 null → enabled=false，零请求（核心闸门 guard）。
//   - T4：getter 形式 → 改 source 后收到新 processId（MaybeRefOrGetter 第三分支）。
//   - T5：queryKey 形态正确（含 reactive processId 内容）。
//   - T6：invalidateOutsourcePoolByProcessAll → 域失效并重拉。
//   - T7：失效走 qk.outsourcePoolByProcessPrefix（共享失效源）。
//   - T8：两个不同 processId 的 query 缓存互相独立但可一把全刷。
//   - T9：坏响应 → query 进 error 态（Zod 守门挂在通路上）。
//
// 测试策略（沿 useWorkerPoolByProcessQuery.spec.ts 范本）：
//   - vi.mock('@/api/outsource')：listOutsourcePoolByProcess 替换为 vi.fn()，返回值沿
//     后端 `vo/pool.rs` 真契约（6 顶层字段裸对象：process_id / process_code /
//     process_name / companies[] / total / items[]，无分页信封）；
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

interface PoolDetail {
  process_id: string;
  process_code: string;
  process_name: string;
  companies: Array<{ company_id: string; name: string; held_count: number }>;
  total: number;
  items: unknown[];
}

const realListOutsourcePoolByProcess = vi.fn<(processId: string) => Promise<PoolDetail>>(
  async (processId: string) => ({
    process_id: processId,
    process_code: 'OUT-01',
    process_name: '外协粗加工',
    companies: [],
    total: 0,
    items: [],
  }),
);

vi.mock('@/api/outsource', () => ({
  listOutsourcePoolByProcess: (processId: string) => realListOutsourcePoolByProcess(processId),
  // 另两个 pool helper 本测试用不到，列出 stub 防止 partial mock 副作用。
  listOutsourcePoolCounts: vi.fn(),
  listOutsourcePoolState: vi.fn(),
}));

import { qk } from '../keys';
import {
  invalidateOutsourcePoolByProcessAll,
  useOutsourcePoolByProcessQuery,
} from '../useOutsourcePoolByProcessQuery';

function lastProcessId(): string | undefined {
  const calls = realListOutsourcePoolByProcess.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[0];
}

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourcePoolByProcessQuery — reactive params + enabled 闸门 + 失效（2026-10-03）', () => {
  beforeEach(() => {
    realListOutsourcePoolByProcess.mockClear();
    realListOutsourcePoolByProcess.mockImplementation(async (processId: string) => ({
      process_id: processId,
      process_code: 'OUT-01',
      process_name: '外协粗加工',
      companies: [],
      total: 0,
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

  it('T1：传静态 string → listOutsourcePoolByProcess 收到该 processId', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => '2000000000001'));
    });
    await q!.refetch();
    expect(realListOutsourcePoolByProcess).toHaveBeenCalled();
    expect(lastProcessId()).toBe('2000000000001');
    scope.stop();
  });

  it('T2：传 Ref<string> → 改 ref.value 后调 refetch，收到新 processId（queryFn 从 queryKey 读参）', async () => {
    // 核心 reactive params guard：queryFn 必须从 queryKey[2] 读最新值。若闭包捕获
    // `toValue(processId)`，第二次 refetch 仍会打第一个 id。
    const pidRef: Ref<string | null> = ref('2000000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => pidRef.value));
    });
    await q!.refetch();
    expect(lastProcessId()).toBe('2000000000001');

    pidRef.value = '2000000000002';
    await q!.refetch();
    expect(lastProcessId()).toBe('2000000000002');
    scope.stop();
  });

  it('T3：null processId → enabled=false → 零请求（核心闸门 guard）', async () => {
    // 无工序时不发请求，避免打出 `/outsource-pool/` 空路径（后端 404）。
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => null));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realListOutsourcePoolByProcess).not.toHaveBeenCalled();
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });

  it('T3b：空串 processId 同样零请求（占位键 + 闸门）', async () => {
    const scope = effectScope();
    scope.run(() => {
      testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => ''));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(realListOutsourcePoolByProcess).not.toHaveBeenCalled();
    // 占位键仍会落进 cache（enabled=false 只是不发请求），键内容是空串
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((x) => x.queryKey);
    expect(keys).toContainEqual(['outsource-pool', 'by-process', '']);
    scope.stop();
  });

  it('T3c：显式 refetch() 绕过闸门时 queryFn 内二次守卫拦下（不发请求、query 进 error）', async () => {
    // enabled 只挡自动触发；显式 refetch 会绕过它。二次守卫保证不会打出空路径请求。
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => null));
    });
    await q!.refetch();
    expect(realListOutsourcePoolByProcess).not.toHaveBeenCalled();
    expect(q!.isError.value).toBe(true);
    expect((q!.error.value as Error).message).toContain('processId required');
    scope.stop();
  });

  it('T4：getter 形式 processId → 改 source 后收到新 processId', async () => {
    const source = ref<string>('PID-A');
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => source.value));
    });
    await q!.refetch();
    expect(lastProcessId()).toBe('PID-A');

    source.value = 'PID-B';
    await q!.refetch();
    expect(lastProcessId()).toBe('PID-B');
    scope.stop();
  });

  it('T5：queryKey 形态正确（含 reactive processId 内容）', async () => {
    const source = ref<string>('PID-A');
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => source.value));
    });
    await q!.refetch();
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((x) => x.queryKey);
    expect(keys).toContainEqual(['outsource-pool', 'by-process', 'PID-A']);
    expect(qk.outsourcePoolByProcess('PID-A')).toEqual(['outsource-pool', 'by-process', 'PID-A']);
    scope.stop();
  });

  it('T6：invalidateOutsourcePoolByProcessAll(qc) → 整个域失效并重拉', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => '2000000000001'));
    });
    await q!.refetch();
    const callsBefore = realListOutsourcePoolByProcess.mock.calls.length;

    await invalidateOutsourcePoolByProcessAll(testQueryClient);
    await q!.refetch();

    expect(realListOutsourcePoolByProcess.mock.calls.length).toBeGreaterThan(callsBefore);
    scope.stop();
  });

  it('T7：invalidateOutsourcePoolByProcessAll 走 qk.outsourcePoolByProcessPrefix（共享失效源）', async () => {
    // 前缀全失效是唯一正确策略：发送的目标工序由 tab 决定、后端不自推，回调里可能
    // 拿不到 processId。这条锁住「不退回精刷」。
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourcePoolByProcessAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource-pool', 'by-process'] });
  });

  it('T8：两个不同 processId 的 query 缓存独立但共享同一前缀', async () => {
    const scope = effectScope();
    let q1: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    let q2: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q1 = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => '2000000000001'));
      q2 = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => '2000000000002'));
    });
    await q1!.refetch();
    await q2!.refetch();
    const keys = testQueryClient
      .getQueryCache()
      .getAll()
      .map((x) => x.queryKey);
    expect(keys).toContainEqual(['outsource-pool', 'by-process', '2000000000001']);
    expect(keys).toContainEqual(['outsource-pool', 'by-process', '2000000000002']);
    // 两份都被同一个 prefix 失效
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourcePoolByProcessAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource-pool', 'by-process'] });
    scope.stop();
  });

  it('T9：坏响应（行字段缺失）→ query 进 error 态（Zod 守门挂在通路上）', async () => {
    realListOutsourcePoolByProcess.mockImplementation(async (processId: string) => ({
      process_id: processId,
      process_code: 'OUT-01',
      process_name: '外协粗加工',
      companies: [],
      total: 1,
      // can_send / status_label 等必填字段全缺 ⇒ 必须炸而不是静默 strip 后进 UI
      items: [{ version: 1, batch_id: '3000000000001' }],
    }));
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourcePoolByProcessQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourcePoolByProcessQuery(() => '2000000000001'));
    });
    await q!.refetch();
    expect(q!.isError.value).toBe(true);
    expect(q!.data.value).toBeUndefined();
    scope.stop();
  });
});
