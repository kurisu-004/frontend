// composables/usePagedListQuery.ts
//
// 通用分页 + 可选关键字 列表查询 composable（Task 7）。
// 把 el-pagination v-model + 搜索 keyword + fetch + loading 状态机收成一个 ref 组，
// 给 <PagedTable> 内部使用；view 侧不直接 import（brief 明确：usePagedListQuery
// 走 PagedTable 包装这一条路，不直接套到 view 上）。
//
// 设计要点（2026-08-25）：
// - fetcher 签名与 el-table / el-pagination 解耦：view 自己把 view 本地 search.* 揉进去，
//   返回 { items, total } 即可。view 仍维护自己的 search reactive（含 keyword 以外的
//   过滤项：statuses / customer_id / date range 等），keyword 参数为可选（view 不用就忽略）。
// - keyword 改变时 onSearch() 同时把 page 重置 1，pageSize 改变时同样；这是「搜了就要看第一页」
//   的标准语义。
// - reset() 把 page 回到 1 并清空 keyword，再 fetch；view 的 onReset() 只需要先清自己 search.*，
//   再调 pagedRef.value?.reset()。
// - fetch 失败时不抛（view 自行 try/catch），但 loading 永远会清掉。

import { ref, type Ref } from 'vue'

export interface PageResult<T> {
  items: T[]
  total: number
}

export interface PageQueryParams {
  page: number
  pageSize: number
  keyword?: string
}

export interface UsePagedListQueryReturn<T> {
  items: Ref<T[]>
  total: Ref<number>
  loading: Ref<boolean>
  page: Ref<number>
  pageSize: Ref<number>
  keyword: Ref<string>
  fetch: () => Promise<void>
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onSearch: (k: string) => void
  reset: () => Promise<void>
}

/**
 * 通用分页查询 composable。
 *
 * @param fetcher 接收 { page, pageSize, keyword? }，返回 { items, total }。
 *                keyword 是可选的——view 没有独立搜索框就可以忽略。
 */
export function usePagedListQuery<T>(
  fetcher: (params: PageQueryParams) => Promise<PageResult<T>>,
): UsePagedListQueryReturn<T> {
  const items = ref<T[]>([]) as Ref<T[]>
  const total = ref(0)
  const loading = ref(false)
  const page = ref(1)
  const pageSize = ref(20)
  const keyword = ref('')

  async function fetch(): Promise<void> {
    loading.value = true
    try {
      const result = await fetcher({
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value || undefined,
      })
      items.value = result.items
      total.value = result.total
    } finally {
      loading.value = false
    }
  }

  function onPageChange(p: number): void {
    page.value = p
    void fetch()
  }

  function onPageSizeChange(s: number): void {
    page.value = 1
    pageSize.value = s
    void fetch()
  }

  function onSearch(k: string): void {
    page.value = 1
    keyword.value = k
    void fetch()
  }

  async function reset(): Promise<void> {
    page.value = 1
    keyword.value = ''
    await fetch()
  }

  return {
    items,
    total,
    loading,
    page,
    pageSize,
    keyword,
    fetch,
    onPageChange,
    onPageSizeChange,
    onSearch,
    reset,
  }
}
