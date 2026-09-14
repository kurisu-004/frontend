// 2026-09-14 重写：useWorkerQueue composable 从 fixture 切到真实 v2 API。
//
// 历史：
// - 2026-08-26：阶段一，全部走 fixture（@/api/__fixtures__/workerPool.fixtures）。
// - 2026-09-14：阶段二，5 个端点切真：
//   GET  /api/v2/worker-pool/state                  ← getWorkerState
//   GET  /api/v2/worker-pool/{process_id}           ← getWorkerPoolByProcess
//   POST /api/v2/admin/worker-pool/refill           ← refillWorkerPool
//   POST /api/v2/admin/worker-pool/remove           ← removeFromWorkerPool
//   POST /api/v2/admin/worker-pool/auto-allocate    ← autoAllocate
//
// 适配策略（CLAUDE.md 习惯；rust 实际响应字段为准，**只改前端**适配 rust）：
// - `workers[]`：聚合各 process 的 WorkerBriefDto + 二次 GET WorkerPoolState 补
//   max_held / current_held / capacity_remaining；process_ids 从聚合过程派生（worker
//   出现在哪个 process 的 pool 响应里就 +1）。
// - `processPools[]`：从 WorkerPoolDto.items 映射（PoolBatchItem → WorkOrderCard）。
// - `workerHeld`：WorkerPoolState 仅返回 current_held 计数（无 batch 列表），rust
//   端未提供「worker 持有 batch 列表」单端点 → loadBoard 后 workerHeld 恒为空 {}。
//   拖拽乐观更新期间，本地缓存仍能渲染；下次刷新清空（UX 退化，文档记录在 view）。
// - moveBatchToWorker → 调 refillWorkerPool（rust 不提供「单 batch 分配」端点）；
//   moveBatchToPool → 调 removeFromWorkerPool（1-to-1 语义吻合）。

import { ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  autoAllocate,
  getWorkerPoolByProcess,
  getWorkerState,
  refillWorkerPool,
  removeFromWorkerPool,
} from '@/api/workerPool';
import { listProcesses } from '@/api/processChain';
import type {
  PoolBatchItemDto,
  WorkerBriefDto,
  WorkerPoolDto,
  WorkerRefillResultDto,
  WorkerStateDto,
  WorkerTakenItemDto,
} from '@/api/workerPool.contract';
import type { Worker, ProcessPoolView, WorkOrderCard } from '@/types/workerPool';

// 模块级单例 state
const workers = ref<Worker[]>([]);
const processPools = ref<ProcessPoolView[]>([]);
/** worker_id → 持有的 WorkOrderCard[]；rust 端无单端点 GET，loadBoard 后为空。
 *  拖拽乐观更新期间由 moveBatchToWorker 写入，下次刷新清空。 */
const workerHeld = ref<Record<string, WorkOrderCard[]>>({});
const loading = ref(false);
const error = ref<string | null>(null);
// 2026-09-14 review 第 2 轮：删除原 lastTakenCount 模块级单例 ref — 该 ref 跨
// moveBatchToWorker 调用天然粘性（用户拖 batch A 后，下次拖 batch B 看到的是上一次的 N），
// 且 view 层从未消费（grep 全仓 0 命中），永远 0、永远不触发 UI 反馈。
// 改为在 moveBatchToWorker 内部直接 ElMessage.success（与 moveBatchToPool 失败回滚
// 时 error.value = ... 的内部 UX 处理风格一致）。

/** 把 PoolBatchItemDto 适配成 UI WorkOrderCard（字段映射）。 */
function poolItemToCard(it: PoolBatchItemDto): WorkOrderCard {
  return {
    batch_id: it.batch_id,
    batch_no: `B${it.batch_no}`,
    part_id: it.part_id,
    drawing_no: it.drawing_no,
    part_name: it.name,
    quantity: it.quantity,
    serial_no: it.serial_no,
    system_delivery_date: it.system_delivery_date,
    planned_delivery_date: null, // PoolBatchItem 不带 planned_delivery_date
    is_urgent: it.is_urgent,
    version: it.version,
    customer: it.customer_name ?? null,
    applicant: it.applicant_name ?? null,
    location: it.shelf_code ?? null,
  };
}

/** 把 WorkerBriefDto + WorkerStateDto 合并为 UI Worker。 */
function mergeWorker(brief: WorkerBriefDto, state: WorkerStateDto | null): Worker {
  return {
    id: brief.worker_id,
    name: brief.name,
    badge_code: '', // WorkerBrief 不带 badge_code（前端扩展占位，rust 待补）
    work_type_code: brief.work_type_code,
    max_held: state?.max_held ?? 0,
    current_held: state?.current_held ?? 0,
    capacity_remaining: state?.capacity_remaining ?? 0,
    is_online: true, // WorkerBrief 不带 is_online（rust 当前端点不返）
    process_ids: [], // 由聚合逻辑（loadBoard 内）填充
  };
}

export function useWorkerQueue() {
  /** 拉所有 process 的 pool detail + 二次查 worker state。
   *  流程：
   *  1) GET /api/v2/processes?limit=500 拿到所有 process（用于「按 process 维度」遍历）
   *  2) 并发调 getWorkerPoolByProcess(processId) 拿到各 process 的 worker / items
   *  3) 聚合：worker 跨 process 出现 → process_ids += processId；items → processPools
   *  4) 二次并发 getWorkerState 补 max_held / current_held / capacity_remaining
   *
   * 2026-09-14 review 第 1 轮：
   * - `shelfId` 由 view 层从 `useAuthSession().activeShelfId()` 注入；null/空串 → 跳过
   *   二次 GET（rust WorkerPoolState 必填 shelf_id；无激活货架时用占位 '0' 必触发 40001
   *   BIZ_SHELF_NOT_FOUND，导致所有 worker 的 max_held/current_held/capacity_remaining 退化为 0）。
   * - `listProcesses` 改从 `@/api/processChain` 导入（v2，baseURL /api/v2）；不再走
   *   `@/api/process` 的 v1 端点。 */
  async function loadBoard(shelfId: string | null): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      // 1) 拉所有 process（v2 端点 /api/v2/processes）
      const procList = await listProcesses({});
      const processIds: string[] = (procList as Array<{ id: string }>).map((p) => p.id);

      // 2) 并发拉各 process 的 pool detail
      const poolResults = await Promise.allSettled(
        processIds.map((pid) => getWorkerPoolByProcess(pid)),
      );

      // 3) 聚合：processPools + workers（去重，process_ids 累加）
      const workerMap = new Map<string, Worker>();
      const newProcessPools: ProcessPoolView[] = [];
      const workerIds = new Set<string>();

      poolResults.forEach((r, idx) => {
        if (r.status !== 'fulfilled') return;
        const pool: WorkerPoolDto = r.value;
        const processId = processIds[idx]!;
        // processPools
        newProcessPools.push({
          process_id: pool.process_id,
          process_code: pool.process_code,
          process_name: pool.process_name,
          batches: pool.items.map(poolItemToCard),
        });
        // workers（聚合 process_ids）
        pool.workers.forEach((wb) => {
          workerIds.add(wb.worker_id);
          const existing = workerMap.get(wb.worker_id);
          if (existing) {
            if (!existing.process_ids.includes(processId)) {
              existing.process_ids.push(processId);
            }
          } else {
            workerMap.set(wb.worker_id, mergeWorker(wb, null));
            workerMap.get(wb.worker_id)!.process_ids.push(processId);
          }
        });
      });

      // 4) 二次并发 getWorkerState 补 max_held / current_held / capacity_remaining
      // shelfId 由 caller 注入；空 → 跳过二次 GET（已知 UX 退化：worker 列显示「0/0」）。
      if (shelfId && shelfId.length > 0) {
        const stateResults = await Promise.allSettled(
          Array.from(workerIds).map(async (wid) => {
            try {
              return await getWorkerState({ worker_id: wid, shelf_id: shelfId });
            } catch {
              return null;
            }
          }),
        );
        let i = 0;
        for (const wid of workerIds) {
          const r = stateResults[i++];
          if (r && r.status === 'fulfilled' && r.value) {
            const state: WorkerStateDto = r.value;
            const w = workerMap.get(wid);
            if (w) {
              w.max_held = state.max_held;
              w.current_held = state.current_held;
              w.capacity_remaining = state.capacity_remaining;
              w.work_type_code = state.work_type_code || w.work_type_code;
            }
          }
        }
      }

      workers.value = Array.from(workerMap.values());
      processPools.value = newProcessPools;
      // 2026-09-14：workerHeld 保持 {}（WorkerPoolState 不含 batch 列表）。
      // 拖拽乐观更新期间，moveBatchToWorker 写入；下次 loadBoard 清空。
      workerHeld.value = {};
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'load failed';
    } finally {
      loading.value = false;
    }
  }

  // 在所有 pool + workerHeld 中查找 batch
  function locateBatch(batch_id: string): {
    pool: ProcessPoolView | null;
    workerId: string | null;
    idx: number;
    batch: WorkOrderCard | null;
  } {
    for (const p of processPools.value) {
      const idx = p.batches.findIndex((b) => b.batch_id === batch_id);
      if (idx >= 0) return { pool: p, workerId: null, idx, batch: p.batches[idx]! };
    }
    for (const [wid, list] of Object.entries(workerHeld.value)) {
      const idx = list.findIndex((b) => b.batch_id === batch_id);
      if (idx >= 0) return { pool: null, workerId: wid, idx, batch: list[idx]! };
    }
    return { pool: null, workerId: null, idx: -1, batch: null };
  }

  /** 把 batch 从 pool 移到 worker。
   *  真实 API：rust 不提供「单 batch 分配」端点，调 refillWorkerPool（批量抢到 max_held）。
   *  乐观更新：本地把目标 batch 从 pool 移到 workerHeld[worker_id]。
   *  失败回滚。 */
  async function moveBatchToWorker(
    batch_id: string,
    to_worker_id: string,
    shelf_id: string,
    _process_id: string,
  ): Promise<boolean> {
    void _process_id;
    const target = workers.value.find((w) => w.id === to_worker_id);
    if (!target) {
      error.value = `worker ${to_worker_id} not found`;
      return false;
    }
    if (target.capacity_remaining <= 0) {
      error.value = `${target.name} 持有已满（${target.current_held}/${target.max_held}）`;
      return false;
    }

    const loc = locateBatch(batch_id);
    if (!loc.batch) {
      error.value = `batch ${batch_id} not found`;
      return false;
    }

    // 乐观更新：先在本地移动
    const original = loc.batch;
    const moved: WorkOrderCard = { ...original, version: original.version + 1 };
    if (loc.pool) {
      loc.pool.batches.splice(loc.idx, 1);
    } else if (loc.workerId) {
      workerHeld.value[loc.workerId]!.splice(loc.idx, 1);
    }
    const targetList = workerHeld.value[to_worker_id] ?? [];
    targetList.push(moved);
    workerHeld.value[to_worker_id] = targetList;
    target.current_held += 1;
    target.capacity_remaining -= 1;

    try {
      // 2026-09-14：rust refillWorkerPool 批量抢到 max_held；与「单 batch 分配」语义
      // 不完全一致，但这是该域唯一可用的「worker 从 pool 拿 batch」端点。
      const result: WorkerRefillResultDto = await refillWorkerPool({
        worker_id: to_worker_id,
        shelf_id: String(shelf_id),
      });
      // 2026-09-14 review 第 2 轮：parse result.taken（服务端确认抢到的批次）。
      // WorkerRefillResult 按 worker 拆分（单一 worker_id），taken[] 含服务端确认抢到的批次。
      // 由于 taken 字段窄（无 name / drawing_no / customer 等 WorkOrderCard 必备字段），
      // 不重构 workerHeld — 保留乐观更新（已含 dragged batch）。其他被自动抢到的批次
      // 将在下次 loadBoard 后由 workerHeld 派生更新。直接内部 ElMessage 反馈（不再
      // 暴露 lastTakenCount ref — 模块级单例有粘性，view 层无法可靠消费「本次调用」的 N）。
      // 服务端返回 0 通常意味着「池空 / 容量触顶」正常路径，info 提示而非 success。
      if (result.taken.length > 0) {
        ElMessage.success(`已批量抢到 ${result.taken.length} 个`);
      } else {
        ElMessage.info('池空或容量触顶，未抢到新批次');
      }
      return true;
    } catch (e) {
      // 回滚
      if (loc.pool) {
        loc.pool.batches.splice(loc.idx, 0, original);
      } else if (loc.workerId) {
        workerHeld.value[loc.workerId]!.splice(loc.idx, 0, original);
      }
      const rollbackIdx = (workerHeld.value[to_worker_id] ?? []).findIndex(
        (b) => b.batch_id === batch_id,
      );
      if (rollbackIdx >= 0) workerHeld.value[to_worker_id]!.splice(rollbackIdx, 1);
      target.current_held -= 1;
      target.capacity_remaining += 1;
      error.value = e instanceof Error ? e.message : 'assign failed';
      return false;
    }
  }

  /** 把 batch 从 worker 移回 pool（按 RETURNED 语义）。
   *  真实 API：removeFromWorkerPool（1-to-1 语义吻合）。 */
  async function moveBatchToPool(
    batch_id: string,
    from_worker_id: string,
    shelf_id: string,
    next_process_id: string,
  ): Promise<boolean> {
    const list = workerHeld.value[from_worker_id];
    if (!list) {
      error.value = `worker ${from_worker_id} has no held`;
      return false;
    }
    const idx = list.findIndex((b) => b.batch_id === batch_id);
    if (idx < 0) {
      error.value = `batch ${batch_id} not held by ${from_worker_id}`;
      return false;
    }
    const original = list[idx]!;
    const targetPool = processPools.value.find((p) => p.process_id === next_process_id);
    if (!targetPool) {
      error.value = `process ${next_process_id} not found`;
      return false;
    }

    const moved: WorkOrderCard = { ...original, version: original.version + 1 };
    list.splice(idx, 1);
    targetPool.batches.push(moved);
    const worker = workers.value.find((w) => w.id === from_worker_id);
    if (worker) {
      worker.current_held -= 1;
      worker.capacity_remaining += 1;
    }

    try {
      const _taken: WorkerTakenItemDto = await removeFromWorkerPool({
        worker_id: from_worker_id,
        batch_id,
        shelf_id: String(shelf_id),
        next_process_id: String(next_process_id),
      });
      void _taken;
      return true;
    } catch (e) {
      // 回滚
      list.splice(idx, 0, original);
      const rollbackIdx = targetPool.batches.findIndex((b) => b.batch_id === batch_id);
      if (rollbackIdx >= 0) targetPool.batches.splice(rollbackIdx, 1);
      if (worker) {
        worker.current_held += 1;
        worker.capacity_remaining += 1;
      }
      error.value = e instanceof Error ? e.message : 'return failed';
      return false;
    }
  }

  /** POST /api/v2/admin/worker-pool/auto-allocate 触发入口（前端可挂按钮）。
   *  流程：调用方传 processId + shelfId + mode + fill_ratio；返回填充结果。
   *  2026-09-14 review 第 1 轮：loadBoard 需要 shelfId；这里从 req.shelf_id 派生（auto-allocate
   *  本就需要 shelf_id 入参）。 */
  async function runAutoAllocate(req: {
    process_id: string;
    shelf_id: string;
    mode: 'COUNT' | 'TIME';
    fill_ratio: number;
  }): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await autoAllocate(req);
      // 成功后刷新整个看板，shelfId 来自 req（auto-allocate 必填）
      await loadBoard(req.shelf_id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'auto allocate failed';
    } finally {
      loading.value = false;
    }
  }

  return {
    workers: workers as Ref<Worker[]>,
    processPools: processPools as Ref<ProcessPoolView[]>,
    workerHeld: workerHeld as Ref<Record<string, WorkOrderCard[]>>,
    loading: loading as Ref<boolean>,
    error: error as Ref<string | null>,
    loadBoard,
    moveBatchToWorker,
    moveBatchToPool,
    runAutoAllocate,
  };
}
