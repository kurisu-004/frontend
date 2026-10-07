// src/views/outsource/composables/useOutsourceQuotesQuery.ts
//
// 2026-10-09 新增：外协报价一览页的主查询 query hook（`GET /api/v2/outsource-quotes`）。
// 无自有状态，形态照 `useOutsourceCompaniesQuery`。
//
// 2026-10-09 契约对齐（两个入参维度的意义变了）：
//   - `statuses` **CSV 单值**：axum 的 `Query` 走 `serde_urlencoded`，其 `Part`
//     反序列化器不支持序列 ⇒ `Vec<String>` 字段只收 `?statuses=A%2CB` 形态（重复 key 与
//     括号键名都收不到值）。`src/api/http.ts` 的 `ARRAY_AS_CSV_KEYS` 已含 `'statuses'`，
//     调用点直接传数组即可，无需自己 join。
//     ⚠️ 此前这条筛选恒不生效：SQL 与 repo 两层早就支持，只有 DTO 少字段 + service 恒传
//     `&[]`，前端发的 `statuses[]=…` 被 serde **静默忽略**（不报错）—— 连角色的默认筛选
//     （MANAGER→SUBMITTED / CLERK→DRAFT）也没生效，而表头因 `active` 变蓝加粗、视觉上在
//     说「筛选已生效」。
//   - `keyword` 拆成 `drawing_no` / `name` 两个直连 ILIKE 字段（+ 新增 `is_urgent`）。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listOutsourceQuotes, type ListOutsourceQuotesParams } from '@/api/outsource';
import { qk } from '@/composables/queries/keys';
import { outsourceQuoteListResultSchema } from './outsourceListSchema';

export interface OutsourceQuotesQueryOptions {
  /** 请求参数（表头筛选 + 排序 + 分页汇成的那一份），直接进 queryKey。 */
  params: MaybeRefOrGetter<ListOutsourceQuotesParams>;
  /** 闸门：false 时不发请求（store 在 restoreState() 末尾开闸，避免双 fetch）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

export function useOutsourceQuotesQuery(options: OutsourceQuotesQueryOptions) {
  const queryKey = computed(() => qk.outsourceQuotes(toValue(options.params)));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListOutsourceQuotesParams;
      return outsourceQuoteListResultSchema.parse(await listOutsourceQuotes(params));
    },
    enabled: computed(() => toValue(options.enabled)),
    placeholderData: keepPreviousData,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 写后刷新 / 测试驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '外协报价列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}

/** 失效整个报价一览域（**前缀全失效**，任意 params 形态都命中）。
 *
 *  调用点：报价 create / submit / approve / reject / soft-delete 五个 mutation 的
 *  onSuccess —— 六条写路径里除 create 外都改 `status` / `version`，而列表的默认筛选就是
 *  按 `statuses` 过滤的：不失效的话，提交审核后那一行会从「待审核」集合里消失，用户
 *  以为操作丢了（实际是它正确地离开了当前筛选窗口）。 */
export function invalidateOutsourceQuotesAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.outsourceQuotesPrefix }).then(() => undefined);
}