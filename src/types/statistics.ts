// 生产统计 api 入参类型。
//
// ⚠️ **本文件只有入参，没有出参镜像**（2026-10-12）：三个端点的出参 wire 契约的
// **唯一真源**是 `src/views/statistics/composables/statisticsSchema.ts` 的
// `overviewOutSchema` / `workerStatsListOutSchema` / `workerDetailOutSchema`，
// 消费侧一律用 `z.infer` 派生的 `*Data` 类型（api 层 `import type` 标注返回类型、
// 组件与 composable 直接 import 域内路径）。这里再抄一份手写 interface 就是同一份
// wire 契约的**第二个真源**：schema 加字段时它不会报错，只会静默腐烂 —— 而 Zod 是
// strip 模式，后端发的字段到不了任何视图那种问题，正是这类镜像掩盖掉的。
//
// ⚠️ 要给 statistics 加出参类型时，去 `statisticsSchema.ts` 加字段，不要在这里加
// interface。

/** GET /statistics/* 的日期范围参数。date_from / date_to 必填，'YYYY-MM-DD'。 */
export interface StatisticsQuery {
  date_from: string;
  date_to: string;
}
