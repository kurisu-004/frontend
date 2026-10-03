// src/views/workers/composables/__tests__/useWorkerQueue.spec.ts
//
// 2026-09-30 重写：后端 `POST /admin/worker-pool/{assign,remove}` 合并为通用移动端点
// `POST /prod/pool/move`（POOL↔WORKER + WORKER→WORKER 三方向）后，本 composable
// 从「2 个 move mutation（assign + remove）+ 1 个 autoAllocate」收编为
// 「1 个 moveMutation + 1 个 autoAllocateMutation」。
//
// 2026-09-30 同时删除：
// - `loadBoard` + 模块级 `workerHeld` ref —— 它是一段**循环裸调 getWorkerState**
//   （先 qc.getQueriesData 收集 worker_id 再 Promise.allSettled 并发拉），违反
//   CLAUDE.md 2026-09-30「查询一律 useQuery」硬约束；且首屏默认激活「待下发」tab
//   时 by-process 缓存恒空 ⇒ 收集到的 worker_ids 恒空 ⇒ 早退（死代码）。
//   唯一真实消费者 WorkerColumn 已自管 useWorkerStateByWorkerQuery。
// - `UsePendingDispatchDeps.refreshBoard` 注入链。
// - `invalidateWorkerPoolByProcessQuery(qc, pid)` /
//   `invalidateWorkerStateByWorkerQuery(qc, wid, sid)` 精刷版 —— move 的目标工序由
//   service 从 batch 当前 step 自推，前端无从得知受影响 processId，且一次
//   auto-allocate 可同时改多个 worker ⇒ 统一走前缀全失效。
//
// 覆盖：
//   - T1：moveBatchToWorker 成功 → moveBatch 收到 POOL→WORKER tagged enum 形态
//     （from.shelf_id = 调用方传入的 batch 真实货架）+ pool 三域前缀失效 + 成功 toast。
//   - T2：moveBatchToWorker fromShelfId 为空 → 早退返回 false + warning，**不发请求**
//     （避免打出必被后端 20122 拒的请求）。
//   - T3：moveBatchToWorker 失败 → 返回 false + error.value 写入 + ElMessage.error。
//   - T4：moveBatchToPool 成功 → moveBatch 收到 WORKER→POOL 形态（to.shelf_id = 目标货架）。
//   - T5：moveBatchToPool toShelfId 为空 → 早退返回 false + warning，不发请求。
//   - T6：runAutoAllocate 成功 → autoAllocate 被调 + pool 三域前缀失效。
//   - T7：runAutoAllocate 失败 → onError 路径 error.value 写入。
//   - T8：请求体**不含** process_id / next_process_id（后端已无此入参，服务端自推）。
//   - T10：moveBatchBetweenWorkers 成功 → moveBatch 收到 WORKER→WORKER 形态
//     （from/to 都是 worker_id）+ pool 三域前缀失效。
//   - T11：moveBatchBetweenWorkers 失败 → 返回 false **且仍失效 pool 三域**。
//     回归 guard：失败也必须对账，失效负责的是徽标 / 池计数这类只有重拉才对得上的数据。
//   - T12：move 失败（POOL→WORKER）同样失效 pool 三域（同上因的另一条路径）。
//   - T13：导出面含 moveBatchBetweenWorkers（WorkerColumn 靠 inject key 消费它）。
//   - T2b：早退路径裸 await 失效，invalidateQueries 抛错被吞、不冒未捕获 rejection。
//
// 测试策略：
//   - vi.mock('@/api/workerPool') + vi.mock('element-plus')；
//   - vi.spyOn(qc, 'invalidateQueries') 验证 mutation onSuccess 失效链。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { AutoAllocateResultDto, MoveResultDto } from '@/api/workerPool.contract';
import { ApiError } from '@/api/http';

/** 2026-09-30：mock `POST /prod/pool/move` 响应（rust MoveResult,
 *  vo/worker_pool.rs:126-152）。current_held / max_held / shelf_id / taken 四字段
 *  在 rust 侧带 skip_serializing_if ⇒ 条件不满足时整个字段从 JSON 省略。 */
function makeMoveResult(from: 'POOL' | 'WORKER', to: 'POOL' | 'WORKER'): MoveResultDto {
  return {
    batch_id: '3000000000001',
    from_kind: from,
    to_kind: to,
    new_holder_id: to === 'WORKER' ? '1900000000002' : '5000000000001',
    new_location: to === 'WORKER' ? 'WORKER' : 'PRODUCTION_SHELF',
    version: 2,
    ...(to === 'WORKER'
      ? {
          current_held: 2,
          max_held: 3,
          taken: {
            batch_id: '3000000000001',
            part_id: '4000000000001',
            batch_no: 1,
            quantity: 5,
            serial_no: null,
            drawing_no: 'DWG-001',
            system_delivery_date: '2026-09-30',
            planned_delivery_date: null,
            is_urgent: false,
            version: 2,
            has_cnc_program: true,
          },
        }
      : { shelf_id: '5000000000001' }),
  };
}

const realMoveBatch = vi.fn<
  (req: {
    batch_id: string;
    from: { kind: 'POOL'; shelf_id: string } | { kind: 'WORKER'; worker_id: string };
    to: { kind: 'POOL'; shelf_id: string } | { kind: 'WORKER'; worker_id: string };
    note?: string;
  }) => Promise<MoveResultDto>
>(async (req) => makeMoveResult(req.from.kind, req.to.kind));

const realAutoAllocate = vi.fn<() => Promise<AutoAllocateResultDto>>(async () => ({
  process_id: '2000000000001',
  shelf_id: '5000000000001',
  mode: 'COUNT' as const,
  fill_ratio: 0.5,
  filled: [],
  pool_empty: false,
}));

vi.mock('@/api/workerPool', () => ({
  // 2026-09-30：assignWorkerPool / removeFromWorkerPool 已删，合并为 moveBatch
  moveBatch: (...args: unknown[]) => realMoveBatch(...(args as Parameters<typeof realMoveBatch>)),
  autoAllocate: (...args: unknown[]) =>
    realAutoAllocate(...(args as Parameters<typeof realAutoAllocate>)),
  // 列出 stub 防止 partial mock 副作用（useWorkerQueue 不消费这 3 个）
  getWorkerPoolCounts: vi.fn(),
  getWorkerPoolByProcess: vi.fn(),
  getWorkerState: vi.fn(),
  refillWorkerPool: vi.fn(),
}));

vi.mock('element-plus', () => ({
  ElMessage: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

let testApp: ReturnType<typeof createApp>;
let testQueryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  testQueryClient = new QueryClient({
    defaultOptions: { mutations: { retry: 0 }, queries: { retry: 0 } },
  });
  testApp = createApp({});
  testApp.use(VueQueryPlugin, { queryClient: testQueryClient });
  vi.spyOn(testQueryClient, 'invalidateQueries');
});

afterEach(() => {
  testQueryClient.unmount();
  testApp = null as unknown as ReturnType<typeof createApp>;
  testQueryClient = null as unknown as QueryClient;
  vi.restoreAllMocks();
});

/** 2026-09-30：pool 三域前缀失效的 queryKey 断言（by-process + counts + state）。 */
function expectPoolDomainInvalidated(): void {
  const calls = vi.mocked(testQueryClient.invalidateQueries).mock.calls;
  const keys = calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  expect(keys).toContainEqual(['worker-pool', 'by-process']);
  expect(keys).toContainEqual(['worker-pool', 'counts']);
  expect(keys).toContainEqual(['worker-pool', 'state']);
}

describe('useWorkerQueue — 2026-09-30 move 端点收编（assign+remove → move）', () => {
  it('T1：moveBatchToWorker 成功 → moveBatch 收到 POOL→WORKER tagged enum + pool 三域前缀失效', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker('3000000000001', '1900000000002', '5000000000001');
    expect(ok).toBe(true);
    expect(realMoveBatch).toHaveBeenCalledTimes(1);
    expect(realMoveBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      from: { kind: 'POOL', shelf_id: '5000000000001' },
      to: { kind: 'WORKER', worker_id: '1900000000002' },
    });
    expectPoolDomainInvalidated();
    expect(ElMessage.success).toHaveBeenCalled();
  });

  it('T2：moveBatchToWorker fromShelfId 为空 → 早退 false + warning，零请求', async () => {
    // 回归 guard：`from.shelf_id` 必须等于 batch.current_holder_id，否则后端返
    // 20122 BIZ_BATCH_LOCATION_MISMATCH（HTTP 409）。空值时宁可不发请求 + 提示，
    // 也不要打出必被拒的 move。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker('3000000000001', '1900000000002', '');
    expect(ok).toBe(false);
    expect(realMoveBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次货架信息缺失，无法分配');
    // 早退同样必须失效：mutation 没发出，这次投放对服务器没有任何影响，把 pool 三域
    // 与服务器对账一次（徽标 / 池计数）。卡片节点本身的归位由**源侧**的 onRemove
    // （restoreNodeToSource）负责，不靠这次失效。
    expectPoolDomainInvalidated();
  });

  it('T2b：早退路径的失效抛错不冒成未捕获 rejection（仍返回 false）', async () => {
    // 回归 guard：早退分支是**裸 await** invalidatePoolDomains（不在 mutation 的
    // onSuccess / onError 里，没有框架兜底），invalidateQueries 一旦 reject 就是
    // unhandledRejection。必须吞掉并照常返回 false + warning。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { ElMessage } = await import('element-plus');
    vi.mocked(testQueryClient.invalidateQueries).mockRejectedValueOnce(
      new Error('invalidate boom'),
    );
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker('3000000000001', '1900000000002', '');
    expect(ok).toBe(false);
    expect(ElMessage.warning).toHaveBeenCalledWith('批次货架信息缺失，无法分配');
  });

  it('T3：moveBatchToWorker 失败 → 返回 false + error.value 写入 + ElMessage.error', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { ElMessage } = await import('element-plus');
    realMoveBatch.mockRejectedValueOnce(new ApiError(20204, 'WORKER_CAPACITY_EXCEEDED'));
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker('3000000000001', '1900000000002', '5000000000001');
    expect(ok).toBe(false);
    expect(q.error.value).toContain('WORKER_CAPACITY_EXCEEDED');
    expect(ElMessage.error).toHaveBeenCalledWith('WORKER_CAPACITY_EXCEEDED');
  });

  it('T4：moveBatchToPool 成功 → moveBatch 收到 WORKER→POOL 形态', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToPool('3000000000001', '1900000000002', '5000000000001');
    expect(ok).toBe(true);
    expect(realMoveBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      from: { kind: 'WORKER', worker_id: '1900000000002' },
      to: { kind: 'POOL', shelf_id: '5000000000001' },
    });
    expectPoolDomainInvalidated();
  });

  it('T5：moveBatchToPool toShelfId 为空 → 早退 false + warning，零请求', async () => {
    // 同 T2：撤回目标货架为空时 mutation 不发出，这次投放对服务器无影响，仍要失效
    // 对账一次（且同样包 try/catch，见 T2b）。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToPool('3000000000001', '1900000000002', '');
    expect(ok).toBe(false);
    expect(realMoveBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('请先选择目标货架');
    expectPoolDomainInvalidated();
  });

  it('T6：runAutoAllocate 成功 → autoAllocate 被调 + pool 三域前缀失效', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    await q.runAutoAllocate({
      process_id: '2000000000001',
      shelf_id: '5000000000001',
      mode: 'COUNT',
      fill_ratio: 0.5,
    });
    expect(realAutoAllocate).toHaveBeenCalledTimes(1);
    expectPoolDomainInvalidated();
  });

  it('T7：runAutoAllocate 失败 → onError 路径 error.value 写入', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    realAutoAllocate.mockRejectedValueOnce(new ApiError(20704, 'BIZ_AUTO_ALLOCATE_INVALID_RATIO'));
    const q = testApp.runWithContext(() => useWorkerQueue());
    await expect(
      q.runAutoAllocate({
        process_id: '2000000000001',
        shelf_id: '5000000000001',
        mode: 'COUNT',
        fill_ratio: 1.5,
      }),
    ).rejects.toThrow();
    expect(q.error.value).toContain('BIZ_AUTO_ALLOCATE_INVALID_RATIO');
  });

  it('T8：move 请求体不含 process_id / next_process_id（后端已无此入参）', async () => {
    // 回归 guard：旧 assign 请求体带 process_id、旧 remove 带 next_process_id。
    // 后端 MoveRequest 只有 batch_id / from / to / note —— 目标工序由 service 从
    // `batch.current_process_step.process_id` 自推（worker-pool.md:146-147）。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    await q.moveBatchToWorker('3000000000001', '1900000000002', '5000000000001');
    const sent = realMoveBatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('process_id');
    expect(sent).not.toHaveProperty('next_process_id');
    expect(Object.keys(sent).sort()).toEqual(['batch_id', 'from', 'to']);
  });

  it('T9：不再导出 loadBoard / workerHeld（已随 TanStack 硬约束清理）', async () => {
    // 回归 guard：这两个成员是「唯一非 TanStack 数据源」。若未来有人再加回来，
    // 本用例会失败。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue()) as unknown as Record<string, unknown>;
    expect(q).not.toHaveProperty('loadBoard');
    expect(q).not.toHaveProperty('workerHeld');
  });

  // ===== 2026-10-03：WORKER→WORKER 方向 + 失败也失效 =====

  it('T10：moveBatchBetweenWorkers 成功 → moveBatch 收到 WORKER→WORKER 形态 + 三域失效', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchBetweenWorkers('3000000000001', '1900000000001', '1900000000002');
    expect(ok).toBe(true);
    expect(realMoveBatch).toHaveBeenCalledTimes(1);
    // from / to 两侧都是 WORKER 形态（tagged enum 的 worker_id 分支）
    expect(realMoveBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      from: { kind: 'WORKER', worker_id: '1900000000001' },
      to: { kind: 'WORKER', worker_id: '1900000000002' },
    });
    expectPoolDomainInvalidated();
  });

  it('T11：moveBatchBetweenWorkers 失败 → 返回 false，但**仍然失效** pool 三域', async () => {
    // 回归 guard（主症状链的另一半）：失败也必须与服务器对账一次。失效负责的是
    // 徽标数字与池计数（`current_held` / `capacity_remaining` / 池批次数只有重拉才对
    // 得上，本地 DOM 改动碰不到它们），且全局 refetchOnWindowFocus=false，不重拉就
    // 一直显示旧数字。卡片节点本身的归位由**源侧**的 onRemove（restoreNodeToSource）
    // 在 drop 事件里完成，不依赖这次失效。
    const { useWorkerQueue } = await import('../useWorkerQueue');
    realMoveBatch.mockRejectedValueOnce(new ApiError(20204, 'WORKER_CAPACITY_EXCEEDED'));
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchBetweenWorkers('3000000000001', '1900000000001', '1900000000002');
    expect(ok).toBe(false);
    expect(q.error.value).toContain('WORKER_CAPACITY_EXCEEDED');
    expectPoolDomainInvalidated();
  });

  it('T12：POOL→WORKER 失败同样失效 pool 三域（撤回 / 转交 / 分配三条路径同构）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    realMoveBatch.mockRejectedValueOnce(new ApiError(20507, 'BIZ_SHELF_PROCESS_NOT_MAPPED'));
    const q = testApp.runWithContext(() => useWorkerQueue());
    const ok = await q.moveBatchToWorker('3000000000001', '1900000000002', '5000000000001');
    expect(ok).toBe(false);
    expectPoolDomainInvalidated();
  });

  it('T13：导出面含 moveBatchBetweenWorkers（WorkerColumn 靠 inject key 消费）', async () => {
    const { useWorkerQueue } = await import('../useWorkerQueue');
    const q = testApp.runWithContext(() => useWorkerQueue());
    expect(typeof q.moveBatchBetweenWorkers).toBe('function');
  });
});
