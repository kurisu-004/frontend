// src/views/outsource/composables/useOutsourceCompaniesQuery.ts
//
// 2026-10-09 新增：外协公司一览页的主查询 query hook（`GET /api/v2/outsource-companies`）。
// 无自有状态 —— 入参全 reactive（MaybeRefOrGetter），页面持全部私有状态（分页 / 筛选
// 输入态-生效态拆分 / 对话框态 / enabled 闸门 / mutation 与失效），只把汇好的 params
// 递进来。与守它的 `outsourceListSchema.ts` 同居域内（同 `useInspectionQueueQuery` 的
// 拆法，见 CLAUDE.md「主查询外提成域内 query hook」）。
//
// 设计要点：
//   - reactive params 范式：`queryKey = computed(() => qk.outsourceCompanies(toValue(params)))`，
//     queryFn **从 queryKey[2] 读 params**（键是唯一真相源），不闭包捕获 stale 值；
//   - `enabled` 闸门由调用方控制（store 在 restoreState() 末尾开闸，避免
//     「默认参数首屏 + 持久化参数再屏」双 fetch）；
//   - queryFn 走 `outsourceCompanyListResultSchema.parse(...)` 守门；
//   - staleTime / gcTime 走 main.ts 全局默认（页面级列表，不设）；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listOutsourceCompanies, type ListOutsourceCompaniesParams } from '@/api/outsource';
import { qk } from '@/composables/queries/keys';
import { outsourceCompanyListResultSchema } from './outsourceListSchema';

export interface OutsourceCompaniesQueryOptions {
  /** 请求参数（筛选 + 分页汇成的那一份），直接进 queryKey。 */
  params: MaybeRefOrGetter<ListOutsourceCompaniesParams>;
  /** 闸门：false 时不发请求（store 在 restoreState() 末尾开闸）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

export function useOutsourceCompaniesQuery(options: OutsourceCompaniesQueryOptions) {
  const queryKey = computed(() => qk.outsourceCompanies(toValue(options.params)));

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // params 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const params = queryKey[2] as ListOutsourceCompaniesParams;
      return outsourceCompanyListResultSchema.parse(await listOutsourceCompanies(params));
    },
    enabled: computed(() => toValue(options.enabled)),
    // 切筛选 / 分页换的是 queryKey，不设它新键在响应到达前 data 为 undefined，整表清空。
    placeholderData: keepPreviousData,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 写后刷新 / 测试驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  // 错误桥接：useQuery 的 error 不在 setup 抛错（CLAUDE.md 硬约束）。
  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '外协公司列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}

/** 失效整个公司一览域（**前缀全失效**，任意 params 形态都命中）。
 *
 *  调用点：公司 create / update / soft-delete 三个 mutation 的 onSuccess。`process_ids`
 *  的整体替换会改 `t_outsource_company_process`，而公司名与勾选态都在同一份缓存里 ⇒
 *  精确失效必然漏。 */
export function invalidateOutsourceCompaniesAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.outsourceCompaniesPrefix }).then(() => undefined);
}