// dashboard「交期分桶」useQuery composable（柱状图数据源 + 今日 / 窗口 KPI 派生）。
//
// 数据流：
//   1. 入参 reactive：交期统计口径 basis（planned / system）+ 窗口天数 days；
//      两者任一变化即换键自动 refetch，柱状图与两个 KPI 自动跟随同一口径。
//   2. queryFn 调 fetchUpcomingDelivery 取服务端已零填充好的 days 条分桶，并回一个
//      **后端判定的 today** —— 前端一律用它做「今天」锚点，不再 new Date()
//      （浏览器时区与服务端不同步会让整块柱状图错位 → 整块区域空）。
//   3. queryFn 走 upcomingBucketsSchema.parse(...) 守门。
//   4. 接 useDashboardInvalidation(qk.dashboardUpcomingPrefix) 同套
//      AFFECTS_DASHBOARD 事件集自动失效（与 dashboardSnapshot /
//      dashboardDeliveryOrders 共用事件订阅，无重复订阅）。
//
// 设计要点：
//   - reactive params 范式：queryKey = computed(() => qk.dashboardUpcoming(toValue(basis),
//     toValue(days)))，queryFn **从 queryKey 读 basis / days**（键是唯一真相源），
//     不闭包捕获 stale 值。
//   - 失效键必须用**前缀**而非带 basis + days 的精确键：这两者都是页面级可变状态，
//     用户切走再切回时旧键同样过期，前缀一把 partial match 命中所有组合。
//   - placeholderData: keepPreviousData —— 切口径 / 切天数换的是 queryKey，不设它新键
//     在响应到达前 data 为 undefined，柱状图 14/7/30 根柱子全清零 + 两个 KPI 归零。
//     沿用仓内既成做法（usePartsListQuery / useInspectionListStore /
//     usePendingProgrammingStore 同款）。代价是新参数数据到达前图上仍是旧的数字，故
//     调用方必须配合 query.isPlaceholderData 出一层「数字还不是当前口径」的提示。
//     必须是 isPlaceholderData 而**不是 isFetching**：后者是「正在取数」，任何同键后台
//     refetch（含 AFFECTS_DASHBOARD 事件在 busy 车间 500ms debounce 后的高频刷新）都
//     会让它为 true，而那时图上数字是当前且正确的，提示层会播报一个假状态。
//   - staleTime: 30_000 / gcTime: POSITIVE_INFINITY（CLAUDE.md 明列的 dashboard 域
//     例外，靠 WS 事件失效、不靠 GC；跨账号泄漏窗口只靠会话终止时的
//     queryClient.clear() 兜底）。30s staleTime 同时保证空闲大屏仍有 HTTP 流量带动
//     http.ts 的 token 主动刷新，详见 useDashboardSnapshot.ts 同位置长注释。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 返回 { data, isPlaceholderData, fetchList, query }：fetchList 是 refetch 别名，
//     供外部调用方与测试零改动驱动。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchUpcomingDelivery } from '@/api/dashboard';
import { qk } from '@/composables/queries/keys';
import type { DeliveryBasis } from '@/types/dashboard';
import { upcomingBucketsSchema } from './dashboardSnapshotSchema';
import { useDashboardInvalidation } from './useDashboardInvalidation';

export function useDashboardUpcoming(
  basis: MaybeRefOrGetter<DeliveryBasis>,
  days: MaybeRefOrGetter<number>,
) {
  // WS 事件 → invalidate（沿用 dashboard 域的 AFFECTS_DASHBOARD 集合，通过
  // useDashboardInvalidation 复用，避免双 handler 各自跑 debounce）。用前缀键：
  // basis 与 days 都进了 queryKey，前缀一把命中全部组合形态。
  useDashboardInvalidation(qk.dashboardUpcomingPrefix);

  const queryKey = computed(() => qk.dashboardUpcoming(toValue(basis), toValue(days)));

  const query = useQuery({
    queryKey,
    // 从 queryKey 读 basis / days（reactive params 范式），不闭包捕获 stale 值。
    queryFn: async () => {
      const keyBasis = queryKey.value[2];
      const keyDays = queryKey.value[3];
      return upcomingBucketsSchema.parse(
        await fetchUpcomingDelivery({ basis: keyBasis, days: keyDays }),
      );
    },
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });

  // fetchList 别名 = refetch 的 async 包装。外部 caller 与测试 await q.fetchList() 零改动可用。
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错，走 watch + ElMessage.error 桥接。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '交期分桶加载失败');
  });

  return {
    data: query.data,
    isPlaceholderData: query.isPlaceholderData,
    fetchList,
    query,
  };
}
