// composables/useOutsourceQuoteTable.ts
//
// 2026-08-25 T13：从 OutsourceQuoteList.vue 抽出：报价一览表格状态 + 筛选 + 分页 + 排序。
//
// 职责：
// - search reactive（keyword / statuses / customerId）+ 状态列 / 客户列 popover 状态
//   + 持久化（localStorage URL 优先级）
// - sort / pageSize / pagedRef
// - URL ?statuses= 注入、角色默认 statuses
// - buildParams / fetcher / refresh / onSearch / onReset / onSortChange
// - 列头 popover（statuses / customer）的 draft + confirm / reset 交互
// - 列可见性定义 + 行类名（加急红底 + 点击 cursor）
//
// 不持有：
// - customers / companies / processes / parts（页级共享 lookup，由 shell 装载并下传）
// - 创建 / 审批 dialog（useOutsourceQuoteForm 持有）
// - 图纸预览状态（由 drawingPreview 子组件 / composable 持有；当前留在 shell）

import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listOutsourceQuotes } from '@/api/outsource'
import { useColumnVisibility } from '@/composables/useColumnVisibility'
import { useListStatePersist } from '@/composables/useListFilterPersist'
import {
  OUTSOURCE_QUOTE_STATUS_LABEL,
  type OutsourceQuote,
  type OutsourceQuoteStatus,
} from '@/types/outsource'
import {
  canApprove,
  canEdit,
  canReject,
  canSoftDelete,
  rolesArrayToMap,
} from '@/utils/outsourceQuotePermissions'
import type { ComputedRef } from 'vue'

/** 报价列表有效筛选状态（不含 legacy 数据状态） */
export const ACTIVE_QUOTE_STATUSES: OutsourceQuoteStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
]

export interface QuoteSearchState {
  keyword: string
  statuses: OutsourceQuoteStatus[]
  customerId: string
}

export function initialQuoteSearch(): QuoteSearchState {
  return { keyword: '', statuses: [], customerId: '' }
}

export const STATUS_OPTIONS: { value: OutsourceQuoteStatus; label: string }[] = (
  Object.entries(OUTSOURCE_QUOTE_STATUS_LABEL) as [OutsourceQuoteStatus, string][]
)
  .filter(([value]) => ACTIVE_QUOTE_STATUSES.includes(value))
  .map(([value, label]) => ({ value, label }))

export type QuoteSortKey = 'CREATED_AT' | 'PRICE' | 'REVIEWED_AT'

/** 列定义（操作列不放进 defs → 始终可见） */
export const QUOTE_COLUMN_DEFS = [
  { key: 'part_serial_no', label: '序列号' },
  { key: 'part_drawing_no', label: '图号' },
  { key: 'part_name', label: '名称' },
  { key: 'outsource_company_name', label: '外协公司' },
  { key: 'process_code', label: '工序' },
  { key: 'price', label: '外协报价' },
  { key: 'part_unit_price', label: '订单单价' },
  { key: 'status', label: '状态' },
  { key: 'customer', label: '客户' },
] as const

export const SORT_PROP_MAP: Record<string, QuoteSortKey> = {
  part_serial_no: 'CREATED_AT',
  part_drawing_no: 'CREATED_AT',
  part_name: 'CREATED_AT',
  outsource_company_name: 'CREATED_AT',
  process_code: 'CREATED_AT',
  price: 'PRICE',
  part_unit_price: 'CREATED_AT',
  customer_path: 'CREATED_AT',
}

/** 按角色注入默认 statuses */
export function defaultStatusesForRole(
  rm: ReturnType<typeof rolesArrayToMap>,
): OutsourceQuoteStatus[] {
  if (rm.MANAGER) return ['SUBMITTED']
  if (rm.CLERK) return ['DRAFT']
  return []
}

export interface UseOutsourceQuoteTableOptions {
  /** 角色 map（用于 defaultStatusesForRole） */
  roleMap: ComputedRef<ReturnType<typeof rolesArrayToMap>>
}

export function useOutsourceQuoteTable(opts: UseOutsourceQuoteTableOptions) {
  // ============ 筛选 / 排序 / 分页 状态 ============
  const search = reactive<QuoteSearchState>(initialQuoteSearch())

  const statusFilterActive = computed(() => search.statuses.length > 0)
  const customerFilterActive = computed(() => search.customerId !== '')

  // 状态列头 popover（draft + 确定/重置）
  const statusPopoverVisible = ref(false)
  const statusDraft = ref<OutsourceQuoteStatus[]>([])

  function syncStatusDraft(): void {
    statusDraft.value = [...search.statuses]
  }
  function resetStatusDraft(): void {
    statusDraft.value = []
    search.statuses = []
    statusPopoverVisible.value = false
    onSearch()
  }
  function confirmStatusFilter(): void {
    search.statuses = [...statusDraft.value]
    statusPopoverVisible.value = false
    onSearch()
  }

  // 客户列头 popover
  const customerPopoverVisible = ref(false)
  const customerDraft = ref<string | null>(null)

  function syncCustomerDraft(): void {
    customerDraft.value = search.customerId || null
  }
  function resetCustomerDraft(): void {
    customerDraft.value = null
    search.customerId = ''
    customerPopoverVisible.value = false
    onSearch()
  }
  function confirmCustomerFilter(): void {
    search.customerId = customerDraft.value ?? ''
    customerPopoverVisible.value = false
    onSearch()
  }

  // ============ 排序 / 分页 ============
  const sortBy = ref<QuoteSortKey>('CREATED_AT')
  const sortDir = ref<'ASC' | 'DESC'>('DESC')
  const pageSize = ref(20)
  const pagedRef = ref()
  // items 镜像：仅供 actionColumnHeight 计算按钮数（actionColumnHeight 是行级 computed
  // 显式读 items.value，所以 PagedTable.items 也通过 watch 同步到此）
  const items = ref<OutsourceQuote[]>([])
  const errorMsg = ref<string | null>(null)

  type SortOrder = 'ascending' | 'descending'
  const defaultSort = computed<{ prop: string; order: SortOrder }>(() => ({
    prop: 'part_serial_no',
    order: sortDir.value === 'ASC' ? 'ascending' : 'descending',
  }))

  const emptyText = computed(() => errorMsg.value ?? '暂无符合条件的报价')

  // ============ 持久化 ============
  // 优先级：URL ?statuses=  >  restore 快照  >  角色默认（DRAFT / SUBMITTED）
  const { restore: restoreQuoteFilter } = useListStatePersist(
    'outsource_quote_list',
    { search, sortBy, sortDir, pageSize },
    { exclude: new Set(['page']) },
  )

  // ============ 列可见性 ============
  const columnVisibility = useColumnVisibility(QUOTE_COLUMN_DEFS, {
    listKey: 'outsource_quote_list',
  })

  // ============ 行类名 + 操作列宽 ============
  function quoteRowClassName({ row }: { row: OutsourceQuote }): string {
    const cls = ['quote-row-clickable']
    if (row.is_urgent) cls.push('row-urgent')
    return cls.join(' ')
  }

  /** 操作列自适应宽度：根据当前 items 中按钮数最多的行计算。
   *  每按钮约 76px（"提交审核" 4 字 + spacing），加 12px padding。
   *  默认 160px（无按钮 / 空列表时）防止抖动。 */
  const actionColumnWidth = computed(() => {
    const maxBtns = items.value.reduce((max, q) => {
      let n = 0
      if (canEdit(q, opts.roleMap.value)) n++
      if (canApprove(q, opts.roleMap.value)) n++
      if (canReject(q, opts.roleMap.value)) n++
      if (canSoftDelete(q, opts.roleMap.value)) n++
      return Math.max(max, n)
    }, 0)
    return Math.max(160, maxBtns * 76 + 12)
  })

  // ============ fetcher / 列表交互 ============
  function buildParams(params: { page: number; pageSize: number }) {
    return {
      keyword: search.keyword.trim() || undefined,
      statuses: search.statuses.length > 0 ? [...search.statuses] : undefined,
      customer_id: search.customerId || undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
    }
  }

  async function fetcher(params: {
    page: number
    pageSize: number
  }): Promise<{ items: OutsourceQuote[]; total: number }> {
    errorMsg.value = null
    try {
      const r = await listOutsourceQuotes(buildParams(params))
      items.value = r.items
      return { items: r.items, total: r.total }
    } catch (e) {
      const msg = (e as Error).message ?? '加载报价列表失败'
      errorMsg.value = msg
      items.value = []
      ElMessage.error(msg)
      throw e
    }
  }

  async function refresh(): Promise<void> {
    await pagedRef.value?.fetch()
  }

  const onSearch = (): void => {
    void pagedRef.value?.reset()
  }

  function onSortChange({
    prop,
    order,
  }: {
    prop: string | null
    order: 'ascending' | 'descending' | null
  }): void {
    if (!prop || !order) return
    sortBy.value = SORT_PROP_MAP[prop] ?? 'CREATED_AT'
    sortDir.value = order === 'ascending' ? 'ASC' : 'DESC'
    void refresh()
  }

  function onReset(): void {
    Object.assign(search, initialQuoteSearch())
    sortBy.value = 'CREATED_AT'
    sortDir.value = 'DESC'
    void pagedRef.value?.reset()
  }

  // ============ restore（onMounted 调一次；routeQueryStatuses 由 caller 从 useRoute 传入）============
  // 恢复优先级：
  //   1) URL ?statuses= 逗号分隔（如 ?statuses=DRAFT,SUBMITTED）—— 最高优先
  //   2) restore() 快照中的 statuses（用户上次手动选的）
  //   3) 角色默认（MANAGER→SUBMITTED / CLERK→DRAFT）
  function restore(routeQueryStatuses: unknown): void {
    const persisted = restoreQuoteFilter() as
      | {
          search?: Partial<QuoteSearchState>
          sortBy?: string
          sortDir?: string
          pageSize?: number
        }
      | null
      | undefined
    if (persisted) {
      if (persisted.search) Object.assign(search, persisted.search)
      if (typeof persisted.sortBy === 'string') sortBy.value = persisted.sortBy as QuoteSortKey
      if (typeof persisted.sortDir === 'string') sortDir.value = persisted.sortDir as 'ASC' | 'DESC'
      if (typeof persisted.pageSize === 'number' && pagedRef.value) {
        pagedRef.value!.pageSize.value = persisted.pageSize
      }
    }

    const urlStatuses = typeof routeQueryStatuses === 'string'
      ? routeQueryStatuses.split(',').filter((s): s is OutsourceQuoteStatus =>
          ACTIVE_QUOTE_STATUSES.includes(s as OutsourceQuoteStatus))
      : []
    if (urlStatuses.length > 0) {
      search.statuses = [...urlStatuses]
      statusDraft.value = [...urlStatuses]
    } else if (search.statuses.length === 0) {
      const defaults = defaultStatusesForRole(opts.roleMap.value)
      if (defaults.length > 0) {
        search.statuses = [...defaults]
        statusDraft.value = [...defaults]
      }
    } else {
      statusDraft.value = [...search.statuses]
    }
  }

  // ============ pageSize 双向同步（PagedTable.pageSize → 本地 pageSize 触发 persist 写盘）============
  function syncPageSizeFromPaged(): void {
    const s = pagedRef.value?.pageSize?.value
    if (typeof s === 'number') pageSize.value = s
  }

  // ============ items 镜像同步（actionColumnWidth 计算按钮数）============
  function syncItemsFromPaged(): void {
    const it = pagedRef.value?.items?.value
    items.value = (it ?? []) as OutsourceQuote[]
  }

  // ============ route 直接读由 caller 在 restore() 时传入（避免 composable 内 useRoute）============
  return {
    // state
    search,
    items,
    errorMsg,
    sortBy,
    sortDir,
    pageSize,
    pagedRef,
    // popover 状态
    statusFilterActive,
    customerFilterActive,
    statusPopoverVisible,
    statusDraft,
    customerPopoverVisible,
    customerDraft,
    // 派生
    defaultSort,
    emptyText,
    columnVisibility,
    actionColumnWidth,
    // handlers
    syncStatusDraft,
    resetStatusDraft,
    confirmStatusFilter,
    syncCustomerDraft,
    resetCustomerDraft,
    confirmCustomerFilter,
    buildParams,
    fetcher,
    refresh,
    onSearch,
    onSortChange,
    onReset,
    restore,
    syncPageSizeFromPaged,
    syncItemsFromPaged,
    quoteRowClassName,
  }
}