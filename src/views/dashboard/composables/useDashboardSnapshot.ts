// dashboard 大屏快照 composable（HTTP 全量首取 + WS 事件 invalidate）。
//
// 数据流：
//   1. setup 顶层 useQuery 拉一次 GET /api/v2/dashboard/snapshot 全量数据，
//      queryFn 走 dashboardSnapshotSchema.parse(...) 守门；
//   2. 业务事件通过 useDashboardInvalidation(qk.dashboardSnapshotPrefix) 共享事件集
//      + debounce + invalidate 重取；
//   3. error 走 watch + ElMessage.error 桥接。
//
// 设计要点：
//   - 把 AFFECTS_DASHBOARD 事件集 + useDebounceFn 500ms + maxWait 1500ms +
//     qc.invalidateQueries 闭包抽到 useDashboardInvalidation.ts，本 composable
//     只需调用一次即可复用同一套事件订阅 + 防抖合并（避免同域另两个 query 各自再挂
//     一份 handler、各自跑 debounce 浪费 RTT）。
//   - 错误桥接（useQuery error → ElMessage.error）保留在本 composable；
//     useDashboardInvalidation 不挂 ElMessage（事件订阅与错误桥接职责分离）。
//   - **无 reactive params**：快照本身没有口径概念（交期分桶已拆到独立的
//     /dashboard/upcoming-delivery 端点），后端也不接受任何 query 参数 ⇒ 键是常量。
//     「今日到期 / N 天到期」两个 KPI 从 dashboardUpcoming 的 buckets 派生，不从本
//     query 派生 ⇒ 切口径 / 切天数不会让本 query 换键，与口径完全无关的
//     「在加工 / 在检 / 右栏两块面板」不会跟着闪空。
//   - 失效键用前缀（qk.dashboardSnapshotPrefix）而非字面量：即便本 query 当前是
//     无维度键，事件到达时也不该只按「键恰好等于 prefix」去打 —— 前缀键是本域的约定
//     写法，后续若给快照再加维度（例如用户级收窄）不会静默漏失效。
//   - staleTime: 30_000（30s 短时去重窗口）/ gcTime: POSITIVE_INFINITY（会话级缓存）。
//     30s 而非无限，两条理由：
//      1) 对齐 CLAUDE.md 2026-09-30「TanStack Query 降级为 30s 短时请求去重层」策略，
//        也与同域 useDashboardUpcoming 的取值一致；
//      2) 更实际的原因是 staleTime 无限时**空闲的大屏不产生任何 HTTP 流量**，而
//        http.ts 的 maybeProactiveRefresh 只在成功响应拦截器里触发 —— 于是 access
//        token（默认 900s TTL）过期后没人去刷新，WS 只能永远握着一个过期 token 重连
//        （后端 40102/40105）。30s staleTime 让大屏即便无操作也会周期性重取，
//        从而带动 token 主动刷新这条链路。
//   - gcTime 的 POSITIVE_INFINITY 不可改：dashboard 域的会话级缓存是 CLAUDE.md
//     认证一节「跨账号缓存隔离只靠 auth 的 queryClient.clear() 兜底」这条安全约束的
//     一部分，改成有限值会掩盖该约束的前提。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchDashboardSnapshot } from '@/api/dashboard';
import { qk } from '@/composables/queries/keys';
import { dashboardSnapshotSchema } from './dashboardSnapshotSchema';
import { useDashboardInvalidation } from './useDashboardInvalidation';

export function useDashboardSnapshot() {
  // WS 事件 → debounce → invalidate（事件集 + 防抖细节已下沉到 useDashboardInvalidation）。
  useDashboardInvalidation(qk.dashboardSnapshotPrefix);

  const query = useQuery({
    // 常量键：后端不接受任何 query 参数，快照也没有口径维度。包一层 computed 只为与
    // 同域另两个 composable 的键形态一致（TanStack 的 queryKey 允许 ref / computed）。
    queryKey: computed(() => qk.dashboardSnapshot()),
    queryFn: async () => dashboardSnapshotSchema.parse(await fetchDashboardSnapshot()),
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 错误桥接：useQuery 的 error 不在 setup 抛错。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '大屏数据加载失败');
  });

  return query;
}