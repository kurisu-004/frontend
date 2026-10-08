// src/views/production/queue/composables/__tests__/useQueueMove.spec.ts
//
// 2026-10-08 改名与域收敛：composable 从「worker_queue」改名 queue_move，落到
// `views/production/queue/composables/`；失效链从「pool 三域（by-process + counts +
// state）」改为「queue 两域（board 前缀 + snapshot 前缀）」——
//   - 单工人 state 域连同它的 query 一起消失（后端把持有批次与容量内联进工序看板，
//     「每列一个请求」的 N+1 从结构上不再存在）；
//   - 计数域改名 snapshot（`/queue/snapshot` 同时带工序候选数与待下发总数）。
// move / auto-allocate 两个端点的形状不变（`/prod/queue/move`、
// `/prod/queue/auto-allocate`），三个包装函数与失效语义也逐字不变。
//
// 覆盖：
//   - T1：moveBatchToWorker 成功 → moveBatch 收到 POOL→WORKER tagged enum 形态
//     （from.shelf_id = 调用方传入的批次真实货架）+ queue 两域前缀失效 + 成功 toast。
//   - T2：moveBatchToWorker fromShelfId 为空 → 早退返回 false + warning，**不发请求**
//     （避免打出必被后端 20122 拒的请求）。
//   - T2b：早退路径裸 await 失效，invalidateQueries 抛错被吞、不冒未捕获 rejection。
//   - T3：moveBatchToWorker 失败 → 返回 false + error.value 写入 + ElMessage.error。
//   - T4：moveBatchToPool 成功 → moveBatch 收到 WORKER→POOL 形态（to.shelf_id = 目标货架）。
//   - T5：moveBatchToPool toShelfId 为空 → 早退返回 false + warning，不发请求。
//   - T6：runAutoAllocate 成功 → autoAllocate 被调 + queue 两域前缀失效。
//   - T7：runAutoAllocate 失败 → onError 写入 error.value **且失效 queue 两域**。
//   - T8：请求体**不含** process_id / next_process_id（目标工序由后端自推），且键集合
//     恰为 batch_id / version / from / to。
//   - T14（2026-10-08）：三个包装的 version 实参原样进请求体（OCC 锚）；
//     version 缺失 / 非有限数（NaN）→ 早退 false + warning「批次版本信息缺失，无法移动」
//     且**零请求**（后端 serde 无 default，缺 version 返 HTTP 422 纯文本，发过去只会
//     得到一条对用户无意义的报错）。
//   - T9：不再导出 `workers`（恒空数组的占位 view-model）/ loadBoard / workerHeld。
//   - T10：moveBatchBetweenWorkers 成功 → moveBatch 收到 WORKER→WORKER 形态
//     （from/to 都是 worker_id）+ queue 两域前缀失效。
//   - T11：moveBatchBetweenWorkers 失败 → 返回 false **且仍失效**（对账徽标 / 池计数）。
//   - T12：move 失败（POOL→WORKER）同样失效（同上因的另一条路径）。
//   - T13：导出面含 moveBatchBetweenWorkers（WorkerColumn 靠 inject key 消费它）。
//
// 测试策略：
//   - vi.mock('@/api/productionQueue') + vi.mock('element-plus')；
//   - vi.spyOn(qc, 'invalidateQueries') 验证 mutation 回调的失效链。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import type { AutoAllocateResultDto, MoveResultDto } from '@/api/productionQueue.contract';
import { ApiError } from '@/api/http';

/** mock `POST /prod/queue/move` 响应（rust MoveResult）。current_held / max_held /
 *  shelf_id / taken 四字段在 rust 侧带 skip_serializing_if ⇒ 条件不满足时整个字段
 *  从 JSON 省略（不是 null）。 */
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
    version: number;
    from: { kind: 'POOL'; shelf_id: string } | { kind: 'WORKER'; worker_id: string };
    to: { kind: 'POOL'; shelf_id: string } | { kind: 'WORKER'; worker_id: string };
    note?: string;
  }) => Promise<MoveResultDto>
>(async (req) => makeMoveResult(req.from.kind, req.to.kind));

/** 卡片 version（真形态是整数 OCC 锚）；各用例的 payload 断言都拿它比对。 */
const CARD_VERSION = 11;

const realAutoAllocate = vi.fn<() => Promise<AutoAllocateResultDto>>(async () => ({
  process_id: '2000000000001',
  shelf_id: '5000000000001',
  mode: 'COUNT' as const,
  fill_ratio: 0.5,
  filled: [],
  pool_empty: false,
}));

vi.mock('@/api/productionQueue', () => ({
  moveBatch: (...args: unknown[]) => realMoveBatch(...(args as Parameters<typeof realMoveBatch>)),
  autoAllocate: (...args: unknown[]) =>
    realAutoAllocate(...(args as Parameters<typeof realAutoAllocate>)),
  // 列出 stub 防止 partial mock 副作用（本 composable 只消费上面两个）
  fetchQueueSnapshot: vi.fn(),
  fetchQueueBoard: vi.fn(),
  fetchPendingBatches: vi.fn(),
  dispatchBatches: vi.fn(),
  previewAutoDispatch: vi.fn(),
  recallToPending: vi.fn(),
  refillQueue: vi.fn(),
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

/** queue 两域前缀失效的 queryKey 断言（board + snapshot）。
 *  ⚠️ 必须是**前缀**失效：move 的目标工序由后端自推、一次 auto-allocate 可同时动多名
 *  工人，调用方拿不到受影响的 processId。 */
function expectQueueDomainInvalidated(): void {
  const calls = vi.mocked(testQueryClient.invalidateQueries).mock.calls;
  const keys = calls.map((c) => (c[0] as { queryKey: readonly unknown[] }).queryKey);
  expect(keys).toContainEqual(['production-queue', 'board']);
  expect(keys).toContainEqual(['production-queue', 'snapshot']);
}

describe('useQueueMove — queue 域的移动 / 自动分配写操作', () => {
  it('T1：moveBatchToWorker 成功 → moveBatch 收到 POOL→WORKER tagged enum + queue 两域前缀失效', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      CARD_VERSION,
      '1900000000002',
      '5000000000001',
    );
    expect(ok).toBe(true);
    expect(realMoveBatch).toHaveBeenCalledTimes(1);
    expect(realMoveBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      version: CARD_VERSION,
      from: { kind: 'POOL', shelf_id: '5000000000001' },
      to: { kind: 'WORKER', worker_id: '1900000000002' },
    });
    expectQueueDomainInvalidated();
    expect(ElMessage.success).toHaveBeenCalled();
  });

  it('T2：moveBatchToWorker fromShelfId 为空 → 早退 false + warning，零请求', async () => {
    // 回归 guard：`from.shelf_id` 必须等于 batch.current_holder_id，否则后端返
    // 20122 BIZ_BATCH_LOCATION_MISMATCH（HTTP 409）。空值时宁可不发请求 + 提示，
    // 也不要打出必被拒的 move。
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToWorker('3000000000001', CARD_VERSION, '1900000000002', '');
    expect(ok).toBe(false);
    expect(realMoveBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次货架信息缺失，无法分配');
    // 早退同样必须失效：mutation 没发出，这次投放对服务器没有任何影响，把 queue 两域
    // 与服务器对账一次（徽标 / 池计数）。卡片节点本身的归位由**源侧**的 onRemove
    // （restoreNodeToSource）负责，不靠这次失效。
    expectQueueDomainInvalidated();
  });

  it('T2b：早退路径的失效抛错不冒成未捕获 rejection（仍返回 false）', async () => {
    // 回归 guard：早退分支是**裸 await** invalidateQueueDomains（不在 mutation 的
    // onSuccess / onError 里，没有框架兜底），invalidateQueries 一旦 reject 就是
    // unhandledRejection。必须吞掉并照常返回 false + warning。
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    vi.mocked(testQueryClient.invalidateQueries).mockRejectedValueOnce(
      new Error('invalidate boom'),
    );
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToWorker('3000000000001', CARD_VERSION, '1900000000002', '');
    expect(ok).toBe(false);
    expect(ElMessage.warning).toHaveBeenCalledWith('批次货架信息缺失，无法分配');
  });

  it('T3：moveBatchToWorker 失败 → 返回 false + error.value 写入 + ElMessage.error', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    realMoveBatch.mockRejectedValueOnce(new ApiError(20204, 'WORKER_CAPACITY_EXCEEDED'));
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      CARD_VERSION,
      '1900000000002',
      '5000000000001',
    );
    expect(ok).toBe(false);
    expect(q.error.value).toContain('WORKER_CAPACITY_EXCEEDED');
    expect(ElMessage.error).toHaveBeenCalledWith('WORKER_CAPACITY_EXCEEDED');
  });

  it('T4：moveBatchToPool 成功 → moveBatch 收到 WORKER→POOL 形态，to 不带 shelf_id', async () => {
    // 2026-10-10：撤回候选池的目标货架改由后端按 `current_process_id` 自动选 ⇒
    // `to` 只剩 kind。这条断言把「不再指定货架」钉死：谁把 shelf_id 加回来，本用例会红。
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToPool('3000000000001', CARD_VERSION, '1900000000002');
    expect(ok).toBe(true);
    expect(realMoveBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      version: CARD_VERSION,
      from: { kind: 'WORKER', worker_id: '1900000000002' },
      to: { kind: 'POOL' },
    });
    expectQueueDomainInvalidated();
  });

  // 2026-10-10：撤回**不再有任何入参早退**（原先「目标货架为空」那条随 toShelfId
  // 一起消失）。留下这条是为了守住 version 守卫本身：NaN 仍必须早退、零请求。
  it('T5：moveBatchToPool 的 version 为 NaN → 早退 false + warning，零请求', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToPool('3000000000001', Number.NaN, '1900000000002');
    expect(ok).toBe(false);
    expect(realMoveBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次版本信息缺失，无法移动');
    expectQueueDomainInvalidated();
  });

  it('T6：runAutoAllocate 成功 → autoAllocate 被调 + queue 两域前缀失效', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove());
    await q.runAutoAllocate({
      process_id: '2000000000001',
      shelf_id: '5000000000001',
      mode: 'COUNT',
      fill_ratio: 0.5,
    });
    expect(realAutoAllocate).toHaveBeenCalledTimes(1);
    expectQueueDomainInvalidated();
  });

  it('T7：runAutoAllocate 失败 → onError 写入 error.value **且失效 queue 两域**', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    realAutoAllocate.mockRejectedValueOnce(new ApiError(20704, 'BIZ_AUTO_ALLOCATE_INVALID_RATIO'));
    const q = testApp.runWithContext(() => useQueueMove());
    await expect(
      q.runAutoAllocate({
        process_id: '2000000000001',
        shelf_id: '5000000000001',
        mode: 'COUNT',
        fill_ratio: 1.5,
      }),
    ).rejects.toThrow();
    expect(q.error.value).toContain('BIZ_AUTO_ALLOCATE_INVALID_RATIO');
    // 失败也要对账：auto-allocate 一次会动多名工人，任一名中途遇 OCC 就整体中断，
    // 此时前面几名工人的持有数已经落库、本地看板却停在中断前 —— 与真值分叉。
    // 与 moveMutation.onError 同款理由（对 T3 / T11 / T12 守的是「失败也失效」）。
    expectQueueDomainInvalidated();
  });

  it('T8：move 请求体不含 process_id / next_process_id（后端已无此入参）', async () => {
    // 回归 guard：旧 assign 请求体带 process_id、旧 remove 带 next_process_id。
    // 后端 MoveRequest 只有 batch_id / from / to / note —— 目标工序由后端从
    // `batch.current_process_step.process_id` 自推（worker-pool.md:146-147）。
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove());
    await q.moveBatchToWorker('3000000000001', CARD_VERSION, '1900000000002', '5000000000001');
    const sent = realMoveBatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('process_id');
    expect(sent).not.toHaveProperty('next_process_id');
    expect(Object.keys(sent).sort()).toEqual(['batch_id', 'from', 'to', 'version']);
  });

  it('T9：不再导出 `workers` / loadBoard / workerHeld（无消费方的占位数据源）', async () => {
    // 回归 guard：`workers` 曾是恒空数组的占位 view-model（真实工人数据早已改由
    // 工序看板的 workers[] 提供），loadBoard / workerHeld 是「唯一非 TanStack 数据源」。
    // 若未来有人把它们加回来，本用例会失败。
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove()) as unknown as Record<string, unknown>;
    expect(q).not.toHaveProperty('loadBoard');
    expect(q).not.toHaveProperty('workerHeld');
    expect(q).not.toHaveProperty('workers');
  });

  // ===== 2026-10-03：WORKER→WORKER 方向 + 失败也失效 =====

  it('T10：moveBatchBetweenWorkers 成功 → moveBatch 收到 WORKER→WORKER 形态 + 两域失效', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchBetweenWorkers(
      '3000000000001',
      CARD_VERSION,
      '1900000000001',
      '1900000000002',
    );
    expect(ok).toBe(true);
    expect(realMoveBatch).toHaveBeenCalledTimes(1);
    // from / to 两侧都是 WORKER 形态（tagged enum 的 worker_id 分支）
    expect(realMoveBatch).toHaveBeenCalledWith({
      batch_id: '3000000000001',
      version: CARD_VERSION,
      from: { kind: 'WORKER', worker_id: '1900000000001' },
      to: { kind: 'WORKER', worker_id: '1900000000002' },
    });
    expectQueueDomainInvalidated();
  });

  it('T11：moveBatchBetweenWorkers 失败 → 返回 false，但**仍然失效** queue 两域', async () => {
    // 回归 guard（主症状链的另一半）：失败也必须与服务器对账一次。失效负责的是
    // 徽标数字与池计数（`current_held` / `capacity_remaining` / 池批次数只有重拉才对
    // 得上，本地 DOM 改动碰不到它们），且全局 refetchOnWindowFocus=false，不重拉就
    // 一直显示旧数字。卡片节点本身的归位由**源侧**的 onRemove（restoreNodeToSource）
    // 在 drop 事件里完成，不依赖这次失效。
    const { useQueueMove } = await import('../useQueueMove');
    realMoveBatch.mockRejectedValueOnce(new ApiError(20204, 'WORKER_CAPACITY_EXCEEDED'));
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchBetweenWorkers(
      '3000000000001',
      CARD_VERSION,
      '1900000000001',
      '1900000000002',
    );
    expect(ok).toBe(false);
    expect(q.error.value).toContain('WORKER_CAPACITY_EXCEEDED');
    expectQueueDomainInvalidated();
  });

  it('T12：POOL→WORKER 失败同样失效 queue 两域（撤回 / 转交 / 分配三条路径同构）', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    realMoveBatch.mockRejectedValueOnce(new ApiError(20507, 'BIZ_SHELF_PROCESS_NOT_MAPPED'));
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToWorker(
      '3000000000001',
      CARD_VERSION,
      '1900000000002',
      '5000000000001',
    );
    expect(ok).toBe(false);
    expectQueueDomainInvalidated();
  });

  it('T13：导出面含 moveBatchBetweenWorkers（WorkerColumn 靠 inject key 消费）', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove());
    expect(typeof q.moveBatchBetweenWorkers).toBe('function');
  });

  // ===== 2026-10-08：move 补 OCC 锚 version =====

  it('T14：三个包装都把 version 原样带进请求体（OCC 锚）', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const q = testApp.runWithContext(() => useQueueMove());
    await q.moveBatchToWorker('3000000000001', CARD_VERSION, '1900000000002', '5000000000001');
    await q.moveBatchToPool('3000000000001', CARD_VERSION, '1900000000002');
    await q.moveBatchBetweenWorkers(
      '3000000000001',
      CARD_VERSION,
      '1900000000001',
      '1900000000002',
    );
    expect(realMoveBatch).toHaveBeenCalledTimes(3);
    for (const call of realMoveBatch.mock.calls) {
      expect(call[0].version).toBe(CARD_VERSION);
    }
  });

  it('T15：version 为 NaN（卡片没填）→ 三个包装都早退 + warning，零请求', async () => {
    // 回归 guard：卡片没填 version 时，落点从 dataset 读到的是 NaN（不是 undefined / 0）。
    // 后端 serde 无 #[serde(default)] ⇒ 缺 version 返 HTTP 422 **纯文本**而非业务信封，
    // 发过去用户只看到一句语法错误。所以守卫必须同时挡住 NaN：`typeof NaN === 'number'`，
    // 只查 typeof 会让它穿过去。
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useQueueMove());

    expect(await q.moveBatchToWorker('3', Number.NaN, 'w2', 's1')).toBe(false);
    expect(await q.moveBatchToPool('3', Number.NaN, 'w1')).toBe(false);
    expect(await q.moveBatchBetweenWorkers('3', Number.NaN, 'w1', 'w2')).toBe(false);

    expect(realMoveBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次版本信息缺失，无法移动');
    // 早退同样要失效对账（卡片已被 Sortable 搬到落点列，服务器侧没有任何变化）
    expectQueueDomainInvalidated();
  });

  it('T16：version 守卫先于货架守卫（两个都缺时提示 version，不发请求）', async () => {
    const { useQueueMove } = await import('../useQueueMove');
    const { ElMessage } = await import('element-plus');
    const q = testApp.runWithContext(() => useQueueMove());
    const ok = await q.moveBatchToWorker('3', Number.NaN, 'w2', '');
    expect(ok).toBe(false);
    expect(realMoveBatch).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith('批次版本信息缺失，无法移动');
    expect(ElMessage.warning).not.toHaveBeenCalledWith('批次货架信息缺失，无法分配');
  });
});
