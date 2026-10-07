// src/views/outsource/composables/__tests__/useOutsourceQueueSnapshotQuery.spec.ts
//
// 外协看板快照 query 的接线 guard（常量键 + Zod 守门 + error 桥接 + 前缀失效）。
//
// 覆盖：
//   - SQ1：fetchOutsourceQueueSnapshot 被调一次，queryFn 走 schema 守门（出参字段驱动
//     tab 双徽标，漏声明字段会被 strip 静默丢掉）。
//   - SQ2：出参缺 `sendable_total`（徽标的唯一数据源）→ query 进入 error 态。
//   - SQ3：queryKey 走 qk.outsourceQueueSnapshot 工厂（禁止调用点拼字面量数组）。
//   - SQ4：staleTime = 30_000 / gcTime = 5min（**有限值**）—— 本域零 WS 订阅（dashboard
//     WS 只推 dashboard 大屏域的事件），gcTime 设成 POSITIVE_INFINITY 会让「切走 5 分钟
//     后回来」仍命中无限陈旧徽标。
//   - SQ5：invalidateOutsourceQueueSnapshotAll 走 qk.outsourceQueueSnapshotPrefix 前缀。
//   - SQ6：请求失败 → ElMessage.error 桥接被调（error 不在 setup 抛错）。
//
// 测试策略：
//   - vi.mock('@/api/outsource')：fetchOutsourceQueueSnapshot 替换为 vi.fn()；
//   - vi.mock('element-plus')：ElMessage 桩成 no-op（node env 下真实 ElMessage 会因
//     `document is not defined` 污染输出）；
//   - effectScope + createApp(VueQueryPlugin) 拿到真实的 useQuery 生命周期。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 外协看板快照响应。缺 `sendable_total` 时用 `withoutTotal` 制造契约漂移。 */
function makeSnapshot() {
  return {
    processes: [
      {
        process_id: '9000000000000000501',
        process_code: 'PPSEND',
        process_name: '外协-切割',
        color: '#2c6cb8ff',
        category: 'OUTSOURCE',
        sendable_count: 3,
        in_flight_count: 1,
      },
    ],
    sendable_total: 3,
    in_flight_total: 1,
    ts: '2026-10-08T10:00:00+08:00',
  };
}

const realFetchSnapshot = vi.fn<() => Promise<unknown>>(async () => makeSnapshot());

vi.mock('@/api/outsource', () => ({
  fetchOutsourceQueueSnapshot: () => realFetchSnapshot(),
  // 列出 stub 防止 partial mock 副作用（本 spec 的被测模块只消费上面这一个）
  fetchOutsourceQueueProcess: vi.fn(),
  moveOutsourceBatch: vi.fn(),
}));

import { useOutsourceQueueSnapshotQuery, invalidateOutsourceQueueSnapshotAll } from '../useOutsourceQueueSnapshotQuery';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useOutsourceQueueSnapshotQuery — 外协看板徽标 query', () => {
  beforeEach(() => {
    realFetchSnapshot.mockClear();
    realFetchSnapshot.mockImplementation(async () => makeSnapshot());
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

  it('SQ1：fetchOutsourceQueueSnapshot 被调一次且解析出双徽标字段', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueSnapshotQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueSnapshotQuery());
    });
    await q!.refetch();
    expect(realFetchSnapshot).toHaveBeenCalledTimes(1);
    expect(q!.data.value?.sendable_total).toBe(3);
    expect(q!.data.value?.in_flight_total).toBe(1);
    expect(q!.data.value?.processes[0]?.sendable_count).toBe(3);
    // 后端不再给 total 字段，前端也不要自己造一个
    expect(q!.data.value).not.toHaveProperty('total');
    scope.stop();
  });

  it('SQ2：出参缺 sendable_total → query 进 error 态（守门不是摆设）', async () => {
    realFetchSnapshot.mockImplementation(async () => {
      const snap = makeSnapshot() as unknown as Record<string, unknown>;
      delete snap.sendable_total;
      return snap;
    });
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueSnapshotQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueSnapshotQuery());
    });
    await q!.refetch();
    expect(q!.error.value).toBeTruthy();
    scope.stop();
  });

  it('SQ3：queryKey 走 qk 工厂（常量键，不在调用点拼字面量数组）', () => {
    expect(qk.outsourceQueueSnapshot()).toEqual(['outsource-queue', 'snapshot']);
    expect(qk.outsourceQueueSnapshotPrefix).toEqual(['outsource-queue', 'snapshot']);
  });

  it('SQ4：staleTime 30s / gcTime 5min（有限值，非 POSITIVE_INFINITY）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueSnapshotQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueSnapshotQuery());
    });
    await q!.refetch();
    const entry = testQueryClient.getQueryCache().find({ queryKey: qk.outsourceQueueSnapshot() });
    const opts = entry?.options as { staleTime?: number; gcTime?: number };
    expect(opts?.staleTime).toBe(30_000);
    expect(opts?.gcTime).toBe(5 * 60 * 1000);
    scope.stop();
  });

  it('SQ5：invalidateOutsourceQueueSnapshotAll 走前缀键（写后失效的唯一入口）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateOutsourceQueueSnapshotAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['outsource-queue', 'snapshot'] });
  });

  it('SQ6：请求失败 → ElMessage.error 桥接被调（error 不在 setup 抛错）', async () => {
    const { ElMessage } = await import('element-plus');
    realFetchSnapshot.mockRejectedValueOnce(new Error('boom'));
    const scope = effectScope();
    let q: ReturnType<typeof useOutsourceQueueSnapshotQuery> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useOutsourceQueueSnapshotQuery());
    });
    await q!.refetch();
    await Promise.resolve();
    expect(q!.error.value?.message).toContain('boom');
    expect(ElMessage.error).toHaveBeenCalled();
    scope.stop();
  });
});