// src/composables/queries/usePendingBatchesQuery.ts
//
// 2026-09-29 新增：待下发批次共享 query（生产队列「待下发」Tab 共享基础数据层）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + reactive params（MaybeRefOrGetter<ListPendingBatchesParams>）；
//   - queryKey 走 computed(toValue(params)) → params 变化自动 refetch；
//   - queryFn 从 queryKey[2] 读最新 params（避免闭包捕获 stale —— 与 useProcessesQuery
//     / usePartsListQuery 同源范本）；
//   - queryFn 走 pendingBatchListResultSchema.parse 守门（M-1 regression guard：缺字段
//     静默 strip = 校验形同虚设）；
//   - staleTime / gcTime: POSITIVE_INFINITY —— 会话级缓存；写操作（dispatch / bulk /
//     auto）在 usePendingDispatch.ts 集中失效 pendingBatchesPrefix + 跨域
//     partsPrefix（2026-09-30 修复：去掉 processesPrefix —— 下发批次不改变工序列表）；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 写点：pending-batches 域写操作（dispatchBatch / bulkDispatchBatches /
// autoDispatchBatches）全仓仅 usePendingDispatch.ts 一处（2026-09-29 grep 确认；
// 后续如新增写点必须挂 invalidatePendingBatchesQuery(qc) 同步失效）。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { fetchPendingBatches, type ListPendingBatchesParams } from '@/api/pendingBatches';
import { pendingBatchListResultSchema, type PendingBatchListResultSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-09-29 新增：待下发批次共享 query。
 *
 * 用法：
 *   ```ts
 *   const paramsRef = ref<ListPendingBatchesParams>({ limit: 200 });
 *   const q = usePendingBatchesQuery(paramsRef);
 *   const items = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * 参数：
 *   - params：MaybeRefOrGetter<ListPendingBatchesParams>，默认 { limit: 200 }。
 *     显式传 undefined / 空 → queryKey 第二项为 {}（与其他 query 工厂同源语义）。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<PendingBatchListResultSchema, Error>。
 */
export function usePendingBatchesQuery(
  params?: MaybeRefOrGetter<ListPendingBatchesParams>,
) {
  // 2026-09-29：queryKey 走 computed(toValue(params) ?? {})，params 可以是 Ref /
  // ComputedRef / getter；queryFn 从 queryKey[2] 读最新 params（不 snapshot），保证
  // reactive params 变化时 fetchPendingBatches 拿到的是新值（沿 useProcessesQuery /
  // usePartsListQuery 范本 #5）。
  const paramsKey = computed(() => qk.pendingBatchesList(toValue(params) ?? {}));
  return useQuery<PendingBatchListResultSchema, Error>({
    queryKey: paramsKey,
    queryFn: async ({ queryKey }) => {
      const raw = queryKey[2];
      const p: ListPendingBatchesParams =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as ListPendingBatchesParams)
          : {};
      return pendingBatchListResultSchema.parse(await fetchPendingBatches(p));
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-29 新增：失效整个 pending-batches 域（写操作完成后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidatePendingBatchesQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.pendingBatchesPrefix }).then(() => undefined);
}