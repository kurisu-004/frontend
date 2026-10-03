// dashboard「交期工单」useQuery composable。
//
// 数据流：
//   1. 调 listUnionItems（com 域跨表合并端点）拉 100 件按 system_delivery_date ASC
//      排序的非终态工单（PENDING/PROGRAMMING/IN_PROCESS/INSPECTION/READY_TO_SHIP/
//      OUTSOURCE 共 6 个状态，覆盖「还在路上」的工件）；
//   2. 客户端按 system_delivery_date <= today+6 取窗口内工单，并按「有无已交批次」
//      分成 urgent / partial 两桶（splitForDashboard，src/utils/systemDeliveryOrders.ts）
//      —— 后端不支持 system_delivery_date_from/_to，但 sort_by + limit=100 已经能
//      覆盖 7 天窗口内绝大多数件；
//   3. queryFn 走 partListResultSchema.parse(...) 守门；
//   4. 接 useDashboardInvalidation(qk.dashboardUrgentList) 同套 AFFECTS_DASHBOARD
//      事件集自动失效（与 dashboardSnapshot 共用事件订阅，无重复订阅）。
//
// 设计要点：
//   - 入参硬编码（非 reactive params）：dashboard 不改筛选条件，原 partsList 那种
//     reactive 模式不需要；queryKey 用静态常量 qk.dashboardUrgentList 即可。
//   - enabled 闸门始终 true（dashboard 顶层 fetch，无 restore 语义）。
//   - staleTime: 30_000 / gcTime: POSITIVE_INFINITY。gcTime 无限是 CLAUDE.md
//     明确的 dashboard 域例外：靠 WS 事件失效、不靠 GC；代价是跨账号泄漏窗口无限大，
//     只靠会话终止时的 queryClient.clear() 兜底。30s staleTime 同时保证空闲大屏仍有
//     HTTP 流量带动 http.ts 的 token 主动刷新，详见 useDashboardSnapshot.ts 同位置
//     长注释。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 返回 { items, fetchList }：items = 全量 100 件，让 caller 走
//     splitForDashboard 自行分桶 + slice。

import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { listUnionItems, type UnionListParams } from '@/api/com/unionList';
import { partListResultSchema, type UnionListResultSchema } from '@/composables/queries/schemas';
import { qk } from '@/composables/queries/keys';
import type { PartListItem } from '@/types/parts';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** dashboard 交期工单列表的硬编码入参。
 *
 *  沿 usePartsListQuery 的 listParts 范本（statuses / sort_by / sort_dir / limit /
 *  offset 五字段），但 dashboard 不改筛选条件，所以这里直接给常量 —— 避免 reactive
 *  包装产生无意义的 queryKey 重算。
 *
 *  排序固定 SYSTEM_DELIVERY_DATE ASC：dashboard「交期临近」语义锚在系统交期上，
 *  窗口过滤（today+6）与 urgent / partial 分桶都在客户端做，不重排。 */
const URGENT_LIST_PARAMS: UnionListParams = {
  row_type: 'ALL',
  statuses: [
    'PENDING',
    'PROGRAMMING',
    'IN_PROCESS',
    'INSPECTION',
    'READY_TO_SHIP',
    'OUTSOURCE',
  ],
  sort_by: 'SYSTEM_DELIVERY_DATE',
  sort_dir: 'ASC',
  limit: 100,
  offset: 0,
};

export function useDashboardUrgentList() {
  // WS 事件 → invalidate（沿用 dashboard 域的 AFFECTS_DASHBOARD 集合，通过
  // useDashboardInvalidation 复用，避免双 handler 各自跑 debounce）。
  useDashboardInvalidation(qk.dashboardUrgentList);

  const query = useQuery<UnionListResultSchema, Error>({
    queryKey: qk.dashboardUrgentList,
    queryFn: async () => partListResultSchema.parse(await listUnionItems(URGENT_LIST_PARAMS)),
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 派生：items = 全量 100 件数组，消费方（DashboardView）走 splitForDashboard 分桶。
  // partSchema 的 z.infer 与 PartListItem 已直接对齐，无需强转。
  const items = computed<PartListItem[]>(() => query.data.value?.items ?? []);

  // fetchList 别名 = refetch 的 async 包装。外部 caller 与测试 await q.fetchList() 零改动可用。
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错，走 watch + ElMessage.error 桥接。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '交期工单加载失败');
  });

  return {
    items,
    fetchList,
    query,
  };
}
