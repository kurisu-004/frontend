// composables/usePendingProgrammingList.ts
//
// PendingProgrammingList 视图的列表状态 + fetcher（T14）。
// 持有「业务状态」（search / autoRefresh / errorMsg）+ fetcher + restoreFilter；
// 分页状态（items / total / loading / pageSize）由 <PartListShell> 内部
// usePagedListQuery 持有，视图通过 listRef 拿到。
//
// 设计要点（2026-08-25）：
// - fetcher 闭包 self.search，固定 sort_by='PLANNED_DELIVERY_DATE' /
//   sort_dir='ASC'（与旧 PendingProgrammingList 行为一致）。
// - pageSize 持久化由 PartListShell 内部 useListStatePersist 收口（key =
//   `pending_programming_paged`）。
// - 本 composable 仅持久化 search / autoRefresh（key =
//   `pending_programming_filter`）。
// - autoRefresh 布尔持久化：onMounted 时视图读 autoRefresh 后再创建 timer。

import { reactive, ref, type Ref } from 'vue'
import { listPendingProgramming } from '@/api/parts'
import type { PartListItem } from '@/types/parts'
import {
  useListStatePersist,
} from '@/composables/useListFilterPersist'
import type { PageQueryParams, PageResult } from '@/composables/usePagedListQuery'

export interface UsePendingProgrammingListReturn {
  /** 视图 filter 输入（关键字 / 序列号） */
  search: { keyword: string; serialNo: string }
  /** 自动刷新开关（持久化）；timer 由视图自管 */
  autoRefresh: Ref<boolean>
  /** fetcher 内部 try/catch 后的错误信息 */
  errorMsg: Ref<string | null>
  /** 传给 <PartListShell :fetcher="fetcher"> */
  fetcher: (params: PageQueryParams) => Promise<PageResult<PartListItem>>
  /** onMounted 调用一次：从 localStorage 恢复 search / autoRefresh */
  restoreFilter: () => void
}

export function usePendingProgrammingList(): UsePendingProgrammingListReturn {
  const search = reactive({ keyword: '', serialNo: '' })
  const autoRefresh = ref(false)
  const errorMsg = ref<string | null>(null)

  async function fetcher(
    params: PageQueryParams,
  ): Promise<PageResult<PartListItem>> {
    errorMsg.value = null
    try {
      const resp = await listPendingProgramming({
        keyword: search.keyword.trim() || undefined,
        serial_no: search.serialNo.trim() || undefined,
        sort_by: 'PLANNED_DELIVERY_DATE',
        sort_dir: 'ASC',
        limit: params.pageSize,
        offset: (params.page - 1) * params.pageSize,
      })
      return { items: resp.items, total: resp.total }
    } catch (e) {
      errorMsg.value = (e as Error).message ?? '查询失败'
      return { items: [], total: 0 }
    }
  }

  // 持久化 search / autoRefresh（pageSize 由 PartListShell 单独持久化）
  const { restore } = useListStatePersist(
    'pending_programming_filter',
    { search, autoRefresh },
    { exclude: new Set(['page']) },
  )

  function restoreFilter(): void {
    const s = restore() as
      | { search?: Partial<typeof search>; autoRefresh?: boolean }
      | null
    if (!s) return
    if (s.search) Object.assign(search, s.search)
    if (typeof s.autoRefresh === 'boolean') {
      autoRefresh.value = s.autoRefresh
    }
  }

  return {
    search,
    autoRefresh,
    errorMsg,
    fetcher,
    restoreFilter,
  }
}
