// src/views/statistics/composables/useStatisticsOverviewQuery.ts
//
// 车间生产总览（tab1）的 useQuery composable。2026-10-12 新增，与
// `./statisticsSchema.ts` 的守门 schema 同居本目录。
//
// 设计要点（形态范本：`src/views/dashboard/composables/useDashboardUpcoming.ts`）：
//   - hook **无自有状态**：入参 `MaybeRefOrGetter<StatisticsQuery | null>`（日期范围），
//     返回 `{ query, data, isFetching, error, fetchList }`。页面私有状态（日期预设
//     / 自定义日期对 / tab 态）仍归 `views/statistics/ProductionStats.vue`。
//   - reactive params 范式：`queryKey = computed(() => qk.statisticsOverview(toValue(params)))`，
//     queryFn **从 queryKey 读 params**（键是唯一真相源），不闭包捕获 stale 值 ——
//     切日期时 queryKey 变化会自动 refetch，KPI 与 4 段图表跟随同一区间。
//   - params 允许 `null` ⇒ 占位键（`['statistics', 'overview', null]`）+ `enabled`
//     闸门 + queryFn 二次守卫三重挡。**二次守卫必需**：后端 `date_from` / `date_to` 是
//     axum `Query` 提取器上的必填 `NaiveDate`，漏传得到的是 **HTTP 400 纯文本**
//     （不进 `R<T>` 信封），错误信息在页面上只会是一句无意义的 axios 报错。
//   - queryFn Zod 守门：`overviewOutSchema.parse(await fetchOverview(params))`。
//     守门点在 queryFn 而非 api 层 —— parse 返回深拷贝，在 api 层再 parse 一次等于
//     每屏数据被校验并克隆两遍（见 CLAUDE.md「queryFn Zod 守门」）。
//   - staleTime / gcTime：30s / 5min，**gcTime 取有限值**。statistics 是纯只读域、
//     零写点，没有 dashboard 域「靠 WS 事件失效才敢把 GC 设成无限」的前提；GC 设无限
//     会让「切走 5 分钟回来」命中一份半小时前的报表。
//   - 不写 retry：信任 `main.ts` 全局 `queries.retry: 0`。
//   - 错误桥接走 `watch(error) → ElMessage.error`，不在 setup 抛错。
//   - 失效：本域零写点，当前没有 invalidate 调用方；将来该域出现写操作时用
//     `qk.statisticsPrefix` 一把全失效。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchOverview } from '@/api/statistics';
import { qk } from '@/composables/queries/keys';
import type { StatisticsQuery } from '@/types/statistics';
import { overviewOutSchema } from './statisticsSchema';

/** 2026-10-12 新增：车间生产总览（tab1）主查询。
 *
 * 用法：
 *   ```ts
 *   const q = useStatisticsOverviewQuery(() => ({ date_from, date_to }));
 *   // 模板里 q.data?.delivered_count / q.data?.daily_created …
 *   ```
 *
 * @param params 日期范围 `{ date_from, date_to }`；null ⇒ enabled=false，零网络请求。
 */
export function useStatisticsOverviewQuery(params: MaybeRefOrGetter<StatisticsQuery | null>) {
  const queryKey = computed(() => qk.statisticsOverview(toValue(params)));

  const query = useQuery({
    queryKey,
    // 从 queryKey 读 params（reactive params 范式），不闭包捕获 stale 值。
    queryFn: async () => {
      const p = queryKey.value[2];
      // enabled=false 已挡住首调；留二次守卫防调用方显式 refetch 时漏传必填日期参数。
      if (!p) throw new Error('缺少统计日期范围');
      return overviewOutSchema.parse(await fetchOverview(p));
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
    if (e) ElMessage.error(e.message ?? '车间生产总览加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}
