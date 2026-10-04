// dashboard 大屏快照 composable（HTTP 全量首取 + WS 事件 invalidate）。
//
// 数据流：
//   1. setup 顶层 useQuery 拉一次 GET /api/v2/dashboard/snapshot 全量数据，
//      queryFn 走 dashboardSnapshotSchema.parse(...) 守门；
//   2. 交期统计口径 basis 是 reactive 入参（MaybeRefOrGetter），进 queryKey 也进
//      请求查询串 ⇒ 切口径即换键自动 refetch，柱状图 / KPI / 抽屉明细三处共用同一份
//      口径（DashboardView 持有唯一状态源）；
//   3. 业务事件通过 useDashboardInvalidation(qk.dashboardSnapshotPrefix) 共享事件集
//      + debounce + invalidate 重取（用前缀而非带 basis 的精确键：业务写入会同时改变
//      两种口径的统计结果，切回去时不能吃旧数）；
//   4. error 走 watch + ElMessage.error 桥接。
//
// 设计要点：
//   - 把 AFFECTS_DASHBOARD 事件集 + useDebounceFn 500ms + maxWait 1500ms +
//     qc.invalidateQueries 闭包抽到 useDashboardInvalidation.ts，本 composable
//     只需调用一次即可复用同一套事件订阅 + 防抖合并（避免 useDashboardUrgentList /
//     useDashboardOverdue 各自再挂一份 handler、各自跑 debounce 浪费 RTT）。
//   - 错误桥接（useQuery error → ElMessage.error）保留在本 composable；
//     useDashboardInvalidation 不挂 ElMessage（事件订阅与错误桥接职责分离）。
//   - reactive params 范式：queryKey = computed(() => qk.xxx(toValue(basis)))，
//     queryFn **从 queryKey 读 basis**（queryKey 是唯一真相源），不闭包捕获 stale 值。
//   - staleTime: 30_000（30s 短时去重窗口）/ gcTime: POSITIVE_INFINITY（会话级缓存）。
//     30s 而非无限，两条理由：
//      1) 对齐 CLAUDE.md 2026-09-30「TanStack Query 降级为 30s 短时请求去重层」策略，
//        也与同目录 useDashboardUpcomingList 的既有取值一致；
//      2) 更实际的原因是 staleTime 无限时**空闲的大屏不产生任何 HTTP 流量**，而
//        http.ts 的 maybeProactiveRefresh 只在成功响应拦截器里触发 —— 于是 access
//        token（默认 900s TTL）过期后没人去刷新，WS 只能永远握着一个过期 token 重连
//        （后端 40102/40105）。30s staleTime 让大屏即便无操作也会周期性重取，
//        从而带动 token 主动刷新这条链路。
//   - gcTime 的 POSITIVE_INFINITY 不可改：dashboard 域 4 个 query 的会话级缓存是
//     CLAUDE.md 认证一节「跨账号缓存隔离只靠 auth 的 queryClient.clear() 兜底」
//     这条安全约束的一部分，改成有限值会掩盖该约束的前提。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchDashboardSnapshot } from '@/api/dashboard';
import { qk } from '@/composables/queries/keys';
import type { DeliveryBasis } from '@/types/dashboard';
import { dashboardSnapshotSchema } from './dashboardSnapshotSchema';
import { useDashboardInvalidation } from './useDashboardInvalidation';

export function useDashboardSnapshot(basis: MaybeRefOrGetter<DeliveryBasis>) {
  // WS 事件 → debounce → invalidate（事件集 + 防抖细节已下沉到 useDashboardInvalidation）。
  // 传前缀键：键已含 basis 维度，事件到达时两种口径的缓存都要失效。
  useDashboardInvalidation(qk.dashboardSnapshotPrefix);

  // queryKey 工厂入参：口径进键 ⇒ 切口径即自动 refetch。
  const queryKey = computed(() => qk.dashboardSnapshot(toValue(basis)));

  const query = useQuery({
    queryKey,
    // 从 queryKey 读 basis（reactive params 范式），不闭包捕获 stale 口径。
    queryFn: async () =>
      dashboardSnapshotSchema.parse(await fetchDashboardSnapshot({ basis: queryKey.value[2] })),
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '大屏数据加载失败');
  });

  return query;
}
