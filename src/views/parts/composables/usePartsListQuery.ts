// views/parts/composables/usePartsListQuery.ts
//
// 2026-08-22 从 PartsList.vue 抽出：列表查询状态机（search/items/total/loading/sort/page）。
//
// 职责：
// - 持有 search reactive + items/total/loading/page/pageSize/sort refs；
// - buildParams / fetchList / onSearch / onReset / onSortChange / onPageSizeChange；
// - restoreState：URL ?status= 注入或 localStorage 恢复；
// - 横切 beforeSearch / afterFetch：供其他 composable（如 usePartsColumnFilters）在
//   fetch 前后插入逻辑（同步 draft / 调 snapshot / 恢复勾选等）。

import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ListPartsParams } from '@/api/parts'
import {
  ORDER_STATUS_LABEL,
  PART_SORT_KEY_SET,
  PART_SORT_PROP_MAP,
  type OrderStatus,
  type PartListItem,
  type PartRowTypeFilter,
  type PartSortKey,
  type SortDir,
} from '@/types/parts'
import { useListFilterPersist } from '@/composables/useListFilterPersist'

/** 搜索状态 shape（原 PartsList SearchState 改名 export）。 */
export interface PartsSearchState {
  keyword: string
  /** 2026-08-20：图号 / 名称独立筛选（替换旧 keyword 单一字段）。
   *  后端 ILIKE 子串包含；同时设两个 ⇒ AND 联合（drawing_no ILIKE AND name ILIKE）。 */
  drawingNo: string
  name: string
  orderNo: string
  /** 2026-07-31：序列号独立搜索（ILIKE 包含；装配件子序列号自动带出母装配件） */
  serialNo: string
  statuses: OrderStatus[]
  isUrgent: boolean | null
  customerId: string
  /** 2026-07-21 PR-F：请购日期区间（含端点；空串=无限制） */
  requestDateFrom: string
  requestDateTo: string
  /** 2026-07-22：计划交期区间（含端点；空串=无限制） */
  plannedDeliveryDateFrom: string
  plannedDeliveryDateTo: string
  /** 2026-07-21 PR-F：系统交期区间（含端点；空串=无限制） */
  systemDeliveryDateFrom: string
  systemDeliveryDateTo: string
  /**
   * 2026-08-11：订单号空白筛选。
   * - true  ⇒ 仅空白（NULL OR ''），覆盖 order_no 子串搜索
   * - undefined ⇒ 任意（cleanParams 不发送该字段）
   */
  orderNoIsNull: boolean | undefined
  /**
   * 2026-08-11：系统交期空白筛选。
   * - true  ⇒ 仅空白（NULL），区间失效
   * - undefined ⇒ 任意（cleanParams 不发送该字段）
   */
  systemDeliveryDateIsNull: boolean | undefined
  /** 2026-08-01：下一道工序 id 多选（雪花 ID 字符串；空数组=全部） */
  nextProcessIds: string[]
  /** 2026-08-01：物理位置大类多选（OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY；空数组=全部） */
  locations: string[]
  /** 2026-08-05：物理位置具体 holder 多选（货架/工人/外协公司 雪花 ID 字符串；与 `locations` 是 OR 关系；空数组=全部） */
  holderIds: string[]
  /** 2026-08-05：行类型筛选（ALL=全部/PART=仅零件/ASSEMBLY=仅装配件） */
  rowType: PartRowTypeFilter
}

/** 构造 search 初值（保留 CNC 编程员默认值）。 */
export function initialPartsSearch(isCncProgrammer: boolean): PartsSearchState {
  return {
    keyword: '',
    drawingNo: '',
    name: '',
    orderNo: '',
    serialNo: '',
    statuses: isCncProgrammer
      ? ['PROGRAMMING']
      : ['IN_PROCESS', 'REPAIRING'],
    isUrgent: null,
    customerId: '',
    requestDateFrom: '',
    requestDateTo: '',
    plannedDeliveryDateFrom: '',
    plannedDeliveryDateTo: '',
    systemDeliveryDateFrom: '',
    systemDeliveryDateTo: '',
    orderNoIsNull: undefined,  // 2026-08-11
    systemDeliveryDateIsNull: undefined,  // 2026-08-11
    nextProcessIds: [],
    locations: [],
    holderIds: [],
    rowType: 'ALL',
  }
}

export interface UsePartsListQueryOptions {
  isCncProgrammer: boolean
}

export function usePartsListQuery(opts: UsePartsListQueryOptions) {
  // ============ 状态 ============
  const search = reactive<PartsSearchState>(initialPartsSearch(opts.isCncProgrammer))
  const items = ref<PartListItem[]>([])
  const total = ref(0)
  const loading = ref(false)
  const errorMsg = ref<string | null>(null)
  const page = ref(1)
  const pageSize = ref(20)
  const sortBy = ref<PartSortKey>('PLANNED_DELIVERY_DATE')
  const sortDir = ref<SortDir>('ASC')

  // ============ 横切钩子 ============
  // 其他 composable 通过 register* 注入 fetch 前后的逻辑。
  // 例如：usePartsColumnFilters 在 confirm 后需要在 fetch 前同步 draft
  // （扫码场景），usePartBatchSelection 在 fetch 后需要 nextTick 恢复勾选。
  let beforeSearch: (() => void) | null = null
  let afterFetch: (() => void) | null = null
  // 2026-08-23：resetAllFilters 用 —— PartsTable 注册一个调 el-table.clearFilter
  // 的回调，让 query 能在不持有 tableRef 的情况下清掉原生筛选列的勾选态。
  let clearNativeFilters: (() => void) | null = null

  function registerBeforeSearch(fn: () => void): void {
    beforeSearch = fn
  }
  function registerAfterFetch(fn: () => void): void {
    afterFetch = fn
  }
  function registerClearNativeFilters(fn: () => void): void {
    clearNativeFilters = fn
  }

  // ============ 派生 ============
  const statusOptions: { value: OrderStatus; label: string }[] = (
    Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]
  ).map((v) => ({ value: v, label: ORDER_STATUS_LABEL[v] }))

  // 2026-08-06 bugfix：装配件位置类筛选切换时 el-table remount key。
  // Element Plus 2.14 el-table 的 lazy tree 把「已加载子件」按 row-key 缓存在内部
  // lazyTreeNodeMap；items 整体替换（filter 切换）不会清空该缓存，导致已展开装配件
  // 仍展示上一次筛选的命中子件。给 ResponsiveList 加 :key 让这四个影响子件显示的
  // 筛选变化时整体 remount，强制走 loadChildren 拿到当前 matched_children。
  // 不含 keyword/排序/状态/日期等不影响子件显示的筛选 —— 保留滚动位置与排序高亮。
  const tableKey = computed(
    () =>
      [
        search.locations.join(','),
        search.holderIds.join(','),
        search.nextProcessIds.join(','),
        search.rowType,
      ].join('|'),
  )

  type SortOrder = 'ascending' | 'descending'
  const defaultSort = computed<{ prop: string; order: SortOrder }>(() => ({
    prop: PART_SORT_PROP_MAP[sortBy.value]
      ? Object.entries(PART_SORT_PROP_MAP).find(([, k]) => k === sortBy.value)![0]
      : 'planned_delivery_date',
    order: sortDir.value === 'ASC' ? 'ascending' : 'descending',
  }))

  const emptyText = computed(() => errorMsg.value ?? '暂无符合条件的零件')

  // ============ 持久化 ============
  // 2026-08-22：clearPartsFilter 在 PartsList 旧代码里解构了 clear 但从未调用，是死代码
  // （已 grep 确认模板/逻辑均未引用），此处不导出 clear。
  const { restore: restoreStatePersist, snapshot: snapshotPersist } =
    useListFilterPersist<PartsSearchState>(
      'parts_list_filter',
      { search, sortBy, sortDir, pageSize },
    )

  // ============ buildParams / fetchList ============
  function buildParams(): ListPartsParams {
    return {
      customer_id: search.customerId || undefined,
      statuses: search.statuses.length > 0 ? search.statuses : undefined,
      is_urgent: search.isUrgent ?? undefined,
      // 2026-08-20：图号 / 名称拆为两个独立 ILIKE 子串参数；同时设 ⇒ AND 联合。
      drawing_no: search.drawingNo.trim() || undefined,
      name: search.name.trim() || undefined,
      // 2026-08-20：keyword 字段由 /parts 已弃用；保留 search.keyword 是为了兼容
      // useListFilterPersist 旧快照与潜在外部 caller（不发送到后端）。
      // keyword: search.keyword.trim() || undefined,
      order_no: search.orderNo.trim() || undefined,
      // 2026-07-31：序列号独立搜索（ILIKE 包含；装配件子序列号自动带出母装配件）
      serial_no: search.serialNo.trim() || undefined,
      request_date_from: search.requestDateFrom || undefined,
      request_date_to: search.requestDateTo || undefined,
      planned_delivery_date_from: search.plannedDeliveryDateFrom || undefined,
      planned_delivery_date_to: search.plannedDeliveryDateTo || undefined,
      system_delivery_date_from: search.systemDeliveryDateFrom || undefined,
      system_delivery_date_to: search.systemDeliveryDateTo || undefined,
      // 2026-08-11：可空列空白筛选。`=== true` 守卫：未勾选（undefined）不发参数，
      // 由 cleanParams 自然 strip；显式发送 true/false 仅在 UI 真勾选/显式 false 时。
      order_no_is_null: search.orderNoIsNull === true ? true : undefined,
      system_delivery_date_is_null:
        search.systemDeliveryDateIsNull === true ? true : undefined,
      // 2026-08-05：下一道工序 / 物理位置多选筛选。
      // 雪花 ID 一律以字符串直接传给后端（CLAUDE.md §3）——禁止 Number()，
      // 否则 19 位 ID 在 JS Number（MAX_SAFE_INTEGER≈9.007e15）丢精度，IN 永不命中。
      // 空数组 = undefined（不发参数，保留现有清空过滤行为）。
      next_process_ids:
        search.nextProcessIds.length > 0 ? search.nextProcessIds : undefined,
      locations: search.locations.length > 0 ? search.locations : undefined,
      holder_ids: search.holderIds.length > 0 ? search.holderIds : undefined,
      row_type: search.rowType !== 'ALL' ? search.rowType : undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      include_assemblies: true,
    }
  }

  async function fetchList(): Promise<void> {
    loading.value = true
    errorMsg.value = null
    try {
      // 动态 import 避免循环依赖（parts.ts → http.ts → 业务模块）
      const { listParts } = await import('@/api/parts')
      const resp = await listParts(buildParams())
      items.value = resp.items
      total.value = resp.total
      // 批量模式下：剔除已不在当前页的失效勾选 + 恢复 UI（2026-07-22 跨页持久化）
      afterFetch?.()
    } catch (e) {
      items.value = []
      total.value = 0
      errorMsg.value = (e as Error).message ?? '查询失败'
      ElMessage.error(errorMsg.value)
    } finally {
      loading.value = false
    }
  }

  // ============ 事件处理 ============
  const onSearch = (): void => {
    page.value = 1
    beforeSearch?.()
    void fetchList()
  }

  // 2026-08-05：行类型切换——ALL↔PART/ASSEMBLY 视为筛选条件变化，复用 onSearch 入口
  // （清空批量选择 + fetchList）。
  function onRowTypeChange(): void {
    onSearch()
  }

  function onSortChange({
    prop,
    order,
  }: {
    prop: string | null
    order: 'ascending' | 'descending' | null
  }): void {
    if (!prop || !order) return
    sortBy.value = PART_SORT_PROP_MAP[prop] ?? 'PLANNED_DELIVERY_DATE'
    sortDir.value = order === 'ascending' ? 'ASC' : 'DESC'
    void fetchList()
  }

  function onPageSizeChange(size: number): void {
    pageSize.value = size
    page.value = 1
    void fetchList()
  }

  // 2026-07-29 PR-fix-0.2.0：重置只清两个查询框 + 三个日期区间 + 两个空白筛选，保留
  // status / customer popover 选择、排序、分页大小。表头排序、列过滤器不受重置影响。
  function onReset(): void {
    search.keyword = ''
    search.drawingNo = ''
    search.name = ''
    search.orderNo = ''
    search.serialNo = ''
    search.requestDateFrom = ''
    search.requestDateTo = ''
    search.plannedDeliveryDateFrom = ''
    search.plannedDeliveryDateTo = ''
    search.systemDeliveryDateFrom = ''
    search.systemDeliveryDateTo = ''
    // 2026-08-11：清空两个空白筛选 checkbox。
    search.orderNoIsNull = undefined
    search.systemDeliveryDateIsNull = undefined
    page.value = 1
    // 2026-07-31：重置按钮清空批量选择（与「改筛选即清空」语义一致）
    beforeSearch?.()
    // 写回 localStorage：保留 sortBy / sortDir / pageSize / statuses / isUrgent /
    // customerId，仅清空 keyword / orderNo / 三个日期区间 / 两个 isNull。
    // 下次刷新页面恢复的就是这种"半清空"状态。
    snapshotPersist()
    void fetchList()
  }

  // 2026-08-23：工具栏「重置筛选」一键清空 —— 与 onReset 的「半清空」相反：
  // 清掉全部列筛选项（文本/日期/isNull/status/客户/下一道工序/所在位置/holder），
  // 但保留 rowType / 排序 / 分页大小。原生筛选列（status / next_process）的
  // el-table 内部勾选态通过 clearNativeFilters 回调清掉，EP 会 emit filter-change
  // 让 onNativeFilterChange 把 search.statuses / isUrgent / nextProcessIds 同步清空。
  function resetAllFilters(): void {
    search.statuses = []
    search.isUrgent = null
    search.customerId = ''
    search.drawingNo = ''
    search.name = ''
    search.orderNo = ''
    search.orderNoIsNull = undefined
    search.serialNo = ''
    search.requestDateFrom = ''
    search.requestDateTo = ''
    search.plannedDeliveryDateFrom = ''
    search.plannedDeliveryDateTo = ''
    search.systemDeliveryDateFrom = ''
    search.systemDeliveryDateTo = ''
    search.systemDeliveryDateIsNull = undefined
    search.nextProcessIds = []
    search.locations = []
    search.holderIds = []
    // rowType / keyword 保留
    page.value = 1
    beforeSearch?.() // 清批量选择
    clearNativeFilters?.()
    snapshotPersist()
    void fetchList()
  }

  // ============ restoreState ============
  // 2026-08-22 拆分：onMounted 的恢复逻辑搬到这里，view 负责触发 fetchList 与 el-table sort()。
  // 优先级：URL ?status=PENDING 注入 > localStorage 恢复。
  function restoreState(queryStatus: unknown): void {
    if (typeof queryStatus === 'string' && queryStatus in ORDER_STATUS_LABEL) {
      search.statuses = [queryStatus as OrderStatus]
      return
    }
    const persisted = restoreStatePersist()
    if (!persisted) return

    search.keyword = persisted.search.keyword ?? search.keyword
    // 2026-08-20：drawingNo / name 旧快照缺失走 '' 兜底。
    search.drawingNo = persisted.search.drawingNo ?? search.drawingNo
    search.name = persisted.search.name ?? search.name
    search.orderNo = persisted.search.orderNo ?? search.orderNo
    // 2026-07-31：序列号独立搜索字段恢复
    search.serialNo = persisted.search.serialNo ?? search.serialNo
    search.statuses = Array.isArray(persisted.search.statuses)
      ? persisted.search.statuses
      : search.statuses
    search.isUrgent = persisted.search.isUrgent ?? search.isUrgent
    search.customerId = persisted.search.customerId ?? search.customerId
    search.requestDateFrom =
      persisted.search.requestDateFrom ?? search.requestDateFrom
    search.requestDateTo =
      persisted.search.requestDateTo ?? search.requestDateTo
    search.plannedDeliveryDateFrom =
      persisted.search.plannedDeliveryDateFrom
        ?? search.plannedDeliveryDateFrom
    search.plannedDeliveryDateTo =
      persisted.search.plannedDeliveryDateTo
        ?? search.plannedDeliveryDateTo
    search.systemDeliveryDateFrom =
      persisted.search.systemDeliveryDateFrom
        ?? search.systemDeliveryDateFrom
    search.systemDeliveryDateTo =
      persisted.search.systemDeliveryDateTo
        ?? search.systemDeliveryDateTo
    // 2026-08-01：下一道工序 / 物理位置多选恢复（lenient：旧快照缺字段=空数组）
    search.nextProcessIds = Array.isArray(persisted.search.nextProcessIds)
      ? persisted.search.nextProcessIds
      : []
    search.locations = Array.isArray(persisted.search.locations)
      ? persisted.search.locations
      : []
    // 2026-08-05：holder 叶子多选恢复（lenient：旧快照缺字段=空数组）
    search.holderIds = Array.isArray(persisted.search.holderIds)
      ? persisted.search.holderIds
      : []
    // 2026-08-05：行类型筛选恢复（合法值收敛，默认 ALL）
    search.rowType =
      persisted.search?.rowType === 'PART' || persisted.search?.rowType === 'ASSEMBLY'
        ? persisted.search.rowType
        : 'ALL'
    // localStorage 存的是 string，恢复时按合法值收敛（默认值兜底）
    sortBy.value = PART_SORT_KEY_SET.has(persisted.sortBy as PartSortKey)
      ? (persisted.sortBy as PartSortKey)
      : 'PLANNED_DELIVERY_DATE'
    sortDir.value = (persisted.sortDir === 'ASC' || persisted.sortDir === 'DESC'
      ? persisted.sortDir as SortDir
      : 'ASC')
    pageSize.value = persisted.pageSize
  }

  return {
    search,
    items,
    total,
    loading,
    errorMsg,
    page,
    pageSize,
    sortBy,
    sortDir,
    statusOptions,
    tableKey,
    defaultSort,
    emptyText,
    fetchList,
    onSearch,
    onReset,
    onRowTypeChange,
    onSortChange,
    onPageSizeChange,
    restoreState,
    snapshotPersist,
    registerBeforeSearch,
    registerAfterFetch,
    registerClearNativeFilters,
    resetAllFilters,
  }
}
