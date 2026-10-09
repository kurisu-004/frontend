// src/views/statistics/composables/useStatisticsWorkersQuery.ts
//
// 工人贡献度列表（tab2 工人表 + tab3 的工人下拉）的 useQuery composable。
// 2026-10-12 新增，与 `./statisticsSchema.ts` 的守门 schema 同居本目录。
//
// 设计要点（形态范本：`src/views/dashboard/composables/useDashboardUpcoming.ts`，
// 取舍说明同 `./useStatisticsOverviewQuery.ts`）：
//   - hook **无自有状态**：入参 `MaybeRefOrGetter<StatisticsQuery | null>`，返回
//     `{ query, data, isFetching, error, fetchList }`。工种筛选 / 含停用工人开关 /
//     列可见性 / 排序这些页面私有态仍归 `views/statistics/WorkerStatsTab.vue` 与
//     `WorkerDetailTab.vue`。
//   - **这条键被两个 tab 共用**：工人贡献度列表在 tab2（表格数据源）与 tab3（工人
//     下拉的候选集）是同一份数据，共用一条 queryKey 才能同屏去重、跨 tab 命中 30s 缓存。
//   - reactive params 范式：`queryKey = computed(() => qk.statisticsWorkers(toValue(params)))`，
//     queryFn **从 queryKey 读 params**，不闭包捕获 stale 值。
//   - params 允许 `null` ⇒ 占位键 + `enabled` 闸门 + queryFn 二次守卫（后端两个日期
//     参数是必填 `NaiveDate`，漏传是 HTTP 400 纯文本，见 overview hook 的注释）。
//   - queryFn Zod 守门：`workerStatsListOutSchema.parse(await fetchWorkerStats(params))`。
//   - ⚠️ **端点一次性返全部**（无分页信封），所以键里没有 limit / offset；分页 /
//     筛选在前端做。「零事件工人也列出」（三个工时字段零填充）这一点由 schema 与
//     后端 VO 共同保证，前端不要假设「没行 = 没工人」。
//   - staleTime 30s / gcTime 5min（**gcTime 取有限值**：本域纯只读、无 WS 失效通道，
//     没有 dashboard 域把 GC 设成无限的前提）。
//   - 不写 retry：信任 `main.ts` 全局 `queries.retry: 0`。
//   - 失效：本域零写点，当前没有 invalidate 调用方；将来走 `qk.statisticsPrefix`。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchWorkerStats } from '@/api/statistics';
import { qk } from '@/composables/queries/keys';
import type { StatisticsQuery } from '@/types/statistics';
import { workerStatsListOutSchema } from './statisticsSchema';

/** 2026-10-12 新增：工人贡献度列表主查询（tab2 工人表 + tab3 工人下拉共用）。
 *
 * 用法：
 *   ```ts
 *   const q = useStatisticsWorkersQuery(() => ({ date_from, date_to }));
 *   // 模板里 q.data?.items（含 effective_minutes / worked_process_count /
 *   //            worked_batch_count 三个工时维度字段）
 *   ```
 *
 * @param params 日期范围 `{ date_from, date_to }`；null ⇒ enabled=false，零网络请求。
 */
export function useStatisticsWorkersQuery(params: MaybeRefOrGetter<StatisticsQuery | null>) {
  const queryKey = computed(() => qk.statisticsWorkers(toValue(params)));

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const p = queryKey.value[2];
      if (!p) throw new Error('缺少统计日期范围');
      return workerStatsListOutSchema.parse(await fetchWorkerStats(p));
    },
    enabled: computed(() => !!toValue(params)),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // fetchList 别名 = refetch 的 async 包装，供外部调用方与测试零改动驱动。
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错，走 watch + ElMessage.error。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '工人报工总览加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}
