// src/views/com/delivery/composables/useDeliveryDriversQuery.ts
//
// 送货司机候选的 useQuery（无自有状态）。数据源：
// `GET /api/v2/com/delivery/drivers`（一条 JOIN 返全部在职 + 工种 code='送货司机' 的工人）。
//
// **常量键** `qk.deliveryDrivers`：端点不接 Query extractor（无分页、无筛选），键不随
// 任何筛选 / tab / 单据变化 ⇒ 打印对话框每次打开都命中同一份缓存（30s 窗口内零往返）。
//
// 写后失效：本域**零写点**（`t_worker` 由工人一览页维护，且司机的在职 / 工种变更并不
// 立刻影响「谁能当送货司机」这个候选集），按 CLAUDE.md「零写点域不做穷举失效」策略不挂
// 失效调用点，新鲜度由 30s 有限 staleTime 兜。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listDeliveryDrivers } from '@/api/com/deliveryNote';
import { qk } from '@/composables/queries/keys';
import { deliveryDriverListResultSchema } from './deliveryNoteSchema';

export function useDeliveryDriversQuery(enabled: MaybeRefOrGetter<boolean>) {
  const query = useQuery({
    queryKey: qk.deliveryDrivers(),
    queryFn: async () => deliveryDriverListResultSchema.parse(await listDeliveryDrivers()),
    enabled: computed(() => toValue(enabled)),
  });

  const drivers = computed(() => query.data.value?.items ?? []);

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '加载送货司机失败');
  });

  return { query, drivers, isFetching: query.isFetching, error: query.error };
}