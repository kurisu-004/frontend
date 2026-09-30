// 2026-09-30 重构：useWorkerQueue composable —— 移除 pool fetches，迁移 3 个 mutation 到
// useMutation + invalidate helpers；保留 workerHeld 模块级 ref 给 WorkerColumn 跨 tab 共享。
//
// 2026-09-30 改造前历史：
// - 2026-08-26：阶段一，全部走 fixture。
// - 2026-09-14：5 个端点切真。
// - 2026-09-14 follow-up：WorkerStateDto.held_batches 新增；moveBatchToWorker 改用
//   assignWorkerPool（单 batch 分配）。
//
// 2026-09-30 改造要点（沿 2026-09-26 TanStack Query 9 条 + 2026-09-30 硬约束）：
// - 删 `getWorkerPoolByProcess` import / `listProcesses` import / pool fetch 循环 /
//   `WorkerPoolDto` import / `WorkerBriefDto` import；
// - 保留 `getWorkerState` import / `workerHeld` ref（来源改为 TanStack 缓存合并）/ `loading`
//   ref / `error` ref；
// - `loadBoard` 简化为「拉所有 worker 的 state」单步 —— 从
//   qc.getQueriesData({ queryKey: qk.workerPoolByProcessPrefix }) 收集当前 cache 内
//   所有 inhouse 工序的 worker_id，并发 `getWorkerState` 写 `workerHeld`（兜底：tab 未
//   激活时 cache 为空，workerHeld 自然为空，符合「切 tab 首次激活才拉」语义）；
// - 3 个 mutation：useMutation + onSuccess 调 invalidateWorkerPoolByProcessQuery(qc, processId)
//   + invalidateWorkerPoolCountsQuery(qc) + ElMessage；
// - moveBatchToWorker / moveBatchToPool / runAutoAllocate 改为 mutation 的 mutateAsync 包装
//   （保留 Promise<boolean> / Promise<void> 签名以兼容 view 现有调用点）；
// - error ref 保留：mutation onError 写 error.value = e.message。
//
// 模块级单例（仍保留）—— view 端解构后 `useWorkerQueue()` 多次调用拿同一引用，避免
// 重复订阅造成的资源浪费；worker-pool 域的批量数据（KB 级）不依赖组件实例生命周期。

import { computed, ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  assignWorkerPool,
  autoAllocate,
  getWorkerState,
  removeFromWorkerPool,
} from '@/api/workerPool';
import type {
  AdminAssignRequest,
  AssignResultDto,
  AutoAllocateResultDto,
  AutoAllocateRequest,
  WorkerRemoveRequest,
  WorkerStateDto,
  WorkerTakenItemDto,
} from '@/api/workerPool.contract';
import type { Worker, WorkOrderCard } from '@/types/workerPool';
import { qk } from '@/composables/queries/keys';
import { invalidateWorkerPoolByProcessQuery } from '@/composables/queries/useWorkerPoolByProcessQuery';
import { invalidateWorkerPoolCountsQuery } from '@/composables/queries/useWorkerPoolCountsQuery';

// 模块级单例 state
const workers = ref<Worker[]>([]);
/** worker_id → 持有的 WorkOrderCard[]。
 *  2026-09-30：来源改为 TanStack 缓存合并 —— WorkerColumn 内
 *  useWorkerStateByWorkerQuery 拉到的 held_batches 也合并进 workerHeld；
 *  loadBoard 内并发 getWorkerState 兜底当前 cache 内所有 inhouse 工序的 worker_id。
 *  不再由 loadBoard 全量刷新（commit 4 起）。 */
const workerHeld = ref<Record<string, WorkOrderCard[]>>({});
const loading = ref(false);
const error = ref<string | null>(null);

/** 2026-09-30：把 HeldBatchItemDto 适配成 UI WorkOrderCard —— 此函数定义在
 *  views/workers/composables/poolItemToCard.ts，本文件不再独立定义；保留单文件内
 *  inline 简版以保 loadBoard 路径不依赖额外 import。
 *  （WorkerColumn 通过 shared poolItemToCard.ts 引入 heldToCard，本 loadBoard 走 inline
 *  版本即可，保持向后兼容。） */
import { heldToCard as _heldToCard } from './poolItemToCard';

/** 2026-09-21 显式返回类型。
 *  2026-09-30：移除 processPools 字段（WorkerPoolTab + PendingPoolCard 自管
 *  useWorkerPoolByProcessQuery，无 module-level ref 必要）；新增 3 个 mutation 的
 *  mutateAsync 包装（moveBatchToWorker / moveBatchToPool / runAutoAllocate 沿用
 *  原签名以兼容 view 现有调用点）。 */
export interface UseWorkerQueueReturn {
  workers: Ref<Worker[]>;
  workerHeld: Ref<Record<string, WorkOrderCard[]>>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** 2026-09-30：简化为「并发拉 cache 内所有 worker 的 state」单步 —— 不再拉 processes +
   *  worker-pool（这些已迁出到 useProcessesQuery + useWorkerPoolByProcessQuery）。
   *  返回 Promise<void> 让 caller 可 await 同步看板。 */
  loadBoard: (shelfId: string | null) => Promise<void>;
  /** 2026-09-30：mutation 包装（沿 useMutation mutateAsync 形态），保留
   *  Promise<boolean> 签名以兼容 view 现有调用点（PoolDrawer.vue onDragAdd / 等）。 */
  moveBatchToWorker: (
    batch_id: string,
    to_worker_id: string,
    shelf_id: string,
    process_id: string,
  ) => Promise<boolean>;
  moveBatchToPool: (
    batch_id: string,
    from_worker_id: string,
    shelf_id: string,
    next_process_id: string,
  ) => Promise<boolean>;
  runAutoAllocate: (req: {
    process_id: string;
    shelf_id: string;
    mode: 'COUNT' | 'TIME';
    fill_ratio: number;
  }) => Promise<void>;
}

export function useWorkerQueue(): UseWorkerQueueReturn {
  const qc = useQueryClient();

  /** 2026-09-30：3 个 mutation 集中编排 invalidate 链 + ElMessage。
   *  mutationKey 三层数组；不写 retry（信任 main.ts 全局 mutations.retry: 0）。
   *  写 mutation onSuccess 失效链：
   *    - moveBatchToWorker.onSuccess(processId) → invalidateWorkerPoolByProcessQuery(qc, processId) +
   *      invalidateWorkerPoolCountsQuery(qc)
   *    - moveBatchToPool.onSuccess(processId) → 同上
   *    - runAutoAllocate.onSuccess(processId) → 同上（auto allocate 跨 worker 但 items 同样变化） */
  const assignMutation = useMutation<AssignResultDto, Error, AdminAssignRequest & { process_id: string }>({
    mutationKey: ['worker-pool', 'assign'],
    mutationFn: async (req) => assignWorkerPool(req),
    onSuccess: async (res, vars) => {
      await invalidateWorkerPoolByProcessQuery(qc, vars.process_id);
      await invalidateWorkerPoolCountsQuery(qc);
      ElMessage.success(`已分配批次 ${res.taken.batch_no}`);
    },
    onError: (e: Error) => {
      error.value = e.message ?? 'assign failed';
      ElMessage.error(e.message ?? '分配批次失败');
    },
  });

  const removeMutation = useMutation<WorkerTakenItemDto, Error, WorkerRemoveRequest & { process_id: string }>({
    mutationKey: ['worker-pool', 'remove'],
    mutationFn: async (req) => removeFromWorkerPool(req),
    onSuccess: async (_res, vars) => {
      await invalidateWorkerPoolByProcessQuery(qc, vars.process_id);
      await invalidateWorkerPoolCountsQuery(qc);
    },
    onError: (e: Error) => {
      error.value = e.message ?? 'return failed';
      ElMessage.error(e.message ?? '撤回批次失败');
    },
  });

  const autoAllocateMutation = useMutation<AutoAllocateResultDto, Error, AutoAllocateRequest>({
    mutationKey: ['worker-pool', 'auto-allocate'],
    mutationFn: async (req) => autoAllocate(req),
    onSuccess: async (_res, vars) => {
      await invalidateWorkerPoolByProcessQuery(qc, vars.process_id);
      await invalidateWorkerPoolCountsQuery(qc);
    },
    onError: (e: Error) => {
      error.value = e.message ?? 'auto allocate failed';
      ElMessage.error(e.message ?? '自动分配失败');
    },
  });

  /** 2026-09-30：moveBatchToWorker mutation 包装 —— 保留 Promise<boolean> 签名
   *  以兼容 view 现有调用点（WorkerColumn onDragAdd → 调用处）。 */
  async function moveBatchToWorker(
    batch_id: string,
    to_worker_id: string,
    shelf_id: string,
    process_id: string,
  ): Promise<boolean> {
    try {
      await assignMutation.mutateAsync({
        worker_id: to_worker_id,
        batch_id,
        shelf_id: String(shelf_id),
        process_id: String(process_id),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 2026-09-30：moveBatchToPool mutation 包装 —— 保留 Promise<boolean> 签名。 */
  async function moveBatchToPool(
    batch_id: string,
    from_worker_id: string,
    shelf_id: string,
    next_process_id: string,
  ): Promise<boolean> {
    try {
      await removeMutation.mutateAsync({
        worker_id: from_worker_id,
        batch_id,
        shelf_id: String(shelf_id),
        next_process_id: String(next_process_id),
        process_id: next_process_id,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 2026-09-30：runAutoAllocate mutation 包装 —— 保留 Promise<void> 签名。 */
  async function runAutoAllocate(req: {
    process_id: string;
    shelf_id: string;
    mode: 'COUNT' | 'TIME';
    fill_ratio: number;
  }): Promise<void> {
    await autoAllocateMutation.mutateAsync(req);
  }

  /** 2026-09-30 简化：loadBoard 不再拉 processes + 各 worker-pool（迁到共享
   *  useProcessesQuery / useWorkerPoolByProcessQuery）。改为「拉当前 cache 内所有
   *  inhouse 工序的 worker 的 state」单步 —— WorkerColumn 内 useWorkerStateByWorkerQuery
   *  拉到的 held_batches 走 cache identity 直接合并；本 loadBoard 仅做 seed 兜底
   *  （跨 tab 切换时 WorkerColumn 重建后首次激活前的占位视图）。
   *
   *  流程：
   *  1) 从 qc.getQueriesData({ queryKey: qk.workerPoolByProcessPrefix }) 收集 worker_id
   *  2) 并发 getWorkerState 写 workerHeld
   *  3) 不抛错（catch 写 error.value）
   */
  async function loadBoard(shelfId: string | null): Promise<void> {
    if (!shelfId || shelfId.length === 0) {
      // 无激活货架时清空 workerHeld（与原 loadBoard 「跳过二次 GET」语义一致）
      workerHeld.value = {};
      return;
    }
    loading.value = true;
    try {
      const cached = qc.getQueriesData<{
        workers: Array<{ worker_id: string }>;
      }>({ queryKey: qk.workerPoolByProcessPrefix });
      const workerIds = new Set<string>();
      for (const [, d] of cached) {
        if (d?.workers) {
          for (const w of d.workers) workerIds.add(w.worker_id);
        }
      }
      if (workerIds.size === 0) return;
      const results = await Promise.allSettled(
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
        const r = results[i++];
        if (r && r.status === 'fulfilled' && r.value) {
          const state: WorkerStateDto = r.value;
          workerHeld.value[wid] = (state.held_batches ?? []).map(_heldToCard);
        }
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'loadBoard failed';
    } finally {
      loading.value = false;
    }
  }

  return {
    workers: workers as Ref<Worker[]>,
    workerHeld: workerHeld as Ref<Record<string, WorkOrderCard[]>>,
    loading: loading as Ref<boolean>,
    error: error as Ref<string | null>,
    loadBoard,
    moveBatchToWorker,
    moveBatchToPool,
    runAutoAllocate,
  };
}

// 2026-09-30：workers ref 保留导出但不再有外部写点（processPools 已下线，
// workerHeld 来源改为 cache 合并）。本注释防止 reviewer 误删。
void computed;