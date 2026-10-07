// src/views/outsource/composables/useOutsourceSentPartsQuery.ts
//
// 2026-10-09 新增：外协对账页的主查询 query hook
// （`GET /api/v2/outsource-companies/{id}/sent-parts`）。无自有状态，形态照
// `useOutsourceCompaniesQuery`（同域 query hook 拆法，见 CLAUDE.md「主查询外提成域内
// query hook」）。
//
// 2026-10-09 契约对齐：信封带 `outsource_company_name`，页头公司名改读这里 —— 对账页
// 原先要**额外发一次** `GET /outsource-companies/{id}` 才能渲染标题，那个调用本轮删除。
//
// 设计要点：
//   - reactive params 范式：params 里含 company_id + 全部筛选，`queryKey =
//     computed(() => qk.outsourceSentParts({ companyId, filters }))`；
//   - queryFn **从 queryKey 读** companyId 与 filters（键是唯一真相源）；
//   - `enabled: computed(() => !!toValue(params)?.company_id)` 闸门 + queryFn 内二次守卫
//     （防显式 refetch 绕过闸门时打出 `/outsource-companies//sent-parts` 空路径）；
//   - queryFn 走 `outsourceSentPartListResultSchema.parse(...)` 守门；
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { listCompanySentParts, type ListOutsourceSentPartsParams } from '@/api/outsource';
import { qk } from '@/composables/queries/keys';
import { outsourceSentPartListResultSchema } from './outsourceListSchema';

/** 对账页的请求参数：公司 id 走路径，其余筛选进 query 对象。 */
export interface OutsourceSentPartsQueryParams extends ListOutsourceSentPartsParams {
  /** 路径上的公司雪花 ID；空串 / undefined ⇒ `enabled=false`，零请求。 */
  company_id?: string;
}

export interface OutsourceSentPartsQueryOptions {
  params: MaybeRefOrGetter<OutsourceSentPartsQueryParams>;
  /** 闸门（restoreState() 末尾开闸，避免默认参数首屏 + 持久化参数再屏双 fetch）。 */
  enabled: MaybeRefOrGetter<boolean>;
}

export function useOutsourceSentPartsQuery(options: OutsourceSentPartsQueryOptions) {
  const queryKey = computed(() => {
    const p = toValue(options.params) ?? {};
    // company_id 从 params 里摘出来单独占键位（qk 内已分键位），余下的是筛选维度。
    const { company_id: companyId, ...filters } = p;
    return qk.outsourceSentParts({ companyId: companyId ?? '', filters });
  });

  const query = useQuery({
    queryKey,
    queryFn: async ({ queryKey }) => {
      // 从 queryKey 读（reactive params 范式），不闭包捕获 stale 值。
      const companyId = queryKey[2] as string;
      const filters = queryKey[3] as ListOutsourceSentPartsParams;
      // enabled=false 已挡；留二次守卫防 queryFn 被显式 refetch 时仍打空路径请求。
      if (!companyId) throw new Error('company_id required');
      return outsourceSentPartListResultSchema.parse(
        await listCompanySentParts(companyId, filters),
      );
    },
    enabled: computed(() => toValue(options.enabled) && !!toValue(options.params)?.company_id),
    placeholderData: keepPreviousData,
  });

  /** fetchList 别名 = refetch 的 async 包装（视图「刷新」按钮 / 行内编辑保存后 / 测试驱动）。 */
  async function fetchList(): Promise<void> {
    await query.refetch();
  }

  watch(query.error, (e) => {
    if (e) ElMessage.error(e.message ?? '外协对账列表加载失败');
  });

  return {
    query,
    data: query.data,
    isFetching: query.isFetching,
    error: query.error,
    fetchList,
  };
}

/** 失效整个对账域（**前缀全失效**，任意 companyId / params 形态都命中）。
 *
 *  调用点：行内 `reconcile-update` 的 onSuccess。前缀而非精确键：行编辑改的是
 *  单价 / 数量 / 对账标记与 total_price，而前端就地回填过渡值、下一次取数以后端为准
 *  ⇒ 一律全失效拿权威值，不用在 mutation 回调里复述哪几个字段会变。 */
export function invalidateOutsourceSentPartsAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.outsourceSentPartsPrefix }).then(() => undefined);
}