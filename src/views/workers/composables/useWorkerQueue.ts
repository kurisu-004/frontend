// src/views/workers/composables/useWorkerQueue.ts
//
// 生产队列「候选池 ↔ 工人」拖拽移动 + 自动分配 的写操作 composable（TanStack
// Query 化，CLAUDE.md 2026-09-30 硬约束）。
//
// 2026-09-30 重构要点：
//   - 后端把 `POST /admin/worker-pool/assign`（POOL→WORKER 单边）与
//     `POST /admin/worker-pool/remove`（WORKER→POOL 单边）合并为通用移动端点
//     `POST /api/v2/prod/pool/move`（POOL↔WORKER + WORKER→WORKER 三方向）。
//     本文件原来的 assignMutation + removeMutation 两个 useMutation 收编为
//     **单个** `moveMutation`，mutationKey 沿两层（'worker-pool' / 'move'）。
//   - 删 `loadBoard` + 模块级 `workerHeld` ref + `getWorkerState` import：
//     ① 2026-09-30 前 `loadBoard` 是一段**循环裸调 getWorkerState**（先从
//        `qc.getQueriesData({queryKey: qk.workerPoolByProcessPrefix})` 收集
//        worker_id 再 Promise.allSettled 并发拉），违反 CLAUDE.md 2026-09-30
//        「查询一律 useQuery」硬约束；
//     ② 且它首屏必然为空 —— 默认激活的是「待下发」tab，`__pending__` 不会拉任何
//        by-process 详情 ⇒ 收集到的 worker_ids 恒空 ⇒ 早退；
//     ③ 唯一真实消费者 WorkerColumn 已于 2026-09-30 改为自管
//        `useWorkerStateByWorkerQuery`（held_batches 直读），workerHeld 是死代码。
//     删后本文件不再有任何「裸调 api + 模块级 ref」数据源，全页 100% TanStack。
//   - 删 `UsePendingDispatchDeps.refreshBoard` 依赖注入（随 loadBoard 一起消失）。
//   - 失效链统一走**前缀全失效**（by-process + counts + state）：move 之后前端
//     无法确定受影响 processId（service 从 batch 当前 step 自推目标工序，一个
//     auto-allocate 可同时动多个 worker），精确失效必然漏刷。
//
// 2026-10-03 补齐 WORKER→WORKER 方向：此前 moveMutation 存在但只有 POOL→WORKER
// 与 WORKER→POOL 两个包装函数，工人之间转交（把 A 手中的批次拖到 B 手中）在前端
// **零实现** —— 拖拽落点列的 onDragAdd 拿不到工人源就早退，不发请求也不失效，
// 表现为「B 列凭空多一张卡、A 列永久少一张」；且全局 refetchOnWindowFocus=false，
// 只能手点刷新恢复。
//
// 历史：
// - 2026-08-26：阶段一，全部走 fixture。
// - 2026-09-14：5 个端点切真。
// - 2026-09-14 follow-up：WorkerStateDto.held_batches 新增；moveBatchToWorker 改用
//   assignWorkerPool（单 batch 分配）。
// - 2026-09-26：数据获取迁 TanStack Query（assign/remove/auto-allocate 三个
//   useMutation + invalidate）。

import { ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { autoAllocate, moveBatch } from '@/api/workerPool';
import type {
  AutoAllocateRequest,
  AutoAllocateResultDto,
  MoveRequest,
  MoveResultDto,
} from '@/api/workerPool.contract';
import { moveResultSchema } from '@/composables/queries/schemas';
import { invalidateWorkerPoolByProcessAll } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { invalidateWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';
import { invalidateWorkerStateByWorkerAll } from '@/composables/queries/useWorkerStateByWorkerQuery';
import type { Worker } from '@/types/workerPool';

/** 2026-09-30：显式返回类型。`loadBoard` / `workerHeld` 已删（见文件头）。
 *  两个 `moveBatchTo*` 保留 `Promise<boolean>` 签名以兼容 view 现有调用点
 *  （WorkerColumn.onDragAdd / PoolDrawer.onDragAdd），内部仍是 mutateAsync +
 *  try/catch 包一层。 */
export interface UseWorkerQueueReturn {
  /** 保留导出但已无外部写点/消费方（本 ref 自 2026-09-30 起恒为空数组，与后端
   *  `/prod/workers` CRUD 是否上线无关 —— CRUD 早已上线并由工人一览页消费）。
   *  本注释防止 reviewer 误删。 */
  workers: Ref<Worker[]>;
  /** 2026-09-30：最近一次写操作错误信息（view 层 el-alert 展示）。
   *  成功时置 null。 */
  error: Ref<string | null>;
  /** POOL → WORKER：把候选池批次分配给工人。
   *  @param batchId      待移动批次
   *  @param toWorkerId   目标工人
   *  @param fromShelfId  **batch 真实所在货架**（不是当前激活货架 —— 候选池跨所有
   *                     货架，填错后端返 20122 BIZ_BATCH_LOCATION_MISMATCH） */
  moveBatchToWorker: (batchId: string, toWorkerId: string, fromShelfId: string) => Promise<boolean>;
  /** WORKER → POOL：把工人持有的批次撤回候选池货架。
   *  @param toShelfId 目标货架（须映射到 batch 当前工序，否则 20507 / HTTP 422） */
  moveBatchToPool: (batchId: string, fromWorkerId: string, toShelfId: string) => Promise<boolean>;
  /** 2026-10-03 新增 WORKER → WORKER：把一名工人手中的批次转交给另一名。
   *  落点列的 onDragAdd 在「拿不到候选池源」时走这条路径（从自己那一列拖回自己
   *  不发请求，故本函数不校验 from ≠ to，调用方负责）。 */
  moveBatchBetweenWorkers: (
    batchId: string,
    fromWorkerId: string,
    toWorkerId: string,
  ) => Promise<boolean>;
  /** 按 process + shelf 范围自动为每个匹配 worker 抢批次数/工时。 */
  runAutoAllocate: (req: AutoAllocateRequest) => Promise<void>;
}

export function useWorkerQueue(): UseWorkerQueueReturn {
  const qc = useQueryClient();
  const error = ref<string | null>(null);

  /** 2026-09-30：写操作完成后集中失效 pool 三域（by-process + counts + state）。
   *  全部走**前缀**失效：move 的目标工序由 service 从 `batch.current_process_step`
   * 推导，前端无从得知受影响 processId；auto-allocate 更是跨全部 worker。
   *  返回 Promise 让 mutation onSuccess await 完整失效链再弹 toast。 */
  async function invalidatePoolDomains(): Promise<void> {
    await invalidateWorkerPoolByProcessAll(qc);
    await invalidateWorkerPoolCountsQuery(qc);
    await invalidateWorkerStateByWorkerAll(qc);
  }

  /** 2026-09-30：`POST /prod/pool/move` —— 取代旧 assign + remove 两个端点。
   *  mutationFn 走 `moveResultSchema.parse()` 守门：MoveResult 的
   *  current_held / max_held / shelf_id / taken 四字段在 rust 侧都带
   *  `skip_serializing_if`（条件不满足时整个字段从 JSON 省略），schema 用
   *  `.nullish()` 兜住；契约漂移立刻抛 ZodError 由 onError 接管。
   *
   * 2026-10-03：onError 也失效 pool 三域。**失败即与服务器对账一次**——本域的
   *  Sortable 容器退化为「纯投放信号源」：拖拽时 Sortable 已经把被拖节点**物理搬进**
   *  落点容器，而 DOM 一律要靠 query refetch 后的 Vue 渲染覆盖回来。成功路径有
   *  invalidate 兜底，失败路径若只弹 toast 不重拉，那次错位的 DOM 就永远留在屏幕上
   *  （A 列少一张 / B 列多一张），用户只能手点「刷新」。高频触发场景：工人容量超限
   *  20204、工种不含该批次工序、撤回目标货架未映射该工序 20507、OCC 409。
   *  包装层两个入参早退分支（from.shelf_id / to.shelf_id 为空）也各失效一次 ——
   *  mutation 压根没发出，但 DOM 已经被搬走了，同样需要重拉才能把屏幕拉回真相。 */
  const moveMutation = useMutation<MoveResultDto, Error, MoveRequest>({
    mutationKey: ['worker-pool', 'move'],
    mutationFn: async (req) => moveResultSchema.parse(await moveBatch(req)),
    onSuccess: async (res) => {
      await invalidatePoolDomains();
      error.value = null;
      ElMessage.success(moveSuccessText(res));
    },
    onError: async (e: Error) => {
      error.value = e.message ?? '移动批次失败';
      ElMessage.error(e.message ?? '移动批次失败');
      await invalidatePoolDomains();
    },
  });

  const autoAllocateMutation = useMutation<AutoAllocateResultDto, Error, AutoAllocateRequest>({
    mutationKey: ['worker-pool', 'auto-allocate'],
    mutationFn: async (req) => autoAllocate(req),
    onSuccess: async () => {
      await invalidatePoolDomains();
      error.value = null;
    },
    onError: (e: Error) => {
      error.value = e.message ?? '自动分配失败';
      ElMessage.error(e.message ?? '自动分配失败');
    },
  });

  /** 2026-10-03：成功 toast 文案按方向分。WORKER→WORKER 不带批次号：后端
   *  `MoveResult.taken` 只在 POOL→WORKER 时填（契约见 api/workerPool.contract.ts），
   *  转交方向拿不到 batch_no，硬拼只会得到一个空的「已转交批次 」。 */
  function moveSuccessText(res: MoveResultDto): string {
    if (res.from_kind === 'WORKER' && res.to_kind === 'WORKER') return '已在工人之间转交批次';
    return res.to_kind === 'WORKER'
      ? `已分配批次 ${res.taken?.batch_no ?? ''}`.trim()
      : '已撤回批次至候选池';
  }

  /** POOL → WORKER mutation 包装 —— 保留 Promise<boolean> 签名以兼容
   * WorkerColumn.onDragAdd 调用点。`from.shelf_id` 必填（空串直接早退，避免
   * 发出必被后端 20122 拒的请求）。早退同样失效：Sortable 已经把卡片 DOM 搬进
   * 目标列，此时不重拉，屏幕上就留下一张服务器并不承认的卡。 */
  async function moveBatchToWorker(
    batchId: string,
    toWorkerId: string,
    fromShelfId: string,
  ): Promise<boolean> {
    if (!fromShelfId) {
      ElMessage.warning('批次货架信息缺失，无法分配');
      await invalidatePoolDomains();
      return false;
    }
    try {
      await moveMutation.mutateAsync({
        batch_id: batchId,
        from: { kind: 'POOL', shelf_id: fromShelfId },
        to: { kind: 'WORKER', worker_id: toWorkerId },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** WORKER → POOL mutation 包装 —— 保留 Promise<boolean> 签名以兼容
   * PoolDrawer.onDragAdd 调用点。目标货架为空早退时同样失效（与 POOL→WORKER 同理：
   * DOM 已被搬进池子，不重拉就留着幻影）。 */
  async function moveBatchToPool(
    batchId: string,
    fromWorkerId: string,
    toShelfId: string,
  ): Promise<boolean> {
    if (!toShelfId) {
      ElMessage.warning('请先选择目标货架');
      await invalidatePoolDomains();
      return false;
    }
    try {
      await moveMutation.mutateAsync({
        batch_id: batchId,
        from: { kind: 'WORKER', worker_id: fromWorkerId },
        to: { kind: 'POOL', shelf_id: toShelfId },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 2026-10-03：WORKER → WORKER mutation 包装（工人之间转交）。与上面两个包装
   *  共用同一个 moveMutation，故失效链 / toast / 错误桥接完全同构。
   *  from 与 to 都是 worker_id：`from` 由拖拽源的 WorkerColumn.onDragStart 记进
   *  dndSourceTracker（与「撤回候选池」共用工人源），`to` 是落点列自己的 worker.id。
   *  不校验 from ≠ to —— 拖回自己那一列不构成一次移动，由调用方早退。 */
  async function moveBatchBetweenWorkers(
    batchId: string,
    fromWorkerId: string,
    toWorkerId: string,
  ): Promise<boolean> {
    try {
      await moveMutation.mutateAsync({
        batch_id: batchId,
        from: { kind: 'WORKER', worker_id: fromWorkerId },
        to: { kind: 'WORKER', worker_id: toWorkerId },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** runAutoAllocate mutation 包装 —— 保留 Promise<void> 签名。 */
  async function runAutoAllocate(req: AutoAllocateRequest): Promise<void> {
    await autoAllocateMutation.mutateAsync(req);
  }

  return {
    // 2026-09-30：模块级 workers ref 已无外部写点 / 无消费方，恒为空数组。
    // 2026-10-03 订正：此前注「后端 /prod/workers CRUD 上线后接入」是失实表述 ——
    // 后端 CRUD 早已上线（GET/POST `/prod/workers`、`POST /{id}/update`、
    // `/{id}/deactivate`、`/{id}/reactivate`），且已被工人一览页经
    // `src/api/worker.ts::listWorkers` / `createWorker` 消费。本 ref 之所以空，是
    // **useWorkerQueue 自身**的消费方被移除，与后端无关。保留字段仅为不破坏潜在
    // 未来 callers。
    workers: ref<Worker[]>([]) as Ref<Worker[]>,
    error,
    moveBatchToWorker,
    moveBatchToPool,
    moveBatchBetweenWorkers,
    runAutoAllocate,
  };
}
