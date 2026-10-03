// src/composables/queries/useOutsourcePoolCountsQuery.ts
//
// 2026-10-03 新增：外协看板各工序「可发送 / 在途」计数共享 query（tab 标题徽标的
// **唯一数据源**）。形态照抄 pool 域的 useWorkerPoolCountsQuery。
//
// 设计要点（沿 CLAUDE.md「TanStack Query 数据获取架构」约定）：
//   - useQuery + **常量 queryKey**（无 params 维度：后端 `GET /outsource-pool/counts`
//     不接 Query extractor，键不随 tab / 选中态变化）；
//   - queryFn 走 outsourcePoolCountsResultSchema.parse 守门（Zod 默认 strip 模式下
//     漏声明字段会被静默丢弃、parse 照过不误 ⇒ 逐字段显式声明，见 schemas.ts 同段
//     注释与 `__tests__/schemas.spec.ts` 的 outsource-pool 段）；
//   - 守门在 api 边界与 queryFn **各一次**：api 层那一次是沿本文件既有 outsource helper
//     做法在边界挡漂移（parse 结果再 `as` 成 TS 类型），queryFn 那一次是 CLAUDE.md §4
//     「共享 useQuery 的 queryFn 必须 xxxListResultSchema.parse(await xxxAPI())」的硬要求
//     （worker-pool 三个 query 同款）。`listOutsourcePoolCounts` 目前只被本 query 消费，
//     故两次 parse 在运行路径上重叠；api 层保留是为了与本文件另外 4 个 list helper 同形。
//   - 无 enabled 闸门：本 query 无入参，恒可发请求（闸门是「参数缺失时不发」的场景专用；
//     页面级「等路由守卫 + 恢复完再开闸」的 restore 模式不在本层，见 CLAUDE.md §6）；
//   - staleTime / gcTime: 30_000 / 5 * 60 * 1000 —— 短时请求去重层（CLAUDE.md
//     「缓存时长策略」：共享基础数据层一律有限值，不用 POSITIVE_INFINITY 会话级缓存）。
//     收发是秒级操作、用户会反复切 tab 看徽标，30s 窗口足以去重同时保证超窗自动
//     refetch（收发完成后徽标数字不会停在旧值）；
//   - 不写 retry：信任 src/main.ts 全局 queries.retry: 0。
//
// 失效编排点（待落地）：invalidateOutsourcePoolCountsQuery(qc) 由看板侧的外协收发
// mutation（useOutsourceBoardMove，并行任务，本仓尚无调用方）onSuccess 调。
// ⚠️ **编排点 ≠ 全部写点**：本域计数反映的是「可发送候选 + 在途持有」两个集合的
// 并集，除看板自身的收发外没有其它写端点能改它们；但按 CLAUDE.md「跨页面写操作不做
// 穷举失效」策略，这里只保证「写完立即看到自己那笔」，新鲜度仍以 30s 有限 staleTime
// 为准。

import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { listOutsourcePoolCounts } from '@/api/outsource';
import { outsourcePoolCountsResultSchema, type OutsourcePoolCountsResultSchema } from './schemas';
import { qk } from './keys';

/**
 * 2026-10-03 新增：外协看板各工序「可发送 / 在途」计数共享 query。
 *
 * 用法：
 *   ```ts
 *   const q = useOutsourcePoolCountsQuery();
 *   const sendableOf = (pid: string) =>
 *     q.data.value?.counts.find((c) => c.process_id === pid)?.sendable_count ?? 0;
 *   ```
 *
 * 无参数：`counts[]` 已按 process_id 升序且只含有货工序（sendable + in_flight > 0），
 * 徽标直接遍历消费即可。
 *
 * 返回：标准 TanStack Vue Query UseQueryReturnType<OutsourcePoolCountsResultSchema, Error>。
 */
export function useOutsourcePoolCountsQuery() {
  // 常量 queryKey（无 params 维度 —— 后端端点不接 Query extractor）
  return useQuery<OutsourcePoolCountsResultSchema, Error>({
    queryKey: qk.outsourcePoolCounts,
    queryFn: async () => outsourcePoolCountsResultSchema.parse(await listOutsourcePoolCounts()),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });
}

/** 2026-10-03 新增：失效 outsource-pool counts（外协发送/接收完成后调）。
 *  返回 Promise<void> 让 caller 可以 await 失效完成再走后续逻辑。
 *  调用方：看板侧 useOutsourceBoardMove（并行任务，待落地）的收发 mutation onSuccess。 */
export function invalidateOutsourcePoolCountsQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.outsourcePoolCountsPrefix }).then(() => undefined);
}
