// dashboard「交期工单」useQuery composable。
//
// 数据流：
//   1. 调 listUnionItems（com 域跨表合并端点）拉 100 件「7 天交期窗口内、还没交齐」的
//      非终态工单（PENDING/PROGRAMMING/IN_PROCESS/INSPECTION/READY_TO_SHIP/OUTSOURCE
//      共 6 个状态，DELIVERED 不在其中）；
//   2. 客户端按同一窗口再过一遍，并按「有无已交批次」分成 urgent / partial 两桶
//      （splitForDashboard，src/utils/systemDeliveryOrders.ts）；
//   3. queryFn 走 partListResultSchema.parse(...) 守门；
//   4. 接 useDashboardInvalidation(qk.dashboardUrgentListPrefix) 同套 AFFECTS_DASHBOARD
//      事件集自动失效（与 dashboardSnapshot 共用事件订阅，无重复订阅）。
//
// 行源口径（2026-10-05）：row_type='PART_FLAT' —— t_part 全表行，含装配件的子零件、
// 不含装配件父行，行单位恒为「件」。与 snapshot `upcoming_delivery[].count` 的
// `COUNT(*) FROM t_part` 同源 ⇒ 大屏柱状图与这两块交期面板说的是同一批工件。
//
// **日期窗口下界必须下发**（2026-10-05）：窗口是 [today, today+6]，两端都作为
// system_delivery_date_from/_to 交给服务端。只有 sort_by SYSTEM_DELIVERY_DATE ASC +
// limit 100 而没有下界时，逾期件（任意过去日期）在升序里排在最前，会把 100 条名额
// 全部占满，窗口内的一件都挤不进 Top 30。加下界后这 100 条全部落在窗口内。
// 客户端 splitForDashboard 用返回的同一个 windowStartIso 重过同一窗口（服务端与客户端
// 同源于 systemDeliveryOrders，不是两套各自写的规则）。
//
// today 必须进 queryKey（2026-10-05）：本 query 的 gcTime 是 POSITIVE_INFINITY
// （dashboard 域例外，靠 WS 事件失效），today 不进键则跨零点后新窗口的请求会命中
// 「昨天的窗口」缓存并常驻（全局 refetchOnWindowFocus: false，没有焦点重取可救）。
// 同理 queryFn 从 queryKey 读 today（reactive params 范式），不闭包捕获。
//
// **保护边界**（2026-10-05）：today 在 setup 里捕获一次，queryKey 依赖它 ⇒ 常驻大屏跨过
// 零点后窗口不会自动前移，要重新挂载本页才切到新窗口（没有定时 tick 驱动重算）。键里
// 留着 today 的作用是「重新挂载时不吃到昨天窗口的缓存」，不是「到点自动换窗」。窗口一旦
// 前移，服务端 from/to 与客户端 splitForDashboard 的窗口同刻切换（两者共用
// windowStartIso），因此面板永远不会出现两端窗口错位一天。
//
// 设计要点：
//   - 入参硬编码（除 today 外的筛选条件全部硬编码）：dashboard 不改筛选条件，原
//     partsList 那种 reactive 模式不需要。
//   - enabled 闸门省略：dashboard 顶层 fetch，无 restore 语义。
//   - staleTime: 30_000 / gcTime: POSITIVE_INFINITY。gcTime 无限是 CLAUDE.md
//     明确的 dashboard 域例外：靠 WS 事件失效、不靠 GC；代价是跨账号泄漏窗口无限大，
//     只靠会话终止时的 queryClient.clear() 兜底。30s staleTime 同时保证空闲大屏仍有
//     HTTP 流量带动 http.ts 的 token 主动刷新，详见 useDashboardSnapshot.ts 同位置
//     长注释。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 返回 { items, fetchList, query, windowStartIso }：items = 窗口内至多 100 件（服务端
//     limit 截断），让 caller 走 splitForDashboard 自行分桶 + slice；windowStartIso 是本次
//     挂载捕获的窗口下界，必须原样传给 splitForDashboard。

import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { listUnionItems, type UnionListParams } from '@/api/com/unionList';
import { partListResultSchema, type UnionListResultSchema } from '@/composables/queries/schemas';
import { qk } from '@/composables/queries/keys';
import { deliveryWindowEndIso, deliveryWindowStartIso } from '@/utils/systemDeliveryOrders';
import type { PartListItem } from '@/types/parts';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** dashboard 交期工单列表的硬编码入参（日期窗口在 queryFn 里按 today 补）。
 *
 *  沿 usePartsListQuery 的 listParts 范本（statuses / sort_by / sort_dir / limit /
 *  offset 五字段），但 dashboard 不改筛选条件，所以这里直接给常量 —— 避免 reactive
 *  包装产生无意义的 queryKey 重算。
 *
 *  排序固定 SYSTEM_DELIVERY_DATE ASC：dashboard「交期临近」语义锚在系统交期上，
 *  窗口过滤在服务端 + 客户端各做一次（同一窗口），urgent / partial 分桶在客户端做，
 *  两侧都不重排。 */
const URGENT_LIST_PARAMS: Omit<
  UnionListParams,
  'system_delivery_date_from' | 'system_delivery_date_to'
> = {
  row_type: 'PART_FLAT',
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
  // useDashboardInvalidation 复用，避免双 handler 各自跑 debounce）。用前缀键：
  // today 进了 queryKey，前缀一把命中全部日期形态（含昨天窗口那条）。
  useDashboardInvalidation(qk.dashboardUrgentListPrefix);

  // 窗口下界 = 本地今天，**setup 里捕获一次**：queryKey 与返回给消费方的 windowStartIso
  // 必须是同一个瞬间捕获的同一个值 —— queryFn 从 queryKey 读它（reactive params 范式），
  // 消费方 splitForDashboard 再拿同一个值派生上界，两端口径才不会各取一次 today 后漂移。
  const windowStartIso = deliveryWindowStartIso();
  const queryKey = computed(() => qk.dashboardUrgentList(windowStartIso));

  const query = useQuery<UnionListResultSchema, Error>({
    queryKey,
    queryFn: async () => {
      // 从 queryKey 读 today（reactive params 范式）：queryKey 变 ⇒ 换缓存身份，
      // queryFn 里的窗口参数必须与键里的 today 严格一致，否则键与请求对不上。
      const today = queryKey.value[2];
      return partListResultSchema.parse(
        await listUnionItems({
          ...URGENT_LIST_PARAMS,
          system_delivery_date_from: today,
          system_delivery_date_to: deliveryWindowEndIso(today),
        }),
      );
    },
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 派生：items = 服务端按 [today, today+6] 窗口过滤后、limit 截断到至多 100 件的数组，
  // 消费方（DashboardView）带 windowStartIso 走 splitForDashboard 分桶。
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
    /**
     * 窗口下界（本次挂载捕获的那一个值）。消费方 splitForDashboard 必须把它当第三参
     * 传回去，让客户端窗口与服务端请求窗口锁同一瞬间。
     */
    windowStartIso,
  };
}
