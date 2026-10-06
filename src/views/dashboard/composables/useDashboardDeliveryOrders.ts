// dashboard「交期分桶柱状图按层点击抽屉」useQuery composable。
//
// 数据流：
//   1. 入参 reactive：{ date, statuses, basis } | null。仅在抽屉打开时 caller 传非 null
//      启用闸门；切层 / 切日期 / 切口径时 key 变化自动 refetch。
//   2. queryFn 调 fetchDeliveryOrders 按「日期 + 该层状态集合 + 口径」查工单明细。
//      两列交期恒同时返回（planned_delivery_date 是 NOT NULL 列），倒计列由抽屉按
//      当前口径自己选列渲染。
//   3. queryFn 走 deliveryOrderDetailOutSchema.parse(...) 守门。
//
// 设计要点：
//   - reactive params 范式：queryKey = computed(() => qk.dashboardDeliveryOrders(...))，
//     queryFn **从 queryKey 读 params**，不闭包捕获 stale 值。
//   - enabled 闸门：params 为 null（抽屉未打开）或 statuses 为空数组时都不发请求。
//     statuses 为空是可防御的形态 —— 后端对空白 statuses 走 validation 40001，
//     前端直接不发比发一个必失败的请求更省一次 RTT 与一条 ElMessage.error。
//   - 失效键用**前缀**（qk.dashboardDeliveryOrdersPrefix）而非带 params 的精确键：
//     params 随用户切层 / 切日期 / 切口径不断变化，WS 事件到达时「需要重取」的是整个
//     delivery-orders 维度（此前挂载过、现已切走的那些查询同样过期）。
//   - 不设 placeholderData: keepPreviousData：抽屉是按需打开的下钻，换键瞬间清空表格
//     比把上一层的行挂在新层的标题下更安全（那个瞬间两者语义不同）。「共 N 件」由
//     调用方按 `!isPending && !error` 开关，pending 期不渲染计数。
//   - staleTime: 30_000：同 (date, statuses, basis) 命中缓存，避免来回切层 / 切日期 /
//     切口径时重复请求；gcTime: POSITIVE_INFINITY（会话级缓存，同 dashboard 域另两个
//     query，见 CLAUDE.md 认证一节）。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。
//   - 返回 { data, total, isPending, error, fetchList }：total 是服务端匹配总数、不受
//     items 截断影响，抽屉据此渲染「共 N 件」。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { fetchDeliveryOrders } from '@/api/dashboard';
import { qk } from '@/composables/queries/keys';
import type { OrderStatus } from '@/types/parts';
import type { DeliveryBasis } from '@/types/dashboard';
import {
  deliveryOrderDetailOutSchema,
  type DeliveryOrderDetailData,
} from './dashboardSnapshotSchema';
import { useDashboardInvalidation } from './useDashboardInvalidation';

/** 2026-10-07：入参形态。date = 当前口径下命中的交期日期（'YYYY-MM-DD'）；
 *  statuses = 该柱层覆盖的 OrderStatus 集合；basis = 交期统计口径。 */
interface DeliveryOrdersParams {
  date: string;
  statuses: OrderStatus[];
  basis: DeliveryBasis;
}

export function useDashboardDeliveryOrders(
  params: MaybeRefOrGetter<DeliveryOrdersParams | null>,
) {
  // WS 事件 → invalidate（沿 dashboard 域同形，共享 AFFECTS_DASHBOARD）。
  useDashboardInvalidation(qk.dashboardDeliveryOrdersPrefix);

  // queryKey 工厂参数：序列化 statuses 数组 + 带 basis，确保
  // (date, statuses, basis) 任意变化都触发 refetch。params 为 null 时给一个占位对象
  // 让键保持稳定（enabled 闸门已保证不会真的发请求）。
  const keyParams = computed<DeliveryOrdersParams>(() => {
    const p = toValue(params);
    return p ?? { date: '', statuses: [], basis: 'system' };
  });

  const queryKey = computed(() => qk.dashboardDeliveryOrders(keyParams.value));

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      // 从 queryKey 读最新 params（reactive params 范式），避免闭包捕获 stale。
      //
      // 2026-10-07 登记测试盲区：「从 queryKey 读」与「从 params 读」在当前键工厂的
      // 恒等映射下运行期等价，没有任何断言能区分两者。被断言真正守住的是两点 ——
      // (a) 不捕获 setup 期旧值（W4/W5）；(b) 请求参数与缓存键同源（W4b）。
      // 若将来键工厂引入归一化（排序 statuses / trim date —— TanStack hashKey 对数组
      // 顺序敏感），queryKey.value[2] 送的是归一化后的值、toValue(params) 送的是调用
      // 方原序的值，请求与缓存键就会分家，而上述用例全都不会红；届时需补一条能区分
      // 两个数据源的用例。
      return deliveryOrderDetailOutSchema.parse(await fetchDeliveryOrders(queryKey.value[2]));
    },
    enabled: computed(() => {
      const p = toValue(params);
      return !!p && p.statuses.length > 0;
    }),
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 派生：
  //   - rows：抽屉表格数据；
  //   - total：服务端匹配总数（不受 items 截断影响），头部件数按它渲染；
  //   - isPending / error 让 caller 模板里写 isPending.value / error.value 即可。
  const data = computed<DeliveryOrderDetailData[]>(() => query.data.value?.items ?? []);
  const total = computed<number>(() => query.data.value?.total ?? 0);
  const isPending = computed<boolean>(() => query.isPending.value);
  const error = computed<Error | null>(() => query.error.value);

  // fetchList 别名 = refetch 的 async 包装。
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：watch(query.error) → ElMessage.error。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '交期明细加载失败');
  });

  return { data, total, isPending, error, fetchList };
}
