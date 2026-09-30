// src/composables/queries/useWorkerStateByWorkerQuery.ts
//
// 2026-09-30 新增：单 worker state 共享 query（WorkerColumn 自管 workerHeld +
// max_held + current_held 等数据；跨 tab 共享 cache identity）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + 双 reactive params（workerId + shelfId）；
//   - queryKey 走 computed(toValue(workerId) ?? '', toValue(shelfId) ?? '') →
//     任一变化触发 refetch；
//   - queryFn 从 queryKey[2..3] 读最新 workerId + shelfId（避免闭包捕获 stale）；
//   - queryFn 走 workerStateSchema.parse 守门（M-1 regression guard）；
//   - enabled: computed(() => !!(toValue(workerId) && toValue(shelfId))) ——
//     双参数都必填（rust WorkerPoolState 端点必填 shelf_id）；
//   - queryFn 内有 workerId + shelfId 二次守卫；
//   - staleTime / gcTime: POSITIVE_INFINITY —— 会话级缓存；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 写点：worker-pool state 域写操作全仓仅 useWorkerQueue.ts 一处（assign +
// remove 两类 mutation onSuccess 调 invalidateWorkerStateByWorkerQuery(qc, wid, sid)）。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { getWorkerState } from '@/api/workerPool';
import { workerStateSchema, type WorkerStateSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-09-30 新增：单 worker state 共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useWorkerStateByWorkerQuery(
 *     () => props.worker.id,
 *     () => auth.activeShelfId,
 *   );
 *   const held = computed(() => q.data.value?.held_batches ?? []);
 *   ```
 *
 * 参数：
 *   - workerId：MaybeRefOrGetter<string | null | undefined>；
 *   - shelfId：MaybeRefOrGetter<string | null | undefined>（rust WorkerPoolState
 *     端点必填 shelf_id —— 空 → enabled=false，零网络请求）。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkerStateSchema, Error>。
 */
export function useWorkerStateByWorkerQuery(
  workerId: MaybeRefOrGetter<string | null | undefined>,
  shelfId: MaybeRefOrGetter<string | null | undefined>,
) {
  // 2026-09-30：queryKey 走 computed(toValue(workerId) ?? '', toValue(shelfId) ?? '')，
  // 双 reactive 参数都可独立触发 refetch；queryFn 从 queryKey[2..3] 读最新值（沿
  // useProcessesQuery 范本 #5 扩展为双参数）。
  const stateKey = computed(() =>
    qk.workerPoolStateByWorker(
      toValue(workerId) ?? '',
      toValue(shelfId) ?? '',
    ),
  );
  return useQuery<WorkerStateSchema, Error>({
    queryKey: stateKey,
    queryFn: async ({ queryKey }) => {
      const wid = queryKey[2];
      const sid = queryKey[3];
      // 2026-09-30：enabled=false 已挡，但留二次守卫防 queryFn 被显式调 refetch 时
      // 仍走 ?worker_id=&shelf_id= 请求（避免后端 40001 BIZ_SHELF_NOT_FOUND）。
      if (!wid || !sid) throw new Error('worker_id + shelf_id required');
      return workerStateSchema.parse(await getWorkerState({ worker_id: String(wid), shelf_id: String(sid) }));
    },
    // 2026-09-30：workerId + shelfId 双参数都必填才发请求（沿 usePartFilesListQuery
    // 范本 #6 扩展为双参数 enabled 闸门）。
    enabled: computed(() => !!(toValue(workerId) && toValue(shelfId))),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-30 新增：失效指定 workerId + shelfId 的 worker-state 缓存。
 *  调用方：useWorkerQueue.assignWorkerPoolMutation / removeFromWorkerPoolMutation
 *  的 onSuccess（assign / remove 后该 worker 的 held_batches / current_held 必变）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidateWorkerStateByWorkerQuery(
  qc: QueryClient,
  workerId: string,
  shelfId: string,
): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolStateByWorker(workerId, shelfId) })
    .then(() => undefined);
}

/** 2026-09-30 新增：失效整个 worker-pool state 域（任意 workerId + shelfId 形态）。
 *  留作未来跨 worker 写操作（如 batch 全员撤回）场景的兜底；
 *  当前调用点：usePendingDispatch.refreshBoard 跨域失效链（dispatch / bulk / auto
 *  后多 worker held_batches / current_held 可能变化，前缀失效最安全）。 */
export function invalidateWorkerStateByWorkerAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolStatePrefix })
    .then(() => undefined);
}
