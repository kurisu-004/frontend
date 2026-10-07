// src/views/com/delivery/composables/useDeliveryDraftsQuery.ts
//
// 扫码建单页「草稿看板」的两个 useQuery：
//   1) 当前 L1 下的 DRAFT 列表头（statuses=['DRAFT'], limit=200）；
//   2) 这些草稿的批量详情（`GET /com/delivery/note/batch-detail?ids=`）。
//
// 为什么是「列表 + 批量详情」两条而不是 N 条 getNote：列表端点不返 line_items，而详情
// 一次返全量行项；批量端点一次往返覆盖 N 张（限制 1..=200 项，与 limit=200 对齐）。
// 旧的裸实现逐张 getNote，是 N+1。
//
// 与详情页 hook 的差异：不设 keepPreviousData（同上，切换 L1 时留着上一家客户的草稿
// 更危险），批量详情的 ids 进 queryKey（换 L1 换 ids ⇒ 自动换缓存身份）。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { batchGetNotes, listNotes, type ListNotesParams } from '@/api/com/deliveryNote';
import { qk } from '@/composables/queries/keys';
import {
  deliveryNoteBatchDetailResultSchema,
  deliveryNoteListResultSchema,
} from './deliveryNoteSchema';

/** 草稿列表的固定查询参数：只看 DRAFT，上限 200（= batch-detail 的入参上限）。 */
export const DRAFT_BOARD_PARAMS: ListNotesParams = { statuses: ['DRAFT'], limit: 200 };

/** 草稿列表头。l1Id 为空串时闸门关掉（占位键）。 */
export function useDeliveryDraftsQuery(l1Id: MaybeRefOrGetter<string | null | undefined>) {
  const params = computed<ListNotesParams>(() => ({
    ...DRAFT_BOARD_PARAMS,
    customer_id: toValue(l1Id) || undefined,
  }));
  const queryKey = computed(() => qk.deliveryNotesList(params.value));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      const p = queryKey[2] as ListNotesParams;
      if (!p.customer_id) throw new Error('缺少一级客户 id');
      return deliveryNoteListResultSchema.parse(await listNotes(p));
    },
    enabled: computed(() => Boolean(toValue(l1Id))),
  });

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '加载草稿列表失败');
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error };
}

/** 草稿的批量详情（ids 由列表头派生）。ids 为空数组时闸门关掉。
 *
 *  ⚠️ data 是**数组**（`DeliveryNoteDetailData[]`），不是 `{ items }` 信封 ——
 *  api 层 `batchGetNotes` 已解信封，见 queryFn 内的注释（2026-10-08 修）。 */
export function useDeliveryDraftsDetailQuery(
  ids: MaybeRefOrGetter<readonly string[]>,
) {
  const key = computed(() => (toValue(ids) ?? []).map(String));
  const queryKey = computed(() => qk.deliveryNotesBatchDetail(key.value));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      const list = queryKey[2] as string[];
      // batchGetNotes([]) 短路返回 []，但仍走一次网络没有意义 —— 闸门外二次守卫。
      if (list.length === 0) return [];
      // ⚠️ `batchGetNotes` 在 api 层**已经解了信封**（`return resp.data.items`）⇒ 它给
      // 的是数组；`deliveryNoteBatchDetailResultSchema` 是 `{ items: [...] }` 形状。
      // 直接 `parse(数组)` 会抛 `expected object, received array` ⇒ query 恒 error
      // ⇒ 草稿看板的行项表恒空 + 每次查询一条 ElMessage.error（2026-10-08 修）。
      const items = await batchGetNotes(list);
      return deliveryNoteBatchDetailResultSchema.parse({ items }).items;
    },
    enabled: computed(() => key.value.length > 0),
  });

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '加载草稿详情失败');
  });

  return { query, data: query.data, isFetching: query.isFetching, error: query.error };
}
