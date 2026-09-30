// src/composables/queries/useWorkerPoolByProcessQuery.ts
//
// 2026-09-30 新增：单工序候选池详情共享 query（生产队列页 tab body **懒加载**
// 唯一数据源 —— 切到该 tab 才发请求）。
//
// 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛）：URL
// `/prod/worker-pool/{process_id}` → `/prod/pool/{process_id}`；
// `poolBatchItemSchema` 删 `current_process_step_id`（后端 `PoolBatchItem` 无此
// 字段，此前 schema 声明它导致 parse 永远失败）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + reactive params（MaybeRefOrGetter<string | null | undefined>）；
//   - queryKey 走 computed(toValue(processId) ?? '') → processId 变化触发 refetch；
//   - queryFn 从 queryKey[2] 读最新 processId（避免闭包捕获 stale —— 与 useProcessesQuery
//     / useWorkerPoolCountsQuery 同源范本 #5）；
//   - queryFn 走 workerPoolByProcessSchema.parse 守门（M-1 regression guard）；
//   - enabled: computed(() => !!toValue(processId)) —— 无 processId 时不发请求；
//   - queryFn 内有 processId 二次守卫（enabled 已挡，但留 refetch / call 路径防御）；
//   - staleTime / gcTime: POSITIVE_INFINITY —— 会话级缓存；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 2026-09-30 消费侧收敛：**唯一 consumer 是 WorkerPoolTab**（el-tab-pane
// `:lazy="true"` ⇒ 首次激活才 mount 才发请求）。此前 PendingPoolCard 也消费
// 本 query，导致「待下发」首屏（默认激活 tab）为每张 INHOUSE 工序卡各打一个
// 请求（N+1），而它其实只需要一个聚合计数 badge（现已改走 useWorkerPoolCountsQuery）。
//
// 写点：pool 域写操作全仓仅 useWorkerQueue.ts（move / autoAllocate）与
// usePendingDispatch.ts（dispatch）两处，onSuccess 均调
// invalidateWorkerPoolByProcessAll(qc) 前缀全失效（move 后无法确定受影响
// processId —— service 从 batch 当前 step 推导目标工序）。

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
      // 仍走 /prod/pool/ 请求（避免后端 404 / 422）。
      if (!pid) throw new Error('processId required');
      return workerPoolByProcessSchema.parse(await getWorkerPoolByProcess(String(pid)));
    },
    // 2026-09-30：processId 空 → 不发请求（沿 usePartFilesListQuery 范本 #6）。
    enabled: computed(() => !!toValue(processId)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-30：失效整个 pool by-process 域（任意 processId 形态）。
 *  **前缀全失效是唯一正确策略** —— `POST /prod/pool/move` 的目标工序由 service 从
 *  `batch.current_process_step.process_id` 推导（前端不再传 process_id），故调用
 *  onSuccess 时无法确定受影响 processId；且一个 dispatch 可能一次改多个工序池。
 *  调用方：useWorkerQueue 的 move / autoAllocate mutation onSuccess +
 *  usePendingDispatch.invalidateAll（dispatch 后 batch 进入候选池）。 */
export function invalidateWorkerPoolByProcessAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolByProcessPrefix })
    .then(() => undefined);
}
