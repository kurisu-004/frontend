// 2026-09-29 新增：dashboard「紧急工单 Top 列表」useQuery composable。
//
// 数据流（与方案 §2 数据流对齐）：
//   1. 调 listUnionItems（com 域跨表合并端点）拉 100 件按 system_delivery_date ASC
//      排序的非终态工单（PENDING/PROGRAMMING/IN_PROCESS/INSPECTION/READY_TO_SHIP/
//      OUTSOURCE/REPAIRING 共 7 个状态，覆盖「还在路上」的工件）；
//   2. 客户端再过滤 system_delivery_date <= today+7，取 top 15（dashboard 顶层
//      视图消费方）—— 后端不支持 system_delivery_date_from/_to，但 sort_by +
//      limit=100 已经能覆盖 7 天窗口内绝大多数件；
//   3. queryFn 走 partListResultSchema.parse(...) 守门（沿 2026-09-26 约定 #4）；
//   4. 接 useDashboardInvalidation(qk.dashboardUrgentList) 同套 AFFECTS_DASHBOARD
//      事件集自动失效（与 dashboardSnapshot 共用事件订阅，无重复订阅）。
//
// 2026-09-30 业务方确认：排序字段由 PLANNED_DELIVERY_DATE 切换为
// SYSTEM_DELIVERY_DATE（PartSortKey 已包含该值，无需扩 union），行内展示也用
//「系统交期」做默认排序与展示；dashboard「紧急工单」语义从「计划临近」改为
//「系统交期临近」，与生产实况对齐。
//
// 设计要点：
//   - 入参硬编码（非 reactive params）：dashboard 不改筛选条件，原 partsList 那种
//     reactive 模式不需要；queryKey 用静态常量 qk.dashboardUrgentList 即可。
//   - enabled 闸门始终 true（dashboard 顶层 fetch，无 restore 语义）。
//   - staleTime / gcTime: POSITIVE_INFINITY（沿 2026-09-26 共享基础数据层约定
//     #3），失效责任完全在 WS 事件侧。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 返回 { items, urgentCount, fetchList }：items = 全量 100 件（让 caller
//     自管过滤 + slice），urgentCount 派生 = items.filter(is_urgent).length。

import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { listUnionItems, type UnionListParams } from '@/api/com/unionList';
import { partListResultSchema, type UnionListResultSchema } from '@/composables/queries/schemas';
import { qk } from '@/composables/queries/keys';
import type { PartListItem } from '@/types/parts';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** dashboard 紧急工单列表的硬编码入参。
 *
 * 沿 usePartsListQuery 的 listParts 范本（statuses / sort_by / sort_dir / limit /
 * offset 五字段），但 dashboard 不改筛选条件，所以这里直接给常量 —— 避免 reactive
 * 包装产生无意义的 queryKey 重算。
 *
 * 2026-09-30 调整：sort_by 由 PLANNED_DELIVERY_DATE 改为 SYSTEM_DELIVERY_DATE
 * （PartSortKey 已包含该值，见 src/types/parts.ts:95）。 */
const URGENT_LIST_PARAMS: UnionListParams = {
  row_type: 'ALL',
  statuses: [
    'PENDING',
    'PROGRAMMING',
    'IN_PROCESS',
    'INSPECTION',
    'READY_TO_SHIP',
    'OUTSOURCE',
    'REPAIRING',
  ],
  sort_by: 'SYSTEM_DELIVERY_DATE',
  sort_dir: 'ASC',
  limit: 100,
  offset: 0,
};

export function useDashboardUrgentList() {
  // WS 事件 → invalidate（沿用 useDashboardSnapshot 的 AFFECTS_DASHBOARD 集合，
  // 通过 useDashboardInvalidation 复用，避免双 handler 各自跑 debounce）。
  useDashboardInvalidation(qk.dashboardUrgentList);

  const query = useQuery<UnionListResultSchema, Error>({
    queryKey: qk.dashboardUrgentList,
    queryFn: async () => partListResultSchema.parse(await listUnionItems(URGENT_LIST_PARAMS)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 派生：items 全量 100 件数组 + urgentCount（KPI 块「紧急工单 N 件」共用一次 fetch）。
  // 2026-09-29：partSchema.matched_children 是 z.array(z.unknown()) 兜底以容忍后端
  // 字段漂移，与 PartListItem.matched_children?: PartListItem[] | null 形态不完全
  // 对齐；这里强转 PartListItem[]（消费侧仅读 boolean / string 字段，不递归匹配子件）。
  const items = computed<PartListItem[]>(
    () => (query.data.value?.items ?? []) as unknown as PartListItem[],
  );
  const urgentCount = computed<number>(() => items.value.filter((p) => p.is_urgent).length);

  // fetchList 别名 = refetch 的 async 包装（沿 2026-09-26 约定 #7）。外部 caller
  // （Drawer row-click 后想强制刷新、测试 await q.fetchList()）零改动可用。
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接（沿 2026-09-26 约定 #6）：useQuery 的 error 不在 setup 抛错，
  // 走 watch + ElMessage.error 桥接。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '紧急工单加载失败');
  });

  return {
    items,
    urgentCount,
    fetchList,
    query,
  };
}