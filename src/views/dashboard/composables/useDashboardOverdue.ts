// 2026-09-29 新增：dashboard「逾期未交 KPI」useQuery composable。
//
// 数据流（与方案 §2 数据流对齐）：
//   1. 调 fetchOverview({ date_from: todayIso, date_to: todayIso }) 拉当天日期范围
//      的生产统计概览；后端返回 overdue_undelivered_count（已过期未交付的件，
//      即 planned_delivery_date < today 且状态非 DELIVERED/COMPLETED/CANCELLED）
//   2. enabled 闸门：isManager 为 true 才发请求；非 Manager 不发请求（dashboard
//      「逾期未交」tile 渲染「需 Manager 权限」占位）
//   3. queryFn 走 overviewOutSchema.parse(...) 守门（沿 2026-09-26 约定 #4 +
//      2026-09-29 新增 overviewOutSchema）
//   4. 接 useDashboardInvalidation(qk.dashboardOverdue) 同套 AFFECTS_DASHBOARD
//      事件集自动失效（与 dashboardSnapshot / dashboardUrgentList 共用事件订阅，
//     无重复订阅）
//
// 设计要点：
//   - 入参硬编码 date_from = date_to = 今天 ISO（'YYYY-MM-DD'），dashboard 重置管理
//     不变；当前日期每天 00:00:00 由浏览器本地时钟派生，无需外部 ref。
//   - 失败 graceful：overview 端点需要 MANAGER 角色，非 Manager 调它会被后端 403。
//     enabled=false 闸门挡掉请求，dashboard 上层只看 error / data 派生显示占位，
//     不抛错。
//   - staleTime / gcTime: POSITIVE_INFINITY（沿 2026-09-26 共享基础数据层约定
//     #3），失效责任完全在 WS 事件侧。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 返回 { overdueCount, fetchList }：overdueCount 是 number（or 0 when 未启用）；
//     fetchList 是 refetch 别名（沿 2026-09-26 约定 #7）。

import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { fetchOverview } from '@/api/statistics';
import type { ComputedRef } from 'vue';
import { overviewOutSchema, type OverviewOutSchema } from '@/composables/queries/schemas';
import { qk } from '@/composables/queries/keys';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** 2026-09-29 新增：派生当天 ISO 日期字符串 'YYYY-MM-DD'（本地时区）。 */
function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export interface UseDashboardOverdueReturn {
  /** overdue_undelivered_count 数字；isManager=false 或未就绪 → 0 */
  overdueCount: ComputedRef<number>;
  /** refetch 别名（沿 2026-09-26 约定 #7） */
  fetchList: () => Promise<void>;
  /** useQuery 实例，caller 可读 isFetching / error */
  query: ReturnType<typeof useQuery<OverviewOutSchema, Error>>;
}

export function useDashboardOverdue(isManager: ComputedRef<boolean>): UseDashboardOverdueReturn {
  // WS 事件 → invalidate（沿用 dashboard 域同套 AFFECTS_DASHBOARD 事件集）。
  useDashboardInvalidation(qk.dashboardOverdue);

  const query = useQuery<OverviewOutSchema, Error>({
    queryKey: qk.dashboardOverdue,
    queryFn: async () => {
      const today = todayIso();
      return overviewOutSchema.parse(
        await fetchOverview({ date_from: today, date_to: today }),
      );
    },
    enabled: isManager,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 派生 overdueCount（isManager=false 或 query 未就绪 → 0）。
  const overdueCount = computed<number>(() => query.data.value?.overdue_undelivered_count ?? 0);

  async function fetchList(): Promise<void> {
    if (!isManager.value) return;
    await query.refetch();
  }

  // 错误桥接（沿 2026-09-26 约定 #9）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '逾期未交统计加载失败');
  });

  return {
    overdueCount,
    fetchList,
    query,
  };
}
