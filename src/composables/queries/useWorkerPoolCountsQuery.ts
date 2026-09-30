// src/composables/queries/useWorkerPoolCountsQuery.ts
//
// 2026-09-30 新增：pool 域全工序 batch 计数共享 query（生产队列页 Tab 标题 (N)
// 徽标 + 「待下发」Tab 工序卡 badge 的**唯一数据源**）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #3/#4/#5）：
//   - useQuery + **常量 queryKey**（无 params 维度）；
//   - queryFn 走 workerPoolCountsSchema.parse 守门（M-1 regression guard：
//     缺字段静默 strip = 校验形同虚设）；
//   - staleTime / gcTime: POSITIVE_INFINITY —— 会话级缓存；
//   - 写操作（moveBatch / autoAllocate / dispatch 系列）在 useWorkerQueue.ts +
//     usePendingDispatch.ts 集中失效 workerPoolCountsPrefix；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛）：
//   - URL `/prod/worker-pool/counts` → `/prod/pool/counts`；
//   - **删 params 形参**：后端 `pool_counts` handler（worker_pool/handler.rs:146-153）
//     只有 `State` + `CurrentUser`，不接 Query extractor；`WorkerPoolCountsOut`
//     （worker_pool/dto.rs）也只有 `counts` + `total`，无 shelf_id 维度。此前前端
//     传 `shelf_id` 是死参，schema 还把它声明成必填 nullable ⇒ parse 永远失败。
//   - queryKey 由 `computed(() => qk.workerPoolCounts(params))` 退化为常量
//     `qk.workerPoolCounts`（不再随 activeShelfId 变化 refetch）—— 顺带消除了
//     WorkerQueueBoard.vue 里 shelfId 必须在 useWorkerPoolCountsQuery 之前声明的
//     TDZ 约束。
//
// 写点：pool 域写操作全仓仅 useWorkerQueue.ts + usePendingDispatch.ts 两处
// （2026-09-30 grep 确认）；后续如新增写点必须挂 invalidateWorkerPoolCountsQuery(qc)。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { getWorkerPoolCounts } from '@/api/workerPool';
import {
  workerPoolCountsSchema,
  type WorkerPoolCountsSchema,
} from './schemas';
import { qk } from './keys';

/**
 * 2026-09-30 新增：pool 域全工序 batch 计数共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useWorkerPoolCountsQuery();
 *   const countOf = (pid: string) => q.data.value?.counts.find(c => c.process_id === pid)?.count ?? 0;
 *   ```
 *
 * 无参数：后端按 process_id GROUP BY **跨所有货架**聚合（admin 视角），无 shelf
 * 维度可切。前端两处消费（均在 WorkerQueueBoard 内派生，不重复发请求）：
 *   1. `el-tab-pane` 的 `#label` 徽标 `{{ poolCount(p.id) }}`；
 *   2. `PendingPoolCard` 的 `count` prop（「待下发」Tab 工序卡右上角 el-tag）——
 *      2026-09-30 前该卡是自己发 `GET /prod/pool/{pid}` 拿 items.length，导致进页面
 *      即打出 N 个请求（每张 INHOUSE 工序卡一个）；改走本聚合 query 后进页面请求数
 *      恒为 3（processes + pool/counts + batches/pending），per-process 详情只在
 *      对应 tab 激活时才拉。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkerPoolCountsSchema, Error>。
 */
export function useWorkerPoolCountsQuery() {
  // 常量 queryKey（无 params 维度 —— 见文件头 2026-09-30 说明）
  return useQuery<WorkerPoolCountsSchema, Error>({
    queryKey: qk.workerPoolCounts,
    queryFn: async () => workerPoolCountsSchema.parse(await getWorkerPoolCounts()),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** 2026-09-30 新增：失效整个 pool counts 域（写操作完成后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。
 *  调用点：usePendingDispatch.invalidateAll + useWorkerQueue 的 move / autoAllocate
 *  mutation onSuccess + WorkerQueueBoard.onRefresh（覆盖全仓写点）。 */
export function invalidateWorkerPoolCountsQuery(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolCountsPrefix })
    .then(() => undefined);
}
