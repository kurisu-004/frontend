// src/views/workers/composables/usePendingDispatch.ts
//
// 2026-09-29 新增：生产队列「待下发」Tab 视图层 composable。
//
// 角色：
//   - 持有 selectedIds（Set<string>）私有状态 —— 多选卡 + 自动下发共用；
//   - 内部消费 usePendingBatchesQuery（共享基础数据层），暴露 batches /
//     total / isLoading 给 view 层；
//   - 提供 3 个 mutation（dispatchMutation 单件 / bulkDispatchMutation 批量 /
//     autoDispatchMutation 自动下发），mutationFn 内集中调
//     invalidatePendingBatchesQuery + invalidateProcessesQuery + invalidatePartsQuery
//     三域失效（沿 2026-09-26 写操作精确失效约定）；
//   - 不写 retry（信任 main.ts 全局 mutations.retry: 0）；
//   - mutationKey 三层数组（['pending-batches', 'dispatch'] 等）。
//
// composable 归属判别（2026-09-27 CLAUDE.md）：仅 workers 单域使用，下沉到
// views/workers/composables/。spec 文件与源文件同级 __tests__/ 目录。

import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import {
  autoDispatchBatches,
  bulkDispatchBatches,
  dispatchBatch,
  type AutoDispatchResultDto,
  type BulkDispatchResultDto,
  type DispatchBatchRequest,
  type DispatchBatchResultDto,
} from '@/api/pendingBatches';
import { ApiError } from '@/api/http';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';
import { invalidatePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import { invalidateProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { qk } from '@/composables/queries/keys';
import { usePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import {
  BIZ_PROCESS_CHAIN_REQUIRED,
  handleProcessChainRequired,
} from '@/composables/useProcessChainRequiredHandler';
import type { ListPendingBatchesParams } from '@/api/pendingBatches';

/** 2026-09-29 review 第 1 轮修复：usePendingDispatch 显式接受 deps，由 caller
 *  （WorkerQueueBoard）注入刷新 processPools 的回调 —— useWorkerQueue.processPools
 *  是模块级 ref（非 TanStack Query），invalidate 失效链触达不到它，必须依赖
 *  loadBoard(shelfId) 重新拉取 + 聚合（沿 usePartDispatch.batchDispatchMutation
 *  onSuccess 模式）。 */
export interface UsePendingDispatchDeps {
  /** 重新拉 useWorkerQueue 看板（processPools / workers / workerHeld 三个本地 ref）。
   *  caller 注入 = async () => queue.loadBoard(activeShelfId ?? null)。 */
  refreshBoard: () => Promise<void>;
}

export interface UsePendingDispatchReturn {
  /** 待下发批次列表（已与共享 query 解包） */
  batches: ComputedRef<PendingBatchItemDto[]>;
  /** 总数 */
  total: ComputedRef<number>;
  /** isFetching 暴露给 view 层（loading 占位） */
  isLoading: Ref<boolean>;
  /** 多选卡已选 batchId 集合 */
  selectedIds: Ref<Set<string>>;
  /** 已选件数（derived） */
  selectedCount: ComputedRef<number>;
  /** 多选切换（view 层 el-table @selection-change → 全量替换） */
  setSelectedIds: (ids: string[]) => void;
  /** 清除已选 */
  clearSelection: () => void;
  /** 单件下发 mutation（mutation.isPending / mutate） */
  dispatchMutation: ReturnType<
    typeof useMutation<DispatchBatchResultDto, Error, { batchId: string; req: DispatchBatchRequest }>
  >;
  /** 批量下发 mutation（mutation.isPending / mutate）。
   *  2026-09-29 review 第 1 轮修复：shelfId / nextProcessId 改可选，缺省走 auto 端点。 */
  bulkDispatchMutation: ReturnType<
    typeof useMutation<
      BulkDispatchResultDto,
      Error,
      { batchIds: string[]; shelfId?: string; nextProcessId?: string }
    >
  >;
  /** 自动下发 mutation（mutation.isPending / mutate） */
  autoDispatchMutation: ReturnType<
    typeof useMutation<AutoDispatchResultDto, Error, { batchIds: string[] }>
  >;
}

/**
 * 2026-09-29 新增：生产队列「待下发」Tab 视图层 composable。
 *
 * 用法：
 *   ```ts
 *   const dispatch = usePendingDispatch({ refreshBoard: async () => queue.loadBoard(shelfId) });
 *   dispatch.dispatchMutation.mutate({ batchId, req: {} });
 *   dispatch.bulkDispatchMutation.mutate({ batchIds });
 *   dispatch.autoDispatchMutation.mutate({ batchIds: [...dispatch.selectedIds.value] });
 *   ```
 *
 * 2026-09-29 review 第 1 轮修复：
 *  - 接受 deps.refreshBoard —— processPools 是模块级 ref，invalidate 失效链触达不到；
 *  - bulkDispatchMutation shelfId / nextProcessId 改为可选，缺省走 autoDispatchBatches
 *    端点（service 端按 process_chain_id 推导 first step），保持 PendingPoolsPanel
 *    单击调用的「最小实现」语义（review C4 / C1）。
 *  - dispatch / bulk / auto 三类 mutation 统一接 handleProcessChainRequired：命中
 *    20706 → 弹「前往制定」确认框 → 跳 /production/process-design?part_id=...（沿
 *    usePartDispatch.ts:140-141 / 158-162 范本）。
 */
export function usePendingDispatch(deps: UsePendingDispatchDeps): UsePendingDispatchReturn {
  const qc = useQueryClient();
  // 2026-09-29 review 第 1 轮修复：useRouter() 必须在 setup 顶部一次性拿闭包复用，
  // 沿 usePartDispatch.ts:92 fix（vue-router 4.6.4 + vue 3.5.38 下 inject() 在
  // lifecycle hook 之外返回 undefined）。
  const router = useRouter();

  // 2026-09-29：共享 useQuery 消费方式 —— 默认 limit=200（任务规约：KB 级基础数据，
  // 全量拉取；写操作触发 invalidate 失效）。reactive params 留空（不接受外部驱动），
  // 与 useCustomerTree 同形态 —— 单 caller 拿 data 即可。
  const params: ListPendingBatchesParams = { limit: 200 };
  const query = usePendingBatchesQuery(params);

  const batches = computed<PendingBatchItemDto[]>(() => query.data.value?.items ?? []);
  const total = computed<number>(() => query.data.value?.total ?? 0);
  const isLoading = query.isFetching;

  // ===== 多选状态 =====
  const selectedIds = ref<Set<string>>(new Set());
  const selectedCount = computed<number>(() => selectedIds.value.size);
  function setSelectedIds(ids: string[]): void {
    selectedIds.value = new Set(ids);
  }
  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  // 2026-09-29 review 第 1 轮修复（C1 / C2）：批 / 件 → partId 反查表 + 20706 兜底
  // + 跨域失效 + refreshBoard。后续 dispatch / bulk / auto 三个 mutation 共享。
  const partIdByBatchId = computed<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const b of batches.value) m.set(b.batch_id, b.part_id);
    return m;
  });

  /** 2026-09-29：写操作完成后调，集中失效三域（pending-batches / processes / parts）
   *  + caller 注入的 refreshBoard（useWorkerQueue.processPools 同步刷新）。
   *  返回 Promise 让 3 个 mutation onSuccess 内部 await 完整失效链，避免 query 重叠
   *  触发雪崩。 */
  async function invalidateAll(): Promise<void> {
    await invalidatePendingBatchesQuery(qc);
    await invalidateProcessesQuery(qc);
    await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
    // 2026-09-29 review 第 1 轮修复（C2）：processPools 是模块级 ref（非 TanStack
    // Query），invalidate 失效链触达不到。必须显式调 caller 注入的 loadBoard 刷新。
    await deps.refreshBoard();
  }

  /** 2026-09-29 review 第 1 轮修复（C1）：20706 兜底 —— 命中即弹「前往制定」确认框；
   *  返回 true 表示已兜底，caller 不再弹普通错误 toast。 */
  async function maybeHandleChainRequired(
    e: unknown,
    batchIds: readonly string[],
  ): Promise<boolean> {
    if (
      !e ||
      typeof e !== 'object' ||
      !('code' in e) ||
      (e as { code: unknown }).code !== BIZ_PROCESS_CHAIN_REQUIRED
    ) {
      return false;
    }
    // 优先用第一个 batch 的 part_id 做深链（异常不区分具体件，best effort）
    const firstBatchId = batchIds[0];
    const partId = firstBatchId ? partIdByBatchId.value.get(firstBatchId) ?? null : null;
    return handleProcessChainRequired(e, partId, router);
  }

  // ===== mutation 范本（沿 2026-09-26 CLAUDE.md #8）=====

  /** 单件下发 —— mutationKey 三层数组；不写 retry（信任全局默认）。
   *  2026-09-29 review 第 1 轮修复（C1）：onError 接 handleProcessChainRequired 兜底
   *  20706 —— 命中即弹「前往制定」确认框 → 跳 /production/process-design?part_id=...，
   *  沿 usePartDispatch.ts:140-141 / 158-162 范本。 */
  const dispatchMutation = useMutation<
    DispatchBatchResultDto,
    Error,
    { batchId: string; req: DispatchBatchRequest }
  >({
    mutationKey: ['pending-batches', 'dispatch'],
    mutationFn: ({ batchId, req }) => dispatchBatch(batchId, req),
    onSuccess: async () => {
      await invalidateAll();
      ElMessage.success('已下发批次');
    },
    onError: async (e: Error, { batchId }) => {
      const handled = await maybeHandleChainRequired(e, [batchId]);
      if (!handled) ElMessage.error(e.message ?? '下发失败');
    },
  });

  /** 批量下发 —— 2026-09-29 review 第 1 轮修复（C4）：shelfId / nextProcessId 改为可选。
   *  - 两者都给：走 bulkDispatchBatches（精确下发到指定货架 + 工序）；
   *  - 缺省：走 autoDispatchBatches（service 端按 process_chain_id 推导 first_step，
   *    与 autoDispatchMutation 一致）—— 让 PendingPoolsPanel「单击调 bulk dispatch」
   *    的最小实现在没有 shelves / nextProcess 选 UI 时也能工作。
   *  返回类型归一为 BulkDispatchResultDto（两个端点出参形状一致：succeeded / failed）。 */
  const bulkDispatchMutation = useMutation<
    BulkDispatchResultDto,
    Error,
    { batchIds: string[]; shelfId?: string; nextProcessId?: string }
  >({
    mutationKey: ['pending-batches', 'dispatch-bulk'],
    mutationFn: async ({ batchIds, shelfId, nextProcessId }) => {
      if (shelfId && nextProcessId) {
        return bulkDispatchBatches({
          batch_ids: batchIds,
          shelf_id: shelfId,
          next_process_id: nextProcessId,
        });
      }
      // 兜底：缺 shelfId / nextProcessId 时走 auto 端点（service 按 chain 推导）
      const autoRes = await autoDispatchBatches({ batch_ids: batchIds });
      return { succeeded: autoRes.succeeded, failed: autoRes.failed };
    },
    onSuccess: async (res) => {
      await invalidateAll();
      // 成功后清空多选（沿 usePartDispatch.batchDispatchMutation 行为）
      clearSelection();
      const ok = res.succeeded.length;
      const failed = res.failed.length;
      if (ok > 0) ElMessage.success(`已批量下发 ${ok} 件`);
      if (failed > 0) {
        // 20706 BIZ_PROCESS_CHAIN_REQUIRED → 沿 autoDispatch 同样逐个 handleProcessChainRequired
        const chainRequired = res.failed.filter((f) => f.code === BIZ_PROCESS_CHAIN_REQUIRED);
        if (chainRequired.length > 0) {
          for (const f of chainRequired) {
            const partId = partIdByBatchId.value.get(f.batch_id) ?? null;
            await handleProcessChainRequired(
              new ApiError(f.code, f.message || '请先制定工序链'),
              partId,
              router,
            );
          }
        }
        const otherFailed = res.failed.filter((f) => f.code !== BIZ_PROCESS_CHAIN_REQUIRED);
        if (otherFailed.length > 0) {
          const sample = otherFailed
            .slice(0, 3)
            .map((f) => `${f.batch_id}(${f.code})`)
            .join('；');
          ElMessage.error(
            `失败 ${otherFailed.length} 件：${sample}${otherFailed.length > 3 ? '...' : ''}`,
          );
        }
      }
    },
    onError: async (e: Error, { batchIds }) => {
      // 20706 通常在 succeeded/failed 中返回，不会抛 —— 兜底以防 service 端改为 throw
      const handled = await maybeHandleChainRequired(e, batchIds);
      if (!handled) ElMessage.error(e.message ?? '批量下发失败');
    },
  });

  /** 自动下发 —— service 端按 process_chain_id 推导 first_step + shelf；无链的 batch
   * 跳过并返回 failed 条目（前端不阻断其他件）。
   * 2026-09-29 review 第 1 轮修复（C1）：chainRequired 列表逐个 handleProcessChainRequired
   *  替代原 ElMessage.warning（沿 usePartDispatch.batchDispatchMutation mutationFn
   *  内 20706 兜底模式）。 */
  const autoDispatchMutation = useMutation<
    AutoDispatchResultDto,
    Error,
    { batchIds: string[] }
  >({
    mutationKey: ['pending-batches', 'auto-dispatch'],
    mutationFn: ({ batchIds }) => autoDispatchBatches({ batch_ids: batchIds }),
    onSuccess: async (res) => {
      await invalidateAll();
      clearSelection();
      const ok = res.succeeded.length;
      const failed = res.failed.length;
      if (ok > 0) ElMessage.success(`自动下发成功 ${ok} 件`);
      if (failed > 0) {
        // 20706 BIZ_PROCESS_CHAIN_REQUIRED → 逐个弹「前往制定」确认框
        const chainRequired = res.failed.filter((f) => f.code === BIZ_PROCESS_CHAIN_REQUIRED);
        for (const f of chainRequired) {
          const partId = partIdByBatchId.value.get(f.batch_id) ?? null;
          await handleProcessChainRequired(
            new ApiError(f.code, f.message || '请先制定工序链'),
            partId,
            router,
          );
        }
        const otherFailed = res.failed.filter((f) => f.code !== BIZ_PROCESS_CHAIN_REQUIRED);
        if (otherFailed.length > 0) {
          ElMessage.error(`${otherFailed.length} 件下发失败`);
        }
      }
    },
    onError: async (e: Error, { batchIds }) => {
      const handled = await maybeHandleChainRequired(e, batchIds);
      if (!handled) ElMessage.error(e.message ?? '自动下发失败');
    },
  });

  return {
    batches,
    total,
    isLoading,
    selectedIds,
    selectedCount,
    setSelectedIds,
    clearSelection,
    dispatchMutation,
    bulkDispatchMutation,
    autoDispatchMutation,
  };
}