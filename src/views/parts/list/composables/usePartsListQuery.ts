// views/parts/list/composables/usePartsListQuery.ts
//
// 2026-08-22 从 PartsList.vue 抽出：列表查询状态机（search/items/total/loading/sort/page）。
//
// 2026-09-26 重构（B 任务）：手写状态机 → TanStack Query。
//   - items / total / loading / errorMsg 派生自 useQuery.data / .isFetching / .error；
//   - fetchList 保留为 refetch 别名（外部调用方零改动）；
//   - beforeSearch / afterFetch 横切钩子语义保持：beforeSearch 在 onSearch 同步调，
//     afterFetch 由 watch(data, ..., { flush: 'post' }) 承接（DOM 更新后触发，
//     等价于原 fetchList 末尾 nextTick 恢复勾选时机）；
//   - enabled 闸门：restored 默认 false，restoreState 末尾置 true，**避免 store
//     实例化即自动 fetch**（与 A 任务 useCustomersQuery 不一样——A 任务所有 caller
//     都是 useCustomersQuery() 立即消费 data，本任务 caller 要等路由守卫 +
//     URL status + localStorage 恢复完后才允许 fetch，所以加闸门）。
//
// 职责：
// - 持有 search reactive + page/pageSize/sortBy/sortDir ref；
// - buildParams / fetchList / onSearch / onReset / onSortChange；
// - restoreState：URL ?status= 注入或 localStorage 恢复；
// - 横切 beforeSearch / afterFetch：供其他 composable（如 usePartBatchSelection）在
//   fetch 前后插入逻辑（同步 draft / 调 snapshot / 恢复勾选等）。

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { listParts } from '@/api/parts';
import type { ListPartsParams } from '@/api/parts';
import {
  ORDER_STATUS_LABEL,
  PART_SORT_KEY_SET,
  PART_SORT_PROP_MAP,
  type OrderStatus,
  type PartListItem,
  type PartRowTypeFilter,
  type PartSortKey,
  type SortDir,
} from '@/types/parts';
import { useListFilterPersist } from '@/composables/useListFilterPersist';
import { qk } from '@/composables/queries/keys';
import { partListResultSchema, type PartListResultSchema } from '@/composables/queries/schemas';

/** 搜索状态 shape（原 PartsList SearchState 改名 export）。 */
export interface PartsSearchState {
  keyword: string;
  /** 2026-08-20：图号 / 名称独立筛选（替换旧 keyword 单一字段）。
   *  后端 ILIKE 子串包含；同时设两个 ⇒ AND 联合（drawing_no ILIKE AND name ILIKE）。 */
  drawingNo: string;
  name: string;
  orderNo: string;
  /** 2026-07-31：序列号独立搜索（ILIKE 包含；装配件子序列号自动带出母装配件） */
  serialNo: string;
  statuses: OrderStatus[];
  isUrgent: boolean | null;
  customerId: string;
  /** 2026-07-21 PR-F：请购日期区间（含端点；空串=无限制） */
  requestDateFrom: string;
  requestDateTo: string;
  /** 2026-07-22：计划交期区间（含端点；空串=无限制） */
  plannedDeliveryDateFrom: string;
  plannedDeliveryDateTo: string;
  /** 2026-07-21 PR-F：系统交期区间（含端点；空串=无限制） */
  systemDeliveryDateFrom: string;
  systemDeliveryDateTo: string;
  /**
   * 2026-08-11：订单号空白筛选。
   * - true  ⇒ 仅空白（NULL OR ''），覆盖 order_no 子串搜索
   * - undefined ⇒ 任意（cleanParams 不发送该字段）
   */
  orderNoIsNull: boolean | undefined;
  /**
   * 2026-08-11：系统交期空白筛选。
   * - true  ⇒ 仅空白（NULL），区间失效
   * - undefined ⇒ 任意（cleanParams 不发送该字段）
   */
  systemDeliveryDateIsNull: boolean | undefined;
  /** 2026-08-01：物理位置大类多选（OFFICE/PRODUCTION_SHELF/WORKER/INSPECTION_SHELF/OUTSOURCE_COMPANY；空数组=全部） */
  locations: string[];
  /** 2026-08-05：物理位置具体 holder 多选（货架/工人/外协公司 雪花 ID 字符串；与 `locations` 是 OR 关系；空数组=全部） */
  holderIds: string[];
  /** 2026-08-05：行类型筛选（ALL=全部/PART=仅零件/ASSEMBLY=仅装配件） */
  rowType: PartRowTypeFilter;
}

/** 构造 search 初值（保留 CNC 编程员默认值）。 */
export function initialPartsSearch(isCncProgrammer: boolean): PartsSearchState {
  return {
    keyword: '',
    drawingNo: '',
    name: '',
    orderNo: '',
    serialNo: '',
    statuses: isCncProgrammer ? ['PROGRAMMING'] : ['IN_PROCESS', 'REPAIRING'],
    isUrgent: null,
    customerId: '',
    requestDateFrom: '',
    requestDateTo: '',
    plannedDeliveryDateFrom: '',
    plannedDeliveryDateTo: '',
    systemDeliveryDateFrom: '',
    systemDeliveryDateTo: '',
    orderNoIsNull: undefined, // 2026-08-11
    systemDeliveryDateIsNull: undefined, // 2026-08-11
    locations: [],
    holderIds: [],
    rowType: 'ALL',
  };
}

export interface UsePartsListQueryOptions {
  isCncProgrammer: boolean;
}

/** 2026-09-21 显式返回类型。2026-09-26（B 任务）改造：items/total/errorMsg 改为
 *  ComputedRef（派生自 useQuery.data / .error）；loading 仍是 Ref<boolean>
 *  （vue-query isFetching 已是 Ref）。 */
export interface UsePartsListQueryReturn {
  search: PartsSearchState;
  items: ComputedRef<PartListItem[]>;
  total: ComputedRef<number>;
  loading: Ref<boolean>;
  errorMsg: ComputedRef<string | null>;
  page: Ref<number>;
  pageSize: Ref<number>;
  sortBy: Ref<PartSortKey>;
  sortDir: Ref<SortDir>;
  statusOptions: { value: OrderStatus; label: string }[];
  tableKey: ComputedRef<string>;
  defaultSort: ComputedRef<{ prop: string; order: 'ascending' | 'descending' }>;
  emptyText: ComputedRef<string>;
  /** 2026-09-26（B 任务）：保留为 useQuery.refetch 的 async 包装——外部 caller
   *  （PartsList.vue 的 PurchaseOrderImportDialog.success、测试）零改动可用。 */
  fetchList: () => Promise<void>;
  onSearch: () => void;
  onReset: () => void;
  onRowTypeChange: () => void;
  onSortChange: (payload: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }) => void;
  restoreState: (queryStatus: unknown) => void;
  snapshotPersist: () => void;
  registerBeforeSearch: (fn: () => void) => void;
  registerAfterFetch: (fn: () => void) => void;
  registerClearNativeFilters: (fn: () => void) => void;
  resetAllFilters: () => void;
}

export function usePartsListQuery(opts: UsePartsListQueryOptions): UsePartsListQueryReturn {
  // ============ 状态 ============
  const search = reactive<PartsSearchState>(initialPartsSearch(opts.isCncProgrammer));
  const page = ref(1);
  const pageSize = ref(20);
  const sortBy = ref<PartSortKey>('PLANNED_DELIVERY_DATE');
  const sortDir = ref<SortDir>('ASC');

  // 2026-09-26（B 任务）enabled 闸门：restored 默认 false，restoreState 末尾置 true。
  // 用途：避免 store 实例化即自动 fetch——caller（PartsList onMounted）要先决定：
  //   - URL ?status= 注入 → 同步改 search.statuses，触发 queryKey 变化，enabled 一开
  //     就 fetch 一次（首屏带 status）；
  //   - localStorage 恢复 → 同理先改 search 后再开 enabled。
  // 不加闸门会让 store 构造时的默认 search 与开闸后的持久化 search 各 fetch 一次。
  const restored = ref(false);

  // ============ 横切钩子 ============
  // 其他 composable 通过 register* 注入 fetch 前后的逻辑。
  // 例如：usePartsColumnFilters 在 confirm 后需要在 fetch 前同步 draft
  // （扫码场景），usePartBatchSelection 在 fetch 后需要 nextTick 恢复勾选。
  let beforeSearch: (() => void) | null = null;
  let afterFetch: (() => void) | null = null;
  // 2026-08-23：resetAllFilters 用 —— PartsTable 注册一个调 el-table.clearFilter
  // 的回调，让 query 能在不持有 tableRef 的情况下清掉原生筛选列的勾选态。
  let clearNativeFilters: (() => void) | null = null;

  function registerBeforeSearch(fn: () => void): void {
    beforeSearch = fn;
  }
  function registerAfterFetch(fn: () => void): void {
    afterFetch = fn;
  }
  function registerClearNativeFilters(fn: () => void): void {
    clearNativeFilters = fn;
  }

  // ============ 派生 ============
  const statusOptions: { value: OrderStatus; label: string }[] = (
    Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]
  ).map((v) => ({ value: v, label: ORDER_STATUS_LABEL[v] }));

  // 2026-08-06 bugfix：装配件位置类筛选切换时 el-table remount key。
  // Element Plus 2.14 el-table 的 lazy tree 把「已加载子件」按 row-key 缓存在内部
  // lazyTreeNodeMap；items 整体替换（filter 切换）不会清空该缓存，导致已展开装配件
  // 仍展示上一次筛选的命中子件。给 ResponsiveList 加 :key 让这三个影响子件显示的
  // 筛选变化时整体 remount，强制走 loadChildren 拿到当前 matched_children。
  // 不含 keyword/排序/状态/日期等不影响子件显示的筛选 —— 保留滚动位置与排序高亮。
  //
  // 2026-09-27 前后端字段对齐：移除 search.nextProcessIds（原下一道工序筛选随
  // 「下一道工序」列一并删除），tableKey 减少一维。
  const tableKey = computed(() =>
    [
      search.locations.join(','),
      search.holderIds.join(','),
      search.rowType,
    ].join('|'),
  );

  type SortOrder = 'ascending' | 'descending';
  const defaultSort = computed<{ prop: string; order: SortOrder }>(() => ({
    prop: PART_SORT_PROP_MAP[sortBy.value]
      ? Object.entries(PART_SORT_PROP_MAP).find(([, k]) => k === sortBy.value)![0]
      : 'planned_delivery_date',
    order: sortDir.value === 'ASC' ? 'ascending' : 'descending',
  }));

  // ============ 持久化 ============
  // 2026-08-22：clearPartsFilter 在 PartsList 旧代码里解构了 clear 但从未调用，是死代码
  // （已 grep 确认模板/逻辑均未引用），此处不导出 clear。
  const { restore: restoreStatePersist, snapshot: snapshotPersist } =
    useListFilterPersist<PartsSearchState>('parts_list_filter', {
      search,
      sortBy,
      sortDir,
      pageSize,
    });

  // ============ buildParams ============
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
      system_delivery_date_is_null: search.systemDeliveryDateIsNull === true ? true : undefined,
      // 2026-08-05：下一道工序 / 物理位置多选筛选。
      // 雪花 ID 一律以字符串直接传给后端（CLAUDE.md §3）——禁止 Number()，
      // 否则 19 位 ID 在 JS Number（MAX_SAFE_INTEGER≈9.007e15）丢精度，IN 永不命中。
      // 空数组 = undefined（不发参数，保留现有清空过滤行为）。
      // 2026-09-17 PR-4：Array.isArray 防御性守卫——localStorage 反序列化 / 跨 caller
      // 注入 / type-only 引用解构等异常路径可能塞入非数组值；buildParams 必须
      // 兜底回 undefined，避免 axios paramsSerializer 抛 TypeError 或把非预期值
      // 发出去（holder_ids 混入非雪花 ID 字符串后端 parse 失败 → 40001）。
      locations:
        Array.isArray(search.locations) && search.locations.length > 0
          ? search.locations
          : undefined,
      holder_ids:
        Array.isArray(search.holderIds) && search.holderIds.length > 0
          ? search.holderIds
          : undefined,
      // 2026-09-27 前后端字段对齐：移除 next_process_ids 查询参数 —— 列表响应不再
      // 返 next_process_id，原生列筛选已删除。
      row_type: search.rowType !== 'ALL' ? search.rowType : undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      include_assemblies: true,
    };
  }

  // ============ 主查询 useQuery ============
  // 2026-09-26（B 任务）：listParts + Zod parse → useQuery。
  //   - queryKey 走 qk.partsList(buildParams())；buildParams 已经是 buildParams，
  //     useQuery 用 computed 包一层让响应式依赖（page / sort / search）变化时自动
  //     refetch（key 工厂内部不再包 computed —— 这里我们直接传 computed 给 queryKey，
  //     vue-query 支持）；
  //   - placeholderData: keepPreviousData —— 切页 / 改筛选时保留上一页 items，
  //     避免表格闪白屏（与原 fetchList 同步设 items 行为一致）；
  //   - enabled: restored —— 闸门（见上）；
  //   - queryFn 走 Zod parse 后强类型，响应包络 / 字段漂移会直接抛 ZodError；
  //   - fetchList 保留为 refetch 别名（见下）。
  const listQuery = useQuery<
    PartListResultSchema,
    Error,
    PartListResultSchema,
    ReturnType<typeof qk.partsList>
  >({
    queryKey: computed(() => qk.partsList(buildParams())),
    queryFn: async ({ queryKey }) => {
      const params = queryKey[2] as ListPartsParams;
      return partListResultSchema.parse(await listParts(params));
    },
    enabled: restored,
    placeholderData: keepPreviousData,
  });

  // ============ fetchList 别名 ============
  // 2026-09-26（B 任务）：保留 fetchList() => Promise<void> 签名作为 refetch 别名。
  // - PartsList.vue 的 PurchaseOrderImportDialog.success 调 store.query.fetchList；
  // - usePartInlineEdit / usePartDispatch 写操作成功后调 deps.fetchList 刷新；
  // - 测试用例 await q.fetchList() 驱动 listParts。
  // 全部走 refetch，不重新写 queryKey（refetch 用当前 queryKey，符合 caller 期望）。
  async function fetchList(): Promise<void> {
    await listQuery.refetch();
  }

  // ============ 派生：items / total / loading / errorMsg ============
  // 2026-09-26（B 任务）：全部派生自 listQuery。loading 仍走 isFetching（含初次 fetch
  // + 后续 refetch）；errorMsg 把 Error.message 字符串化。
  const items = computed<PartListItem[]>(() => {
    const data = listQuery.data.value;
    return data ? (data.items as PartListItem[]) : [];
  });
  const total = computed<number>(() => listQuery.data.value?.total ?? 0);
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });

  // ============ ElMessage 错误展示 ============
  // 2026-09-26（B 任务）：原 fetchList catch 里 ElMessage.error(errorMsg)。
  // 改造后由 watch(error) 触发；默认 watch 在 null→new Error 时会触发（vue-query 的
  // ref 切换可见）。
  watch(errorMsg, (msg) => {
    if (msg) ElMessage.error(msg);
  });

  // ============ afterFetch 钩子 ============
  // 2026-09-26（B 任务）：原 fetchList 末尾同步调 afterFetch() 恢复勾选。
  // 改造后用 watch(listQuery.data, ..., { flush: 'post' }) —— data 变化时 DOM
  // 更新后再触发，等价于原「fetch 完成 + restoreTableSelection 内部 nextTick」时机。
  watch(
    () => listQuery.data.value,
    () => {
      afterFetch?.();
    },
    { flush: 'post' },
  );

  // ============ 事件处理 ============
  const onSearch = (): void => {
    page.value = 1;
    beforeSearch?.();
  };

  // 2026-08-05：行类型切换——ALL↔PART/ASSEMBLY 视为筛选条件变化，复用 onSearch 入口
  // （清空批量选择 + fetchList）。
  function onRowTypeChange(): void {
    onSearch();
  }

  function onSortChange({
    prop,
    order,
  }: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }): void {
    if (!prop || !order) return;
    sortBy.value = PART_SORT_PROP_MAP[prop] ?? 'PLANNED_DELIVERY_DATE';
    sortDir.value = order === 'ascending' ? 'ASC' : 'DESC';
    // 2026-09-26（B 任务）：原 onSortChange 末尾 void fetchList()；现 queryKey
    // 变化自动 refetch（vue-query 内置），不再手动调。
  }

  // 2026-07-29 PR-fix-0.2.0：重置只清两个查询框 + 三个日期区间 + 两个空白筛选，保留
  // status / customer popover 选择、排序、分页大小。表头排序、列过滤器不受重置影响。
  function onReset(): void {
    search.keyword = '';
    search.drawingNo = '';
    search.name = '';
    search.orderNo = '';
    search.serialNo = '';
    search.requestDateFrom = '';
    search.requestDateTo = '';
    search.plannedDeliveryDateFrom = '';
    search.plannedDeliveryDateTo = '';
    search.systemDeliveryDateFrom = '';
    search.systemDeliveryDateTo = '';
    // 2026-08-11：清空两个空白筛选 checkbox。
    search.orderNoIsNull = undefined;
    search.systemDeliveryDateIsNull = undefined;
    page.value = 1;
    // 2026-07-31：重置按钮清空批量选择（与「改筛选即清空」语义一致）
    beforeSearch?.();
    // 写回 localStorage：保留 sortBy / sortDir / pageSize / statuses / isUrgent /
    // customerId，仅清空 keyword / orderNo / 三个日期区间 / 两个 isNull。
    // 下次刷新页面恢复的就是这种"半清空"状态。
    snapshotPersist();
  }

  // 2026-08-23：工具栏「重置筛选」一键清空 —— 与 onReset 的「半清空」相反：
  // 清掉全部列筛选项（文本/日期/isNull/status/客户/所在位置/holder），
  // 但保留 rowType / 排序 / 分页大小。原生筛选列（status）的
  // el-table 内部勾选态通过 clearNativeFilters 回调清掉，EP 会 emit filter-change
  // 让 onNativeFilterChange 把 search.statuses / isUrgent 同步清空。
  //
  // 2026-09-27 前后端字段对齐：移除 nextProcessIds 清空（下一道工序筛选随列一并删除）。
  function resetAllFilters(): void {
    search.statuses = [];
    search.isUrgent = null;
    search.customerId = '';
    search.drawingNo = '';
    search.name = '';
    search.orderNo = '';
    search.orderNoIsNull = undefined;
    search.serialNo = '';
    search.requestDateFrom = '';
    search.requestDateTo = '';
    search.plannedDeliveryDateFrom = '';
    search.plannedDeliveryDateTo = '';
    search.systemDeliveryDateFrom = '';
    search.systemDeliveryDateTo = '';
    search.systemDeliveryDateIsNull = undefined;
    search.locations = [];
    search.holderIds = [];
    // rowType / keyword 保留
    page.value = 1;
    beforeSearch?.(); // 清批量选择
    clearNativeFilters?.();
    snapshotPersist();
  }

  // ============ restoreState ============
  // 2026-08-22 拆分：onMounted 的恢复逻辑搬到这里，view 负责触发 fetchList 与 el-table sort()。
  // 优先级：URL ?status=PENDING 注入 > localStorage 恢复。
  // 2026-09-26（B 任务）：两条分支末尾都 restored = true（开闸），让 useQuery
  // 在 store 实例化时不会自动 fetch（避免「默认参数首屏 + 持久化参数再屏」双 fetch）。
  function restoreState(queryStatus: unknown): void {
    if (typeof queryStatus === 'string' && queryStatus in ORDER_STATUS_LABEL) {
      search.statuses = [queryStatus as OrderStatus];
      restored.value = true;
      return;
    }
    const persisted = restoreStatePersist();
    if (!persisted) {
      // 没有持久化快照：search / sort 走初始默认值，仅开闸让 useQuery 用默认参数 fetch
      restored.value = true;
      return;
    }

    search.keyword = persisted.search.keyword ?? search.keyword;
    // 2026-08-20：drawingNo / name 旧快照缺失走 '' 兜底。
    search.drawingNo = persisted.search.drawingNo ?? search.drawingNo;
    search.name = persisted.search.name ?? search.name;
    search.orderNo = persisted.search.orderNo ?? search.orderNo;
    // 2026-07-31：序列号独立搜索字段恢复
    search.serialNo = persisted.search.serialNo ?? search.serialNo;
    search.statuses = Array.isArray(persisted.search.statuses)
      ? persisted.search.statuses
      : search.statuses;
    search.isUrgent = persisted.search.isUrgent ?? search.isUrgent;
    search.customerId = persisted.search.customerId ?? search.customerId;
    search.requestDateFrom = persisted.search.requestDateFrom ?? search.requestDateFrom;
    search.requestDateTo = persisted.search.requestDateTo ?? search.requestDateTo;
    search.plannedDeliveryDateFrom =
      persisted.search.plannedDeliveryDateFrom ?? search.plannedDeliveryDateFrom;
    search.plannedDeliveryDateTo =
      persisted.search.plannedDeliveryDateTo ?? search.plannedDeliveryDateTo;
    search.systemDeliveryDateFrom =
      persisted.search.systemDeliveryDateFrom ?? search.systemDeliveryDateFrom;
    search.systemDeliveryDateTo =
      persisted.search.systemDeliveryDateTo ?? search.systemDeliveryDateTo;
    // 2026-08-01：物理位置多选恢复（lenient：旧快照缺字段=空数组）
    // 2026-09-27 前后端字段对齐：移除 nextProcessIds 恢复（原下一道工序筛选随列删除；
    // 旧 localStorage 快照中 nextProcessIds 字段残留无害 —— useListFilterPersist
    // 持久化的 search shape 现在不消费该字段，下次 snapshot 自然丢弃）。
    search.locations = Array.isArray(persisted.search.locations) ? persisted.search.locations : [];
    // 2026-08-05：holder 叶子多选恢复（lenient：旧快照缺字段=空数组）
    search.holderIds = Array.isArray(persisted.search.holderIds) ? persisted.search.holderIds : [];
    // 2026-08-05：行类型筛选恢复（合法值收敛，默认 ALL）
    search.rowType =
      persisted.search?.rowType === 'PART' || persisted.search?.rowType === 'ASSEMBLY'
        ? persisted.search.rowType
        : 'ALL';
    // localStorage 存的是 string，恢复时按合法值收敛（默认值兜底）
    sortBy.value = PART_SORT_KEY_SET.has(persisted.sortBy as PartSortKey)
      ? (persisted.sortBy as PartSortKey)
      : 'PLANNED_DELIVERY_DATE';
    sortDir.value =
      persisted.sortDir === 'ASC' || persisted.sortDir === 'DESC'
        ? (persisted.sortDir as SortDir)
        : 'ASC';
    pageSize.value = persisted.pageSize;
    // 持久化恢复完毕，开闸 → useQuery 触发首次 fetch
    restored.value = true;
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
    emptyText: computed(() => errorMsg.value ?? '暂无符合条件的零件'),
    fetchList,
    onSearch,
    onReset,
    onRowTypeChange,
    onSortChange,
    restoreState,
    snapshotPersist,
    registerBeforeSearch,
    registerAfterFetch,
    registerClearNativeFilters,
    resetAllFilters,
  };
}
