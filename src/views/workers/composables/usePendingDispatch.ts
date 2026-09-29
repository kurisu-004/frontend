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
import {
  autoDispatchBatches,
  bulkDispatchBatches,
  dispatchBatch,
  type AutoDispatchResultDto,
  type BulkDispatchResultDto,
  type DispatchBatchRequest,
  type DispatchBatchResultDto,
} from '@/api/pendingBatches';
import type { PendingBatchItemDto } from '@/api/workerPool.contract';
import { invalidatePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import { invalidateProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { qk } from '@/composables/queries/keys';
import { usePendingBatchesQuery } from '@/composables/queries/usePendingBatchesQuery';
import type { ListPendingBatchesParams } from '@/api/pendingBatches';

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
  /** 批量下发 mutation（mutation.isPending / mutate） */
  bulkDispatchMutation: ReturnType<
    typeof useMutation<
      BulkDispatchResultDto,
      Error,
      { batchIds: string[]; shelfId: string; nextProcessId: string }
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
 *   const dispatch = usePendingDispatch();
 *   dispatch.dispatchMutation.mutate({ batchId, req: {} });
 *   dispatch.bulkDispatchMutation.mutate({ batchIds, shelfId, nextProcessId });
 *   dispatch.autoDispatchMutation.mutate({ batchIds: [...dispatch.selectedIds.value] });
 *   ```
 */
export function usePendingDispatch(): UsePendingDispatchReturn {
  const qc = useQueryClient();

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

  /** 2026-09-29：写操作完成后调，集中失效三域（pending-batches / processes / parts）。
   *  返回 Promise 让 3 个 mutation onSuccess 内部 await 完整失效链，避免 query 重叠
   *  触发雪崩。 */
  async function invalidateAll(): Promise<void> {
    await invalidatePendingBatchesQuery(qc);
    await invalidateProcessesQuery(qc);
    await qc.invalidateQueries({ queryKey: qk.partsPrefix }).then(() => undefined);
  }

  // ===== mutation 范本（沿 2026-09-26 CLAUDE.md #8）=====

  /** 单件下发 —— mutationKey 三层数组；不写 retry（信任全局默认）。 */
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
    onError: (e: Error) => ElMessage.error(e.message ?? '下发失败'),
  });

  /** 批量下发 —— 共享 shelfId + nextProcessId。 */
  const bulkDispatchMutation = useMutation<
    BulkDispatchResultDto,
    Error,
    { batchIds: string[]; shelfId: string; nextProcessId: string }
  >({
    mutationKey: ['pending-batches', 'dispatch-bulk'],
    mutationFn: ({ batchIds, shelfId, nextProcessId }) =>
      bulkDispatchBatches({ batch_ids: batchIds, shelf_id: shelfId, next_process_id: nextProcessId }),
    onSuccess: async (res) => {
      await invalidateAll();
      // 成功后清空多选（沿 usePartDispatch.batchDispatchMutation 行为）
      clearSelection();
      const ok = res.succeeded.length;
      const failed = res.failed.length;
      if (ok > 0) ElMessage.success(`已批量下发 ${ok} 件`);
      if (failed > 0) {
        const sample = res.failed
          .slice(0, 3)
          .map((f) => `${f.batch_id}(${f.code})`)
          .join('；');
        ElMessage.error(`失败 ${failed} 件：${sample}${failed > 3 ? '...' : ''}`);
      }
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '批量下发失败'),
  });

  /** 自动下发 —— service 端按 process_chain_id 推导 first_step + shelf；无链的 batch
   * 跳过并返回 failed 条目（前端不阻断其他件）。 */
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
        // 20706 BIZ_PROCESS_CHAIN_REQUIRED → 提示用户先制定工艺链
        const chainRequired = res.failed.filter((f) => f.code === 20706);
        if (chainRequired.length > 0) {
          ElMessage.warning(`${chainRequired.length} 件无工艺链，请先制定工艺链`);
        }
        if (failed - chainRequired.length > 0) {
          ElMessage.error(`${failed - chainRequired.length} 件下发失败`);
        }
      }
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '自动下发失败'),
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