// src/views/production/queue/composables/__tests__/useQueueBoard.spec.ts
//
// 单工序看板 query 的接线 guard：reactive params + enabled 闸门 + queryFn 二次守卫 +
// Zod 守门 + **前缀**失效。
//
// 覆盖：
//   - B1：传静态 string → fetchQueueBoard 收到该 processId。
//   - B2：传 Ref → 改 ref.value 后 refetch，收到新 processId（reactive params guard：
//     queryFn 从 queryKey 读最新值，不闭包捕获 stale 值）。
//   - B3：processId 为 null / 空串 → enabled=false，**零请求**。
//   - B4：enabled=false 时显式 refetch 仍不发请求（queryFn 的二次守卫；防打出
//     `/queue/processes/` 空路径）。
//   - B5：queryKey 走 qk.productionQueueBoard 工厂（禁止调用点拼字面量数组）。
//   - B6：出参缺 workers[].held_batches → query 进 error 态（守门承重字段）。
//   - B7：staleTime 30s / gcTime 5min（有限值，本域零 WS 订阅）。
//   - B8：invalidateQueueBoardAll 走前缀键（**任意 processId 形态**一把全失效 ——
//     move 的目标工序由后端自推，调用方拿不到受影响的 processId）。
//
// 测试策略：
//   - vi.mock('@/api/productionQueue')：fetchQueueBoard 替换为 vi.fn()；
//   - vi.mock('element-plus')：ElMessage 桩成 no-op；
//   - effectScope + createApp(VueQueryPlugin) 拿到真实的 useQuery 生命周期。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, ref, type Ref } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** 工序看板响应（QueueBoard）。 */
function makeBoard(processId: string) {
  return {
    process: { process_id: processId, process_code: 'CNC-01', process_name: '粗加工', color: null },
    workers: [
      {
        worker_id: '1900000000001',
        name: '张三',
        work_type_code: 'CNC',
        badge_code: 'G001',
        max_held: 3,
        current_held: 1,
        capacity_remaining: 2,
        held_batches: [],
      },
    ],
    items: [],
    total: 0,
    ts: '2026-10-08T09:12:33+08:00',
  };
}

const realFetchQueueBoard = vi.fn<(processId: string) => Promise<unknown>>(
  async (processId) => makeBoard(processId),
);

vi.mock('@/api/productionQueue', () => ({
  fetchQueueBoard: (processId: string) => realFetchQueueBoard(processId),
  fetchQueueSnapshot: vi.fn(),
  fetchPendingBatches: vi.fn(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
  recallToPending: vi.fn(),
  moveBatch: vi.fn(),
  autoAllocate: vi.fn(),
  refillQueue: vi.fn(),
}));

import { useQueueBoard, invalidateQueueBoardAll } from '../useQueueBoard';
import { qk } from '@/composables/queries/keys';

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

describe('useQueueBoard — 单工序看板 query', () => {
  beforeEach(() => {
    realFetchQueueBoard.mockClear();
    realFetchQueueBoard.mockImplementation(async (pid: string) => makeBoard(pid));
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

  it('B1：传静态 string → fetchQueueBoard 收到该 processId', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useQueueBoard> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueBoard(() => '2000000000001'));
    });
    await q!.refetch();
    expect(realFetchQueueBoard).toHaveBeenCalledWith('2000000000001');
    scope.stop();
  });

  it('B2：传 Ref → 改值后 refetch 收到新 processId（queryFn 从 queryKey 读最新值）', async () => {
    const pidRef: Ref<string | null> = ref('2000000000001');
    const scope = effectScope();
    let q: ReturnType<typeof useQueueBoard> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueBoard(() => pidRef.value));
    });
    await q!.refetch();
    expect(realFetchQueueBoard).toHaveBeenLastCalledWith('2000000000001');

    pidRef.value = '2000000000002';
    await q!.refetch();
    // 若 queryFn 闭包捕获了入参快照，这里会拿到上一个工序的响应 / 旧 processId
    expect(realFetchQueueBoard).toHaveBeenLastCalledWith('2000000000002');
    scope.stop();
  });

  it('B3：processId 为 null / 空串 → enabled=false，零请求', async () => {
    for (const pid of [null, '']) {
      const scope = effectScope();
      scope.run(() => {
        testApp.runWithContext(() => useQueueBoard(() => pid));
      });
      await Promise.resolve();
      expect(realFetchQueueBoard).not.toHaveBeenCalled();
      scope.stop();
    }
  });

  it('B4：enabled=false 时显式 refetch 也不发请求（queryFn 二次守卫）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useQueueBoard> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueBoard(() => ''));
    });
    // refetch 绕过 enabled 是显式调用路径；queryFn 内必须有二次守卫，否则会打出
    // `/queue/processes/` 空路径（后端 404/422）。
    await q!.refetch().catch(() => undefined);
    expect(realFetchQueueBoard).not.toHaveBeenCalled();
    expect(q!.error.value?.message).toContain('processId required');
    scope.stop();
  });

  it('B5：queryKey 走 qk 工厂（含 processId 维度）', () => {
    expect(qk.productionQueueBoard('2000000000001')).toEqual([
      'production-queue',
      'board',
      '2000000000001',
    ]);
    expect(qk.productionQueueBoardPrefix).toEqual(['production-queue', 'board']);
  });

  it('B6：出参缺 workers[].held_batches → query 进 error 态', async () => {
    realFetchQueueBoard.mockImplementation(async (pid: string) => {
      const board = makeBoard(pid) as unknown as Record<string, unknown>;
      const workers = board.workers as Array<Record<string, unknown>>;
      delete workers[0]!.held_batches;
      return board;
    });
    const scope = effectScope();
    let q: ReturnType<typeof useQueueBoard> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueBoard(() => '2060000000001'));
    });
    await q!.refetch();
    expect(q!.error.value).toBeTruthy();
    scope.stop();
  });

  it('B7：staleTime 30s / gcTime 5min（有限值）', async () => {
    const scope = effectScope();
    let q: ReturnType<typeof useQueueBoard> | undefined;
    scope.run(() => {
      q = testApp.runWithContext(() => useQueueBoard(() => '2070000000001'));
    });
    await q!.refetch();
    const entry = testQueryClient
      .getQueryCache()
      .find({ queryKey: qk.productionQueueBoard('2070000000001') });
    const opts = entry?.options as { staleTime?: number; gcTime?: number };
    expect(opts?.staleTime).toBe(30_000);
    expect(opts?.gcTime).toBe(5 * 60 * 1000);
    scope.stop();
  });

  it('B8：invalidateQueueBoardAll 走前缀键（任意 processId 一把全失效）', async () => {
    const spy = vi.spyOn(testQueryClient, 'invalidateQueries');
    await invalidateQueueBoardAll(testQueryClient);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['production-queue', 'board'] });
  });
});