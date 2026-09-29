// 2026-09-29 重构（基于 2026-09-28 原始版本）：
//
//   - 把 AFFECTS_DASHBOARD 事件集 + useDebounceFn 500ms + maxWait 1500ms +
//     qc.invalidateQueries 闭包 抽到 useDashboardInvalidation.ts，本 composable
//     只需调用一次 useDashboardInvalidation(qk.dashboardSnapshot) 即可复用
//     同一套事件订阅 + 防抖合并（避免 useDashboardUrgentList / useDashboardOverdue
//     各自再挂一份 handler、各自跑 debounce 浪费 RTT）。
//   - 错误桥接（useQuery error → ElMessage.error）保留在本 composable；
//     useDashboardInvalidation 不挂 ElMessage（事件订阅与错误桥接职责分离）。
//
// 数据流（沿 2026-09-28 dashboard 域架构）：
//   1. setup 顶层 useQuery 拉一次 GET /api/v2/dashboard/snapshot 全量数据，
//      queryFn 走 dashboardSnapshotSchema.parse(...) 守门；
//   2. 业务事件通过 useDashboardInvalidation 共享事件集 + debounce + invalidate
//      触发 qk.dashboardSnapshot 重取；
//   3. error 走 watch + ElMessage.error 桥接（沿 2026-09-26 约定 #9）。
//
// 设计要点：
//   - staleTime / gcTime: POSITIVE_INFINITY：会话级缓存，失效责任完全在
//     useDashboardInvalidation 侧（每个事件命中 AFFECTS_DASHBOARD 即 invalidate）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { useQuery } from '@tanstack/vue-query';
import { watch } from 'vue';
import { ElMessage } from 'element-plus';
import { fetchDashboardSnapshot } from '@/api/dashboard';
import { qk } from '@/composables/queries/keys';
import { dashboardSnapshotSchema } from './dashboardSnapshotSchema';
import { useDashboardInvalidation } from './useDashboardInvalidation';

export function useDashboardSnapshot() {
  // WS 事件 → debounce → invalidate（事件集 + 防抖细节已下沉到 useDashboardInvalidation）。
  useDashboardInvalidation(qk.dashboardSnapshot);

  const query = useQuery({
    queryKey: qk.dashboardSnapshot,
    queryFn: async () => dashboardSnapshotSchema.parse(await fetchDashboardSnapshot()),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错（沿 2026-09-26 约定 #9）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '大屏数据加载失败');
  });

  return query;
}
