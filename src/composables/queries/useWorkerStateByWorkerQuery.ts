// src/composables/queries/useWorkerStateByWorkerQuery.ts
//
// 2026-10-04 修复「工人持有列表恒空」：**去掉 shelfId 维度**（根因与取舍见下）。
//   ① 根因：shelfId 原本接在 `auth.activeShelfId` 上，而后端只给
//      SHELF_ACCOUNT + scope_type='shelf' 的角色行返 shelf_ids —— 本页目标角色
//      MANAGER / CLERK / INSPECTOR 的 shelf_ids 恒为 `[]` ⇒ activeShelfId 恒 null
//      ⇒ shelfId 恒 `''` ⇒ `enabled` 恒 false ⇒ **请求从不发出**；页面稳定显示
//      「暂无持有工单」+ 0/0，且 `invalidateQueries` 默认 refetchType: 'active'
//      遇 disabled query 也不刷 ⇒ 静默假空 + 写操作后也不更新。
//   ② 后端已把 `GET /api/v2/prod/pool/state` 的 `shelf_id` 降为可选：该参数
//      **只被用于填 `pool_count_by_process`**，而 held_batches / max_held /
//      current_held / capacity_remaining 全都与货架无关（后端 held 查询签名里
//      就没有货架参数），且 `pool_count_by_process` 前端一个视图都没消费
//      （只在 contract / zod schema / spec 里出现）。shelf_id 缺省时后端返空数组。
//   ③ 顺带消除 queryKey 按架切缓存的副作用：此前同一 worker 在不同货架下会被
//      切成不同 cache identity，同一 worker 重复缓存 / 重复请求。
//
// 2026-09-30 契约漂移修复（后端 worker-pool → pool 收敛）：
//   - URL `/prod/worker-pool/state` → `/prod/pool/state`；
//   - `workerStateSchema.work_type_code` 由 `.nullable()` 收紧为 `z.string()` ——
//     后端 `WorkerPoolState.work_type_code` 是非 Option `String`，无工种时为空串。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层约定 #5/#6/#7）：
//   - useQuery + 单 reactive param（workerId）；
//   - queryKey 走 computed(toValue(workerId) ?? '')；
//   - queryFn 从 queryKey[2] 读最新 workerId（避免闭包捕获 stale）；
//   - queryFn 走 workerStateSchema.parse 守门（M-1 regression guard）；
//   - enabled: computed(() => !!toValue(workerId)) —— workerId 缺失不发请求；
//   - queryFn 内有 workerId 二次守卫（防显式 refetch 绕过闸门时发空参请求）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 短时请求去重层（2026-09-30 起
//     不再用 POSITIVE_INFINITY 会话级缓存，理由见 CLAUDE.md「TanStack Query 缓存时长
//     策略」）：同一 workerId 在 30s 内跨 tab 切换命中缓存不重拉；超 30s
//     切回自动 refetch，工人送检 / 放回后切回队列页能拿到最新 held 集合；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//
// 2026-09-30：本 query 是 worker 持有数据的**唯一数据源** —— useWorkerQueue 的
// 模块级 `workerHeld` ref + `loadBoard`（循环裸调 getWorkerState，违反
// CLAUDE.md 2026-09-30 TanStack 硬约束）已删除，本文件随之成为 held 数据的
// 单一路径。失效编排点：`POST /prod/pool/move`（useWorkerQueue.ts onSuccess 的
// invalidatePoolDomains）+ dispatch（usePendingDispatch.invalidateAll）都调
// `invalidateWorkerStateByWorkerAll(qc)`（POOL↔WORKER 双向移动都会改变
// held_batches / current_held，故前缀全刷而非按 worker 精刷）。
// ⚠️ 2026-09-30：上面两处只是**编排点**，不是 held_batches 的全部写点 —— scan 域
// 工人放回（`workerScan` service）同事务跑 WorkerPool refill，会改 held 集合却不挂
// 本前缀失效 —— 既存缺口。
// 2026-09-30 策略变更：既然无法穷举全仓写点，本 query 已把 staleTime / gcTime 改为
// 有限值（30s / 5min，见上）—— 新鲜度不再依赖「失效编排点覆盖全部写点」这个假设。
// 上面的编排点清单是**已显式挂失效的写点**（写完立即看到自己那笔的优化），**不是**
// 全部写点。

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
 *   const q = useWorkerStateByWorkerQuery(() => props.worker.id);
 *   const held = computed(() => q.data.value?.held_batches ?? []);
 *   ```
 *
 * 参数：
 *   - workerId：MaybeRefOrGetter<string | null | undefined>；空 → enabled=false，
 *     零网络请求。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<WorkerStateSchema, Error>。
 */
export function useWorkerStateByWorkerQuery(
  workerId: MaybeRefOrGetter<string | null | undefined>,
) {
  // 2026-10-04：queryKey 走 computed(toValue(workerId) ?? '')，queryFn 从
  // queryKey[2] 读最新值（沿 useProcessesQuery 范本）。
  const stateKey = computed(() => qk.workerPoolStateByWorker(toValue(workerId) ?? ''));
  return useQuery<WorkerStateSchema, Error>({
    queryKey: stateKey,
    queryFn: async ({ queryKey }) => {
      const wid = queryKey[2];
      // 2026-10-04：enabled=false 已挡，但留二次守卫防 queryFn 被显式调 refetch 时
      // 仍走 ?worker_id= 空参请求。
      if (!wid) throw new Error('worker_id required');
      return workerStateSchema.parse(await getWorkerState({ worker_id: String(wid) }));
    },
    // 2026-10-04：enabled 只看 workerId —— shelf 维度已从键与请求中移除，
    // MANAGER / CLERK / INSPECTOR 不再因 activeShelfId 为空而永远发不出请求。
    enabled: computed(() => !!toValue(workerId)),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-09-30：失效整个 pool state 域（任意 workerId 形态）。
 *  **前缀全失效是唯一正确策略** —— `POST /prod/pool/move` 的 `to.kind` 由调用方
 *  任意 worker 决定（一次 auto-allocate 可同时改多个 worker 的 held_batches），
 *  且 POOL→WORKER / WORKER→POOL 两个方向都会改动持有集合，无法精刷。
 *  调用方：useWorkerQueue 的 move / autoAllocate mutation onSuccess。 */
export function invalidateWorkerStateByWorkerAll(qc: QueryClient): Promise<void> {
  return qc
    .invalidateQueries({ queryKey: qk.workerPoolStatePrefix })
    .then(() => undefined);
}
