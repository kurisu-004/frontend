// src/composables/queries/useWorkerPoolCountsQuery.ts
//
// 2026-09-30 新增：worker-pool 全工序 batch 计数共享 query（生产队列页 Tab 标题
// (N) 徽标数据源 + PendingPoolCard 单击/拖拽场景的「该工序候选数」展示）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + reactive params（MaybeRefOrGetter<{ shelf_id?: string | null }>）；
//   - queryKey 走 computed(toValue(params) ?? null) → params 变化触发 refetch；
//   - queryFn 从 queryKey[2] 读最新 params（避免闭包捕获 stale —— 与 useProcessesQuery
//     / usePendingBatchesQuery 同源范本 #5）；
//   - queryFn 走 workerPoolCountsSchema.parse 守门（M-1 regression guard：缺字段
//     静默 strip = 校验形同虚设）；
//   - staleTime / gcTime: POSITIVE_INFINITY —— 会话级缓存；写操作（assignWorkerPool /
//     removeFromWorkerPool / autoAllocate）在 useWorkerQueue.ts 集中失效
//     workerPoolCountsPrefix + 跨域 workerPoolByProcessPrefix；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 写点：worker-pool 域写操作全仓仅 useWorkerQueue.ts 一处（2026-09-30 grep 确认；
// 后续如新增写点必须挂 invalidateWorkerPoolCountsQuery(qc) 同步失效）。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { getWorkerPoolCounts } from '@/api/workerPool';
import {
  workerPoolCountsSchema,
  type WorkerPoolCountsSchema,
} from './schemas';
import { qk } from './keys';

/**
 * 2026-09-30 新增：worker-pool 全工序 batch 计数共享 query。
 *
 * 用法：
 *   ```ts
 *   const shelfIdRef = computed(() => auth.activeShelfId ?? null);
 *   const q = useWorkerPoolCountsQuery(() => ({ shelf_id: shelfIdRef.value }));
 *   const items = computed(() => q.data.value?.counts ?? []);
 *   ```
 *
 * 参数：
 *   - params：MaybeRefOrGetter<{ shelf_id?: string | null }>。shelf_id 可选；
 *     传 null / undefined / 空 → 不发 shelf_id query，service 端聚合全货架。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkerPoolCountsSchema, Error>。
 */
export function useWorkerPoolCountsQuery(
  params?: MaybeRefOrGetter<{ shelf_id?: string | null }>,
) {
  // 2026-09-30：queryKey 走 computed(toValue(params) ?? null)，params 可以是 Ref /
  // ComputedRef / getter；queryFn 从 queryKey[2] 读最新 params（不 snapshot），
  // 保证 reactive params 变化时 getWorkerPoolCounts 拿到的是新值（沿 useProcessesQuery
  // 范本 #5）。
  const paramsKey = computed(() => qk.workerPoolCounts(toValue(params) ?? undefined));
  return useQuery<WorkerPoolCountsSchema, Error>({
    queryKey: paramsKey,
    queryFn: async ({ queryKey }) => {
      const raw = queryKey[2];
      const p: { shelf_id?: string | null } | undefined =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as { shelf_id?: string | null })
          : undefined;
      return workerPoolCountsSchema.parse(await getWorkerPoolCounts(p));
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-30 新增：失效整个 worker-pool counts 域（写操作完成后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。 */
export function invalidateWorkerPoolCountsQuery(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolCountsPrefix })
    .then(() => undefined);
}

/** 2026-09-30 新增：失效整个 worker-pool counts 域（同 invalidateWorkerPoolCountsQuery
 *  alias —— 仓内写点多了之后保留命名空间清晰度）。
 *  当前调用点：usePendingDispatch.refreshBoard 跨域失效链（dispatch / bulk / auto
 *  后 batch 离开待下发池，进入 worker-pool counts 计数 —— counts 必须 invalidate）。 */
export function invalidateWorkerPoolCountsAll(qc: QueryClient): Promise<void> {
  return invalidateWorkerPoolCountsQuery(qc);
}