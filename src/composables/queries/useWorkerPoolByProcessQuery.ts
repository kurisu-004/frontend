// src/composables/queries/useWorkerPoolByProcessQuery.ts
//
// 2026-09-30 新增：单工序 worker-pool 详情共享 query（生产队列页 tab body 懒加载 +
// PendingPoolCard 单击 / 拖拽场景的候选 batch 列表数据源）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + reactive params（MaybeRefOrGetter<string | null | undefined>）；
//   - queryKey 走 computed(toValue(processId) ?? '') → processId 变化触发 refetch；
//   - queryFn 从 queryKey[2] 读最新 processId（避免闭包捕获 stale —— 与 useProcessesQuery
//     / usePendingBatchesQuery / useWorkerPoolCountsQuery 同源范本 #5）；
//   - queryFn 走 workerPoolByProcessSchema.parse 守门（M-1 regression guard）；
//   - enabled: computed(() => !!toValue(processId)) —— 无 processId 时不发请求；
//   - queryFn 内有 processId 二次守卫（enabled 已挡，但留 refetch / call 路径防御）；
//   - staleTime / gcTime: POSITIVE_INFINITY —— 会话级缓存；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 写点：worker-pool by-process 域写操作全仓仅 useWorkerQueue.ts 一处（assign +
// remove + auto allocate 三类 mutation onSuccess 调 invalidateWorkerPoolByProcessQuery(qc, processId)）。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { getWorkerPoolByProcess } from '@/api/workerPool';
import {
  workerPoolByProcessSchema,
  type WorkerPoolByProcessSchema,
} from './schemas';
import { qk } from './keys';

/**
 * 2026-09-30 新增：单工序 worker-pool 详情共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useWorkerPoolByProcessQuery(() => props.processId);
 *   const batches = computed(() => q.data.value?.items ?? []);
 *   ```
 *
 * 参数：
 *   - processId：MaybeRefOrGetter<string | null | undefined>。null/undefined/空
 *     字符串 → enabled=false，零网络请求。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkerPoolByProcessSchema, Error>。
 */
export function useWorkerPoolByProcessQuery(
  processId: MaybeRefOrGetter<string | null | undefined>,
) {
  // 2026-09-30：queryKey 走 computed(toValue(processId) ?? '')，processId 可以是
  // Ref / ComputedRef / getter；queryFn 从 queryKey[2] 读最新 processId（不 snapshot），
  // 保证 reactive 变化时 getWorkerPoolByProcess 拿到的是新值（沿 useProcessesQuery
  // 范本 #5）。
  const processKey = computed(() => qk.workerPoolByProcess(toValue(processId) ?? ''));
  return useQuery<WorkerPoolByProcessSchema, Error>({
    queryKey: processKey,
    queryFn: async ({ queryKey }) => {
      const pid = queryKey[2];
      // 2026-09-30：enabled=false 已挡，但留二次守卫防 queryFn 被显式调 refetch 时
      // 仍走 /prod/worker-pool/ 请求（避免后端 422）。
      if (!pid) throw new Error('processId required');
      return workerPoolByProcessSchema.parse(await getWorkerPoolByProcess(String(pid)));
    },
    // 2026-09-30：processId 空 → 不发请求（沿 usePartFilesListQuery 范本 #6）。
    enabled: computed(() => !!toValue(processId)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-30 新增：失效指定 processId 的 worker-pool by-process 缓存。
 *  调用方：useWorkerQueue.assignWorkerPoolMutation / removeFromWorkerPoolMutation /
 *  autoAllocateMutation 的 onSuccess（assign / remove 后该 processId 的 items
 *  列表必变；auto allocate 跨多 worker 但 items 同样变化，故也失效）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidateWorkerPoolByProcessQuery(
  qc: QueryClient,
  processId: string,
): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolByProcess(processId) })
    .then(() => undefined);
}

/** 2026-09-30 新增：失效整个 worker-pool by-process 域（任意 processId 形态）。
 *  调用方：usePendingDispatch.refreshBoard 跨域失效链（dispatch / bulk / auto
 *  后 batch 进入 worker-pool —— 任意 processId 形态的 items 都可能受影响，
 *  前缀失效最安全）。 */
export function invalidateWorkerPoolByProcessAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolByProcessPrefix })
    .then(() => undefined);
}