// 后端生产统计 API（走 @/api/http 统一 axios 客户端）。
//
// 后端约束：
// - MANAGER-only（后端 statistics 域 handler 层逐端点 require_role(Role::Manager)）；
// - 入参 date_from / date_to 必填 'YYYY-MM-DD'；其他字段无；
// - 出参 wire 契约见 `src/views/statistics/composables/statisticsSchema.ts`
//   （域内 Zod 守门 schema，与三个 query hook 同居）。
//
// 本文件**只发请求 + 用 schema 的 `*Data` 派生类型标注返回类型，不做 Zod 校验**：
// 守门点在 query hook 的 queryFn（`views/statistics/composables/`），Zod 的校验入口
// 返回深拷贝，在 api 层再走一遍等于每屏数据被校验并克隆两遍。
//
// 三个端点对应三个 tab：
// - fetchOverview            → tab1 基础统计 + 图表
// - fetchWorkerStats         → tab2 工人贡献度列表
// - fetchWorkerDetail        → tab3 单工人详情（pickup / return / 参与工单 / 工时拆分）

import { api } from '@/api/http';
import type { StatisticsQuery } from '@/types/statistics';
import type {
  OverviewOutData,
  WorkerDetailOutData,
  WorkerStatsListOutData,
} from '@/views/statistics/composables/statisticsSchema';

/**
 * GET /statistics/overview
 *
 * 基础统计 + 4 个图表数据（daily_created / daily_completed /
 * delivery_performance / status_distribution）。
 *
 * date_from / date_to 必填；后端要求严格 'YYYY-MM-DD' 格式。
 */
export async function fetchOverview(q: StatisticsQuery): Promise<OverviewOutData> {
  const { data } = await api.get<OverviewOutData>('/statistics/overview', {
    params: { date_from: q.date_from, date_to: q.date_to },
  });
  return data;
}

/**
 * GET /statistics/workers
 *
 * tab2：所有未软删工人的贡献度一览（一次性全量返回，
 * 前端按 is_active / 工种 / pickup_count 自管分页筛选）。
 */
export async function fetchWorkerStats(q: StatisticsQuery): Promise<WorkerStatsListOutData> {
  const { data } = await api.get<WorkerStatsListOutData>('/statistics/workers', {
    params: { date_from: q.date_from, date_to: q.date_to },
  });
  return data;
}

/**
 * GET /statistics/workers/{worker_id}
 *
 * tab3：单工人详情（worker 卡片 + 数字 + daily_pickups + parts 列表 +
 * 有效工时总额与按工序拆分）。
 * workerId 是雪花 ID 字符串（非 int，防 Number 精度丢失，见 CLAUDE.md §3）。
 */
export async function fetchWorkerDetail(
  workerId: string,
  q: StatisticsQuery,
): Promise<WorkerDetailOutData> {
  const { data } = await api.get<WorkerDetailOutData>(
    `/statistics/workers/${encodeURIComponent(workerId)}`,
    {
      params: { date_from: q.date_from, date_to: q.date_to },
    },
  );
  return data;
}
