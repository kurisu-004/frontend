// composables/useInspectionList.ts
//
// InspectionPending 视图的列表状态 + fetcher（T14，T14p5 修正 fetch 错误回传）。
//
// 持有「业务状态」（search / plannedDateRange / autoRefresh）+ fetcher +
// restoreFilter；分页状态（items / total / loading / pageSize）由
// <PartListShell> 内部 usePagedListQuery 持有，视图通过 listRef 拿到。
//
// 设计要点（2026-08-25）：
// - fetcher 闭包 self.search / self.plannedDateRange，PartListShell 调用时只传
//   { page, pageSize }。fetch 抛出后由 PartListShell.safeFetcher 捕获并写到
//   内部 errorMsg ref，computed emptyText 显示给用户（T14p5）。
// - 早期版本 try/catch 内吞了 e 再 return { items: [], total: 0 }，导致
//   errorMsg 写给自己的 ref 但 shell 看不到，用户只能看到静态
//   "当前无待品检零件"。T14p5 改为「让 fetch 抛出」，把错误回传交给 shell 收口。
// - pageSize 持久化由 PartListShell 内部 useListStatePersist 收口（key =
//   `inspection_pending_paged`，与本 composable 的 filter 持久化互不冲突）。
// - 本 composable 仅持久化 search / autoRefresh（key =
//   `inspection_pending_filter`），plannedDateRange 跟随会话内（与旧 InspectionPending
//   行为一致：原本就没把 date range 进持久化）。
// - autoRefresh 布尔持久化：onMounted 时视图读 autoRefresh 后再创建 timer。

import { reactive, ref, type Ref } from 'vue'
import { listInspectionBatches, type PartItem } from '@/api/parts'
import {
  useListStatePersist,
} from '@/composables/useListFilterPersist'
import type { PageQueryParams, PageResult } from '@/composables/usePagedListQuery'

export interface UseInspectionListReturn {
  /** 视图 filter 输入（关键字 / 序列号） */
  search: { keyword: string; serialNo: string }
  /** 计划交期范围（datarange）；非持久化，遵循旧 InspectionPending 行为 */
  plannedDateRange: Ref<[string, string] | null>
  /** 自动刷新开关（持久化）；timer 由视图自管 */
  autoRefresh: Ref<boolean>
  /** 传给 <PartListShell :fetcher="fetcher">；fetch 失败抛错，由 shell.safeFetcher 接住 */
  fetcher: (params: PageQueryParams) => Promise<PageResult<PartItem>>
  /** onMounted 调用一次：从 localStorage 恢复 search / autoRefresh */
  restoreFilter: () => void
}

export function useInspectionList(): UseInspectionListReturn {
  const search = reactive({ keyword: '', serialNo: '' })
  const plannedDateRange = ref<[string, string] | null>(null)
  const autoRefresh = ref(false)

  async function fetcher(params: PageQueryParams): Promise<PageResult<PartItem>> {
    // fetch 抛错 → PartListShell.safeFetcher 接住并写到内部 errorMsg，
    // 用户在 el-table 空态能看到原始错误信息（区分「队列空」/「后端挂了」）。
    const resp = await listInspectionBatches({
      keyword: search.keyword.trim() || undefined,
      serial_no: search.serialNo.trim() || undefined,
      planned_delivery_date_from: plannedDateRange.value?.[0],
      planned_delivery_date_to: plannedDateRange.value?.[1],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    })
    return { items: resp.items, total: resp.total }
  }

  // 持久化 search / autoRefresh（pageSize 由 PartListShell 单独持久化）
  const { restore } = useListStatePersist(
    'inspection_pending_filter',
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
    plannedDateRange,
    autoRefresh,
    fetcher,
    restoreFilter,
  }
}
