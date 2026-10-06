// src/views/production/queue/composables/__tests__/useQueueSnapshot.spec.ts
//
// 队列快照 query 的接线 guard（常量键 + Zod 守门 + error 桥接 + 前缀失效）。
//
// 覆盖：
//   - S1：fetchQueueSnapshot 被调一次，queryFn 走 schema 守门（出参字段驱动徽标，
//     漏声明字段会被 strip 静默丢掉）。
//   - S2：出参缺 `pending_count`（tab 标题徽标的唯一数据源）→ query 进入 error 态。
//   - S3：queryKey 走 qk.productionQueueSnapshot 工厂（禁止调用点拼字面量数组）。
//   - S4：staleTime = 30_000 / gcTime = 5min（**有限值**）—— 本轮零 WS 订阅，
//     gcTime 设成 POSITIVE_INFINITY 会让「切走 5 分钟后回来」仍命中无限陈旧快照。
//   - S5：invalidateQueueSnapshot 走 qk.productionQueueSnapshotPrefix 前缀。
//   - S6：request 失败 → ElMessage.error 桥接被调（error 不在 setup 抛错）。
//
// 测试策略：
//   - vi.mock('@/api/productionQueue')：fetchQueueSnapshot 替换为 vi.fn()；
//   - vi.mock('element-plus')：ElMessage 桩成 no-op；
//   - effectScope + createApp(VueQueryPlugin) 拿到真实的 useQuery 生命周期。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 队列快照响应。`pending_count` 缺省时用 `withoutPending` 制造契约漂移。 */
const realFetchQueueSnapshot = vi.fn<() => Promise<unknown>>(async () => ({
  processes: [
    {
      process_id: '2000000000001',
      process_code: 'CNC-01',
      process_name: '粗加工',
      color: '#409EFF88',
      category: 'INHOUSE',
      pool_count: 3,
    },
  ],
  pending_count: 12,
  ts: '2026-10-08T09:12:33+08:00',
}));

vi.mock('@/api/productionQueue', () => ({
  fetchQueueSnapshot: () => realFetchQueueSnapshot(),
  fetchQueueBoard: vi.fn(),
  fetchPendingBatches: vi.fn(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
  recallToPending: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
  refillQueue: vi.fn(),
}));

import { useQueueSnapshot, invalidateQueueSnapshot } from '../useQueueSnapshot';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useQueueSnapshot — 队列快照 query', () => {
  beforeEach(() => {
    realFetchQueueSnapshot.mockClear();
    realFetchQueueSnapshot.mockResolvedValue({
      processes: [
        {
          process_id: '2000000000001',
          process_code: 'CNC-01',
          process_name: '粗加工',
          color: '#409EFF88',
          category: 'INHOUSE',
          pool_count: 3,
        },
      ],
      pending_count: 12,
      ts: '2026-10-08T09:12:33+08:00',
    });
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

  it('S1：fetchQueueSnapshot 被调一次且解析出徽标字段', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useQueueSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueSnapshot());
    });
    await q!.refetch();
    expect(realFetchQueueSnapshot).toHaveBeenCalledTimes(1);
    expect(q!.data.value?.pending_count).toBe(12);
    expect(q!.data.value?.processes[0]?.pool_count).toBe(3);
    scope.stop();
  });

  it('S2：出参缺 pending_count → query 进 error 态（守门不是摆设）', async () => {
    realFetchQueueSnapshot.mockResolvedValue({
      processes: [],
      ts: '2026-10-08T09:12:33+08:00',
    });
    const scope = effectScope();
    let q: ReturnType<typeof useQueueSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueSnapshot());
    });
    await q!.refetch();
    expect(q!.error.value).toBeTruthy();
    scope.stop();
  });

  it('S3：queryKey 走 qk 工厂（常量键，不在调用点拼字面量数组）', () => {
    expect(qk.productionQueueSnapshot()).toEqual(['production-queue', 'snapshot']);
    expect(qk.productionQueueSnapshotPrefix).toEqual(['production-queue', 'snapshot']);
  });

  it('S4：staleTime 30s / gcTime 5min（有限值，非 POSITIVE_INFINITY）', async () => {
    // 本轮队列页零 WS 订阅 ⇒ 没有事件 invalidate；gcTime 设成无限会让「切走很久再回来」
    // 命中一份无限陈旧的快照（dashboard 域的 POSITIVE_INFINITY 例外不适用）。
    const scope = effectScope();
    let q: ReturnType<typeof useQueueSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueSnapshot());
    });
    await q!.refetch();
    const entry = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.productionQueueSnapshot() });
    const opts = entry?.options as { staleTime?: number; gcTime?: number };
    expect(opts?.staleTime).toBe(30_000);
    expect(opts?.gcTime).toBe(5 * 60 * 1000);
    scope.stop();
  });

  it('S5：invalidateQueueSnapshot 走前缀键（写后失效的唯一入口）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateQueueSnapshot(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['production-queue', 'snapshot'] });
  });

  it('S6：请求失败 → ElMessage.error 桥接被调（error 不在 setup 抛错）', async () => {
    const { ElMessage } = await import('element-plus');
    realFetchQueueSnapshot.mockRejectedValueOnce(new Error('boom'));
    const scope = effectScope();
    let q: ReturnType<typeof useQueueSnapshot> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueSnapshot());
    });
    await q!.refetch();
    await Promise.resolve();
    expect(q!.error.value?.message).toContain('boom');
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });
});