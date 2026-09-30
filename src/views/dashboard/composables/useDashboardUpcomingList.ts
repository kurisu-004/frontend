// 2026-09-30 新增：dashboard「7 天交期柱状图按层点击抽屉」useQuery composable。
//
// 数据流（与方案 §2.4 对齐）：
//   1. 入参 reactive { date: 'YYYY-MM-DD', statuses: OrderStatus[] }：
//      - 仅在 drawer 打开时 caller 传非 null 启用闸门；
//      - 切层 / 切换日期时 key 变化自动 refetch。
//   2. queryFn 调 listUnionItems 拉该日 × 该层状态所有工单（按 planned_delivery_date
//      ASC 排序，最多 500 件 —— 单日 8 状态合计远小于 500 上限，作为防御性兜底）；
//   3. queryFn 走 partListResultSchema.parse(...) 守门（沿 2026-09-26 约定 #4）。
//
// 设计要点（沿 2026-09-26 TanStack Query 共享基础数据层 + 2026-09-29 useDashboardUrgentList）：
//   - reactive params 模式：queryKey = computed(() => qk.xxx(toValue(params)))，
//     queryFn 从 queryKey[2] 读最新 params（避免闭包 stale —— 沿 2026-09-26 约定 #5）。
//   - enabled 闸门：!!p && p.statuses.length > 0 —— drawer 未打开或空 statuses 时不发。
//   - staleTime: 30_000：30s 内同 (date, statuses) 命中缓存（避免来回切层 / 切日期
//     时重复请求）；gcTime: POSITIVE_INFINITY（会话级缓存）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 接 useDashboardInvalidation(qk.dashboardUpcomingList) 复用 AFFECTS_DASHBOARD
//     事件集，与 dashboardSnapshot / urgentList / overdue 共用同一份事件订阅 +
//     debounce 闭包（避免 handler 各跑各的 500ms 防抖）。
//   - 错误桥接：watch(query.error) → ElMessage.error（沿 2026-09-26 约定 #9）。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { listUnionItems } from '@/api/com/unionList';
import { partListResultSchema, type PartListResultSchema } from '@/composables/queries/schemas';
import { qk } from '@/composables/queries/keys';
import type { OrderStatus, PartListItem } from '@/types/parts';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** 2026-09-30 新增：useDashboardUpcomingList 入参形态。
 *  date = 计划交期精确日期（'YYYY-MM-DD'）；statuses = 该层 OrderStatus 数组。 */
interface UpcomingListParams {
  date: string;
  statuses: OrderStatus[];
}

export function useDashboardUpcomingList(
  params: MaybeRefOrGetter<UpcomingListParams | null>,
) {
  // WS 事件 → invalidate（沿 useDashboardUrgentList 同形，共享 AFFECTS_DASHBOARD）。
  // 直接传 ['dashboard', 'upcoming-list'] 前缀：useDashboardInvalidation 内
  // qc.invalidateQueries({ queryKey: k }) 走 TanStack 前缀 partial match，会命中
  // 所有 qk.dashboardUpcomingList(date, statuses) 形态的具体查询。
  useDashboardInvalidation(['dashboard', 'upcoming-list'] as const);

  // queryKey 工厂参数：序列化 statuses 数组，确保 (date, statuses) 任意变化都触发 refetch。
  const queryKeyParams = computed(() => {
    const p = toValue(params);
    if (!p) return null;
    return { date: p.date, statuses: [...p.statuses] };
  });

  const query = useQuery<PartListResultSchema, Error>({
    queryKey: computed(() => qk.dashboardUpcomingList(queryKeyParams.value!)),
    queryFn: async () => {
      // 从 queryKey 读最新 params（沿 2026-09-26 约定 #5 reactive params 范式），
      // 避免闭包捕获 stale。
      const p = queryKeyParams.value;
      if (!p) throw new Error('useDashboardUpcomingList: params is null at fetch time');
      return partListResultSchema.parse(
        await listUnionItems({
          row_type: 'PART',
          statuses: p.statuses,
          planned_delivery_date_from: p.date,
          planned_delivery_date_to: p.date,
          sort_by: 'PLANNED_DELIVERY_DATE',
          sort_dir: 'ASC',
          limit: 500,
          offset: 0,
        }),
      );
    },
    enabled: computed(() => {
      const p = toValue(params);
      return !!p && p.statuses.length > 0;
    }),
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 派生（沿 2026-09-29 useDashboardUrgentList 风格）：
  //   - data = query.data.value?.items as PartListItem[]（partSchema.matched_children
  //     z.array(z.unknown()) 与 PartListItem.matched_children 形态差异，消费侧只读
  //     boolean / string 字段，强转安全）；
  //   - isPending / error 派生让 caller 模板里写 isPending.value 即可。
  const data = computed<PartListItem[]>(
    () => (query.data.value?.items ?? []) as unknown as PartListItem[],
  );
  const isPending = computed<boolean>(() => query.isPending.value);
  const error = computed<Error | null>(() => query.error.value);

  // 错误桥接（沿 2026-09-26 约定 #9）：watch(query.error) → ElMessage.error。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '交期明细加载失败');
  });

  return {
    data,
    isPending,
    error,
    refetch: () => query.refetch(),
  };
}