// src/views/statistics/composables/useStatisticsWorkerDetailQuery.ts
//
// 单工人详情（tab3）的 useQuery composable。2026-10-12 新增，与
// `./statisticsSchema.ts` 的守门 schema 同居本目录。
//
// 设计要点（形态范本：`src/views/dashboard/composables/useDashboardUpcoming.ts`，
// 取舍说明同 `./useStatisticsOverviewQuery.ts`）：
//   - hook **无自有状态**：入参 `MaybeRefOrGetter<string | null | undefined>`
//     （workerId）+ 日期范围 params，返回 `{ query, data, isFetching, error, fetchList }`。
//   - ⚠️ **workerId 走独立键位**（`qk.statisticsWorkerDetail(workerId, params)`），
//     不塞进 params 对象：端点按工人分片返回，不带 id 切工人时会拿上一个工人的详情
//     冒充当前工人（比 404 更坏 —— 若那个 id 恰好有效，页面会静默渲染成另一个工人）。
//   - workerId 缺失（`null` / `undefined` / 空串）⇒ 占位键
//     （`['statistics', 'worker-detail', '', null]`）+ `enabled` 闸门 + **queryFn 二次
//     守卫**。二次守卫必需：`enabled=false` 只挡首调，调用方显式 `refetch()` 时仍会走
//     queryFn，而空 workerId 打过去是后端 `parse::<i64>()` 失败（20104 / HTTP 400）。
//   - params 同样允许 `null` ⇒ 占位键 + 闸门 + 二次守卫（后端 `date_from` / `date_to`
//     是必填 `NaiveDate`，漏传是 HTTP 400 纯文本）。
//   - queryFn Zod 守门：`workerDetailOutSchema.parse(await fetchWorkerDetail(id, p))`。
//   - 服务端已把 `process_breakdown[]` 排好序（`effective_minutes DESC, step_count
//     DESC, process_id ASC`），消费侧**不要**再排一遍。
//   - staleTime 30s / gcTime 5min（**gcTime 取有限值**：本域纯只读、无 WS 失效通道）。
//   - 不写 retry：信任 `main.ts` 全局 `queries.retry: 0`。
//   - 失效：切工人换的是整条 queryKey（不复用缓存）。本域自身零写点，故域内没有
//     invalidate；**域外**有唯一调用方（序列号一键释放，
//     `views/parts/list/composables/useSerialRelease.ts`，2026-10-19）—— 本 tab 的行 VO 带
//     `serial_no`，其可空语义正是「流水号已被释放」，那次释放确实要把本 tab 刷掉。
//
// ⚠️ 「工人未选」不是错误态：`ProductionStats.vue` 的 activeTab watcher 会在
// `selectedWorkerId` 为空时把 tab 弹回 overview，所以正常操作路径下不会长时间停在这个
// 「不发请求」的状态。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchWorkerDetail } from '@/api/statistics';
import { qk } from '@/composables/queries/keys';
import type { StatisticsQuery } from '@/types/statistics';
import { workerDetailOutSchema } from './statisticsSchema';

/** 2026-10-12 新增：单工人详情主查询（tab3）。
 *
 * 用法：
 *   ```ts
 *   const q = useStatisticsWorkerDetailQuery(workerId, () => ({ date_from, date_to }));
 *   // 模板里 q.data?.effective_minutes / q.data?.process_breakdown / q.data?.parts
 *   ```
 *
 * @param workerId  雪花 ID 字符串；null / undefined / 空串 ⇒ enabled=false，零网络请求。
 * @param params    日期范围 `{ date_from, date_to }`；null ⇒ 同上。
 */
export function useStatisticsWorkerDetailQuery(
  workerId: MaybeRefOrGetter<string | null | undefined>,
  params: MaybeRefOrGetter<StatisticsQuery | null>,
) {
  const id = computed(() => toValue(workerId) ?? '');
  const queryKey = computed(() => qk.statisticsWorkerDetail(id.value, toValue(params)));

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const keyId = queryKey.value[2];
      const p = queryKey.value[3];
      // 二次守卫：enabled=false 只挡首调，显式 refetch 时仍会走到这里。
      if (!keyId) throw new Error('未选择工人');
      if (!p) throw new Error('缺少统计日期范围');
      return workerDetailOutSchema.parse(await fetchWorkerDetail(keyId, p));
    },
    enabled: computed(() => !!toValue(workerId) && !!toValue(params)),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // fetchList 别名 = refetch 的 async 包装，供外部调用方与测试零改动驱动。
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错，走 watch + ElMessage.error。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '单工人详情加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}
