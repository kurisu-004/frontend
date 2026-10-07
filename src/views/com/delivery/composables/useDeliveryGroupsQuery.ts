// src/views/com/delivery/composables/useDeliveryGroupsQuery.ts
//
// 扫码建单页「分组规则面板」的 useQuery（无自有状态）。数据源：
// `GET /api/v2/com/delivery/group?customer_id=`。
//
// 参数键（l1Id 进 queryKey）：端点按 L1 分片返回，切 L1 时必须换一份 cache identity，
// 否则面板会显示上一家客户的分组。l1Id 为空串时闸门关掉。
//
// 写后失效：`useDeliveryGroupsQuery` 的消费者（DeliveryNoteScan.vue 的分组
// create / update / delete）在成功后调 `invalidateDeliveryGroupsQuery(qc)`，见本文件末尾。
//
// 缓存时长：本 hook 与本域其余 query 一样**不设 staleTime**，走 main.ts 的全局默认
// （staleTime 0 ⇒ 每次挂载都后台重取），命中缓存只发生在「同一份 Query 实例存活期间」
// ——「按需分组面板」的兜底新鲜度靠显式 refetch，不是靠有限 staleTime。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listDeliveryGroups } from '@/api/com/deliveryGroup';
import { qk } from '@/composables/queries/keys';
import { deliveryGroupListResultSchema } from './deliveryGroupSchema';

import type { DeliveryGroupListResultData } from './deliveryGroupSchema';

/** 空分组视图（L1 未选 / 请求在途时用，避免模板到处判空）。 */
export const EMPTY_DELIVERY_GROUPS: DeliveryGroupListResultData = {
  groups: [],
  ungrouped_customers: [],
};

export function useDeliveryGroupsQuery(l1Id: MaybeRefOrGetter<string | null | undefined>) {
  const queryKey = computed(() => qk.deliveryGroupsList(toValue(l1Id) ?? ''));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      const id = queryKey[2] as string;
      if (!id) throw new Error('缺少一级客户 id');
      return deliveryGroupListResultSchema.parse(await listDeliveryGroups(id));
    },
    enabled: computed(() => Boolean(toValue(l1Id))),
  });

  const data = computed(() => query.data.value ?? EMPTY_DELIVERY_GROUPS);

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '加载分组规则失败');
  });

  return { query, data, isFetching: query.isFetching, error: query.error };
}

/** 失效整个送货分组域（写操作成功后调）。返回 Promise<void> 让 caller 可 await。 */
export function invalidateDeliveryGroupsQuery(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.deliveryGroupsPrefix }).then(() => undefined);
}