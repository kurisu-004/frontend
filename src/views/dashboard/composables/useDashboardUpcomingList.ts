// dashboard「交期分桶柱状图按层点击抽屉」useQuery composable。
//
// 数据流：
//   1. 入参 reactive { date: 'YYYY-MM-DD', statuses: OrderStatus[], basis }：
//      - 仅在 drawer 打开时 caller 传非 null 启用闸门；
//      - 切层 / 切换日期 / 切统计口径时 key 变化自动 refetch。
//   2. queryFn 调 listUnionItems 拉该日 × 该层状态的工单行；日期窗口与排序字段
//      **按 basis 二选一**：
//      - planned → planned_delivery_date_from/to = date, sort_by 'PLANNED_DELIVERY_DATE'
//      - system  → system_delivery_date_from/to  = date, sort_by 'SYSTEM_DELIVERY_DATE'
//      两组窗口参数互斥、绝不同时发（同时发会被后端 AND 成交集，抽屉恒空）。
//   3. queryFn 走 partListResultSchema.parse(...) 守门。
//
// 行源口径（2026-10-05）：row_type='PART_FLAT' —— t_part 全表行，**含装配件的子零件、
// 不含装配件父行**，行单位恒为「件」。与柱状图 `upcoming_delivery[].count` 的
// `COUNT(*) FROM t_part`（`t_assembly` 全模块零引用）同源 ⇒ 点某根柱后抽屉列出的
// 条数与柱高口径一致：一个装配件（4 个子零件）+ 5 个独立零件，柱高 9，抽屉 9 行
// （装配件那 4 个子零件各占一行，不显示装配件父行、不加树形、不加装配件标识）。
//
// 条数与展示条数是两个值：端点 limit 被后端 clamp(1, 200)，所以抽屉最多拿回 200 行
// 而 total 可能是更大的数。**头部件数渲染 total**（`total` 派生见下），被截断时由
// 组件追加「仅显示前 N 条」提示 —— 用 rows.length 当件数会在 200 行为上限时谎报。
//
// 设计要点（与 useDashboardUrgentList 同形）：
//   - reactive params 模式：queryKey = computed(() => qk.xxx(toValue(params)))，
//     queryFn 从 queryKeyParams 读最新 params（避免闭包 stale）。
//   - enabled 闸门：!!p && p.statuses.length > 0 —— drawer 未打开或空 statuses 时不发。
//   - staleTime: 30_000：30s 内同 (date, statuses, basis) 命中缓存（避免来回切层 /
//     切日期 / 切口径时重复请求）；gcTime: POSITIVE_INFINITY（会话级缓存，同 dashboard
//     域另 3 个 query，见 CLAUDE.md 认证一节）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 失效键用字面量前缀 ['dashboard','upcoming-list']，**不用**
//     qk.dashboardUpcomingList(p)：后者是带 params 的精确键，只能失效当前
//     (date, statuses, basis) 那一条；而 params 随用户切层 / 切日期 / 切口径不断变化，
//     WS 事件到达时「需要重取」的是整个 upcoming-list 维度（此前挂载过、现已切走的那些
//     查询同样过期）。要失效的是维度而非某条查询，故用前缀匹配。
//   - 错误桥接：watch(query.error) → ElMessage.error。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { ElMessage } from 'element-plus';
import { useQuery } from '@tanstack/vue-query';
import { listUnionItems, type UnionListParams } from '@/api/com/unionList';
import { partListResultSchema, type PartListResultSchema } from '@/composables/queries/schemas';
import { qk } from '@/composables/queries/keys';
import type { OrderStatus, PartListItem } from '@/types/parts';
import type { DeliveryBasis } from '@/types/dashboard';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** 2026-09-30 新增：useDashboardUpcomingList 入参形态。
 *  date = 当前口径下命中的交期日期（'YYYY-MM-DD'）；statuses = 该层 OrderStatus 数组；
 *  basis = 交期统计口径（2026-10-04 新增，决定 date 落在哪个日期列上）。 */
interface UpcomingListParams {
  date: string;
  statuses: OrderStatus[];
  basis: DeliveryBasis;
}

/** 2026-10-04 新增：口径 → 该口径专属的日期窗口字段名 + 排序字段（下钻只发这一组）。
 *  映射「字段名」而不是「字段值」：后端两端点参数是各自成对的 from/to，字段名二选一
 *  才能天然保证另一组参数**根本不出现在请求对象里**（两组同时发会被后端 AND 成交集，
 *  抽屉恒空）。 */
const BASIS_WINDOW: Record<
  DeliveryBasis,
  {
    from: 'planned_delivery_date_from' | 'system_delivery_date_from';
    to: 'planned_delivery_date_to' | 'system_delivery_date_to';
    sortBy: 'PLANNED_DELIVERY_DATE' | 'SYSTEM_DELIVERY_DATE';
  }
> = {
  planned: {
    from: 'planned_delivery_date_from',
    to: 'planned_delivery_date_to',
    sortBy: 'PLANNED_DELIVERY_DATE',
  },
  system: {
    from: 'system_delivery_date_from',
    to: 'system_delivery_date_to',
    sortBy: 'SYSTEM_DELIVERY_DATE',
  },
};

export function useDashboardUpcomingList(
  params: MaybeRefOrGetter<UpcomingListParams | null>,
) {
  // WS 事件 → invalidate（沿 useDashboardUrgentList 同形，共享 AFFECTS_DASHBOARD）。
  // 直接传 ['dashboard', 'upcoming-list'] 前缀：useDashboardInvalidation 内
  // qc.invalidateQueries({ queryKey: k }) 走 TanStack 前缀 partial match，会命中
  // 所有 qk.dashboardUpcomingList(date, statuses, basis) 形态的具体查询。
  useDashboardInvalidation(['dashboard', 'upcoming-list'] as const);

  // queryKey 工厂参数：序列化 statuses 数组 + 带 basis，确保
  // (date, statuses, basis) 任意变化都触发 refetch。
  const queryKeyParams = computed(() => {
    const p = toValue(params);
    if (!p) return null;
    return { date: p.date, statuses: [...p.statuses], basis: p.basis };
  });

  const query = useQuery<PartListResultSchema, Error>({
    queryKey: computed(() => qk.dashboardUpcomingList(queryKeyParams.value!)),
    queryFn: async () => {
      // 从 queryKey 读最新 params（reactive params 范式），
      // 避免闭包捕获 stale。
      const p = queryKeyParams.value;
      if (!p) throw new Error('useDashboardUpcomingList: params is null at fetch time');
      // 按 basis 二选一展开日期窗口：两组窗口参数互斥，只发当前口径那一组。
      // 标注 Omit<…, 'row_type'> 让 sort_by / 窗口字段名保持字面量类型
      // （计算属性键会拓宽成 string，不标注会报类型不兼容）。
      const w = BASIS_WINDOW[p.basis];
      const windowParams: Omit<UnionListParams, 'row_type'> = {
        [w.from]: p.date,
        [w.to]: p.date,
        sort_by: w.sortBy,
      };
      return partListResultSchema.parse(
        await listUnionItems({
          row_type: 'PART_FLAT',
          statuses: p.statuses,
          ...windowParams,
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

  // 派生：
  //   - data：partSchema 的 z.infer 与 PartListItem 已直接对齐，无需强转；
  //   - total：服务端匹配总数（不受 limit 截断影响），头部件数按它渲染；
  //   - isPending / error 派生让 caller 模板里写 isPending.value 即可。
  const data = computed<PartListItem[]>(() => query.data.value?.items ?? []);
  const total = computed<number>(() => query.data.value?.total ?? 0);
  const isPending = computed<boolean>(() => query.isPending.value);
  const error = computed<Error | null>(() => query.error.value);

  // 错误桥接：watch(query.error) → ElMessage.error。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '交期明细加载失败');
  });

  return {
    data,
    total,
    isPending,
    error,
    refetch: () => query.refetch(),
  };
}
