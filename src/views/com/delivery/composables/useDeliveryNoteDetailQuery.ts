// src/views/com/delivery/composables/useDeliveryNoteDetailQuery.ts
//
// 送货单详情页的 useQuery 段（无自有状态）。数据源：
// `GET /api/v2/com/delivery/note/{id}`（api/com/deliveryNote.ts）。
//
// 与列表主查询的两点不同：
//   - **没有 params 对象**：入参就是一个 noteId 字符串，本身就是 queryKey 的一段。
//     仍走 reactive params 范式（`queryKey = computed(...)` + queryFn 从 queryKey 读），
//     这样切路由 id 时 queryKey 变化自动 refetch，不需要额外的 watch。
//   - **不设 placeholderData: keepPreviousData**：详情页一次返回全量 line_items，保留
//     上一个单据的详情会让用户在切换瞬间看到错的单号 + 错的行项（比清空更危险）。
//   - 闸门是「id 非空」而不是 store 的 restored 标志：详情页没有持久化筛选态，
//     store 形态与列表页不同，这里是纯读 hook。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { getNote } from '@/api/com/deliveryNote';
import { qk } from '@/composables/queries/keys';
import { deliveryNoteDetailSchema } from './deliveryNoteSchema';

export function useDeliveryNoteDetailQuery(noteId: MaybeRefOrGetter<string | null | undefined>) {
  const queryKey = computed(() => qk.deliveryNoteDetail(toValue(noteId) ?? ''));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // id 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const id = queryKey[2] as string;
      // 闸门外的二次守卫：enabled=false 时 queryFn 不会跑，但 placeholderData /
      // 手动 refetch 等路径仍可能进来，缺 id 时直接短路而不是打一个 /undefined 请求。
      if (!id) throw new Error('缺少送货单 id');
      return deliveryNoteDetailSchema.parse(await getNote(id));
    },
    enabled: computed(() => Boolean(toValue(noteId))),
  });

  /** fetchDetail 别名 = refetch 的 async 包装（详情页「刷新」与测试驱动）。 */
  async function fetchDetail(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '送货单详情加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchDetail,
  };
}