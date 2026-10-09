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
//
// 2026-10-10 新增 `isActive` 入参（可选，默认恒真）：本页被 keep-alive 缓存后，
// `noteId` 喂的是 vue-router 的**全局** currentRoute，切到别的页面时它照样变
// ⇒ reactive queryKey 跟着变 ⇒ 自动去 `GET /delivery-notes/{别的页面的 id}`。
// 后果比 404 更坏：若那个 id 恰好是另一张有效送货单，本页会**静默渲染成另一张单**。
// 传 `isActive`（入口按 `route.name` 判定）后，本页不活跃时 observer 的 enabled 转
// false，key 变化不再触发请求 —— 这条数据流是 computed → queryKey，没有 watcher
// 可挂守卫，只能在 `enabled` 侧收。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { getNote } from '@/api/com/deliveryNote';
import { qk } from '@/composables/queries/keys';
import { deliveryNoteDetailSchema } from './deliveryNoteSchema';

export function useDeliveryNoteDetailQuery(
  noteId: MaybeRefOrGetter<string | null | undefined>,
  /** 本页是否仍是当前路由（keep-alive 缓存页必需，见文件头注释）。省略 = 恒真。 */
  isActive: MaybeRefOrGetter<boolean> = true,
) {
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
    enabled: computed(() => Boolean(toValue(noteId)) && Boolean(toValue(isActive))),
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