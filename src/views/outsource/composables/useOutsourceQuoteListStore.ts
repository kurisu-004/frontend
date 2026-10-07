// src/views/outsource/composables/useOutsourceQuoteListStore.ts
//
// 2026-10-09 新建：外协报价一览页的 Pinia setup store，取代原先的
// `useOutsourceQuoteTable()` composable + `OutsourceQuoteTable.vue` 的 `:ctx` prop 传参
// 模式（子组件整包接收 composable 实例）。不变量与取舍见 `usePartsListStore` 文件头，
// 4 条照抄：首调在页面 setup / `onBeforeUnmount` 必须 `$dispose` / 消费侧禁止解构 /
// 不 import vue-router（URL `?statuses=` 由视图传入 restoreState）。
//
// 迁移到 store 的直接动机与待品检页同款：表头筛选要挂进 `ColumnDef.headerRender`，
// 而筛选状态与列定义必须同层；`:ctx` 模式让「谁持有状态」与「谁渲染表格」耦合在
// 一个 prop 里，第二张表格就得再传一次 ctx。
//
// 2026-10-09 契约对齐：状态筛选走 `statuses[]`（后端本轮才真正接线，此前恒不生效），
// 多选值由 api 层按 CSV 白名单序列（axum 的 `serde_urlencoded` 不支持序列）。

import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { ElMessage } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import { listOutsourceCompanies } from '@/api/outsource';
import { useAuthStore } from '@/stores/auth';
import { useCustomerTree } from '@/composables/useCustomerTree';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { rolesArrayToMap } from '@/utils/outsourceQuotePermissions';
import { buildOutsourceQuoteColumnDefs } from '../outsourceQuoteColumnDefs';
import type { OutsourceQuoteStatus } from '@/types/outsource';
import type { OutsourceQuoteSchema } from './outsourceListSchema';
import {
  makeNativeMultiFilter,
  useOutsourceColumnFilters,
  type OutsourceNativeMultiFilter,
} from './useOutsourceColumnFilters';
import { invalidateOutsourceQuotesAll, useOutsourceQuotesQuery } from './useOutsourceQuotesQuery';
import { quoteStatusFilterOptions } from './useOutsourceQuoteForm';

/** 报价列表的筛选白名单：四个活跃状态。legacy 值（OUTSOURCING / RECEIVED / BILLED /
 *  USED）没有操作按钮、选中也拿不到行，故不进候选集（见 `quoteStatusFilterOptions`）。 */
export const ACTIVE_QUOTE_STATUSES: OutsourceQuoteStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
];

/** 本页 search shape（表头筛选的唯一状态源）。 */
export interface OutsourceQuoteSearchState {
  /** `t_part.drawing_no` ILIKE 子串。 */
  drawing_no: string;
  /** `t_part.name` ILIKE 子串。 */
  name: string;
  /** `t_outsource_quote.outsource_company_id` 等值；空串 = 不筛。 */
  outsource_company_id: string;
  /** 客户子树根 id（后端展开成「自身 ∪ 直接子客户」）；空串 = 不筛。 */
  customerId: string;
  /** 报价状态多选。 */
  statuses: OutsourceQuoteStatus[];
}

function initialSearch(): OutsourceQuoteSearchState {
  return { drawing_no: '', name: '', outsource_company_id: '', customerId: '', statuses: [] };
}

/** 按角色注入默认 statuses（与「报价一览该看哪一档」的业务约定同源）。 */
export function defaultStatusesForRole(rm: ReturnType<typeof rolesArrayToMap>): OutsourceQuoteStatus[] {
  if (rm.MANAGER) return ['SUBMITTED'];
  if (rm.CLERK) return ['DRAFT'];
  return [];
}

export const useOutsourceQuoteListStore = defineStore('outsource-quote-list', () => {
  // ⚠️ 必须在 setup 第一行捕获（Pinia 不给 action wrapper / listener 注入上下文）。
  const qc = useQueryClient();
  // 消费侧禁止解构 store：auth.xxx 由 store proxy 自动解包。
  const auth = useAuthStore();
  const roleMap = computed(() => rolesArrayToMap(auth.user?.roles ?? []));

  // ============ 切片：search / 分页 / 排序 / 主查询 ============
  const search = reactive<OutsourceQuoteSearchState>(initialSearch());
  const page = ref(1);
  const pageSize = ref(20);
  const sortBy = ref<'CREATED_AT' | 'PRICE' | 'REVIEWED_AT'>('CREATED_AT');
  const sortDir = ref<'ASC' | 'DESC'>('DESC');
  // enabled 闸门：默认 false，restoreState() 末尾开闸（避免双 fetch）。
  const restored = ref(false);

  function buildParams() {
    return {
      drawing_no: search.drawing_no.trim() || undefined,
      name: search.name.trim() || undefined,
      outsource_company_id: search.outsource_company_id || undefined,
      customer_id: search.customerId || undefined,
      // 空数组交 api 层 cleanParams 剥掉（发空 statuses= 会命中后端「无匹配」分支）。
      statuses: search.statuses.length > 0 ? [...search.statuses] : undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  const listQuery = useOutsourceQuotesQuery({
    params: computed(() => buildParams()),
    enabled: restored,
  });
  const { fetchList } = listQuery;

  const items = computed<OutsourceQuoteSchema[]>(() => listQuery.data.value?.items ?? []);
  const total = computed<number>(() => Number(listQuery.data.value?.total ?? 0));
  const loading = listQuery.isFetching;
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '暂无符合条件的报价');

  function onSearch(): void {
    page.value = 1;
  }

  const defaultSort = computed<{ prop: string; order: 'ascending' | 'descending' }>(() => ({
    prop: 'part_serial_no',
    order: sortDir.value === 'ASC' ? 'ascending' : 'descending',
  }));

  function onSortChange({
    prop,
    order,
  }: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }): void {
    if (!prop || !order) return;
    sortBy.value = SORT_PROP_MAP[prop] ?? 'CREATED_AT';
    sortDir.value = order === 'ascending' ? 'ASC' : 'DESC';
    page.value = 1;
  }

  // ============ 切片：filters（表头筛选状态机）============
  const { makeTextFilter } = useOutsourceColumnFilters({ search, onSearch });
  const drawingNoFilter = makeTextFilter('drawing_no');
  const nameFilter = makeTextFilter('name');
  const companyFilter = makeTextFilter('outsource_company_id');
  const customerFilter = makeTextFilter('customerId');
  // 状态列走 EP 原生 `:filters`；候选集是四个活跃值（legacy 值无可操作行）。
  const statusNative = makeNativeMultiFilter(
    { search, onSearch },
    { key: 'statuses', options: quoteStatusFilterOptions(ACTIVE_QUOTE_STATUSES) },
  );
  const statusFilter: OutsourceNativeMultiFilter = statusNative.filter;

  function resetAllFilters(): void {
    drawingNoFilter.reset();
    nameFilter.reset();
    companyFilter.reset();
    customerFilter.reset();
    search.statuses = [];
    page.value = 1;
  }

  /** EP `filter-change` 只上报本次变更的那一列 ⇒ 逐列判断命中哪条翻译器。 */
  function onNativeFilterChange(payload: Record<string, string[]>): void {
    statusNative.applyNativeChange(payload);
  }

  // ============ 切片：options（客户树 / 外协公司下拉）============
  const { tree: customerTree } = useCustomerTree();

  /** 「外协公司」等值筛选的候选。后端该谓词是等值（不是 ILIKE），所以候选要一次性
   *  拉全量公司列表（limit 200 上限内），而不是按输入子串筛。 */
  async function loadCompanyOptions(): Promise<void> {
    companyOptions.value = [];
    try {
      const r = await listOutsourceCompanies({ limit: 200 });
      companyOptions.value = r.items.map((c) => ({ id: c.id, name: c.name }));
    } catch (e) {
      ElMessage.error((e as Error).message ?? '外协公司加载失败');
    }
  }
  const companyOptions = ref<Array<{ id: string; name: string }>>([]);

  // ============ 列定义 + 列可见性 ============
  // 图号点击 → 预览图纸的回调由**视图注入**（弹窗 / 导航不留在 store，不变量 #4）。
  let previewDrawing: (row: OutsourceQuoteSchema) => void = () => {};
  const columnDefs = buildOutsourceQuoteColumnDefs({
    drawingNoFilter,
    nameFilter,
    companyFilter,
    customerFilter,
    statusFilter,
    customerTree,
    companyOptions,
    onPreviewDrawing: (row) => previewDrawing(row),
  });
  const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'outsource_quote_list' });

  /** 视图 setup 内调一次，注入「图号点击 → 预览图纸」。 */
  function registerPreviewDrawing(fn: (row: OutsourceQuoteSchema) => void): void {
    previewDrawing = fn;
  }

  // ============ 持久化 + restore ============
  const { restore: restorePersist } = useListStatePersist(
    'outsource_quote_list',
    { search, sortBy, sortDir },
    { exclude: new Set(['page']) },
  );

  /** 恢复优先级：URL `?statuses=` > localStorage 快照 > 角色默认（MANAGER→SUBMITTED /
   *  CLERK→DRAFT）。
   *
   *  2026-10-09：角色默认此前**根本不会生效** —— 后端 DTO 少 `statuses` 字段、
   *  service 恒传 `&[]`，前端发的参数被 serde 静默忽略。本轮后端补上接线，默认筛选
   *  才真的起作用。 */
  function restoreState(routeQueryStatuses: unknown): void {
    const persisted = restorePersist() as
      | {
          search?: Partial<OutsourceQuoteSearchState>;
          sortBy?: string;
          sortDir?: string;
        }
      | null
      | undefined;
    if (persisted) {
      const s = persisted.search ?? {};
      // lenient 逐字段恢复：keyword 时代的旧快照只存 keyword / statuses / customerId，
      // 新增的 drawing_no / name / outsource_company_id 落回默认而不是整份丢弃。
      search.drawing_no = s.drawing_no ?? search.drawing_no;
      search.name = s.name ?? search.name;
      search.outsource_company_id = s.outsource_company_id ?? search.outsource_company_id;
      search.customerId = s.customerId ?? search.customerId;
      search.statuses = Array.isArray(s.statuses)
        ? s.statuses.filter((v): v is OutsourceQuoteStatus =>
            ACTIVE_QUOTE_STATUSES.includes(v as OutsourceQuoteStatus),
          )
        : search.statuses;
      sortBy.value =
        persisted.sortBy === 'PRICE' || persisted.sortBy === 'REVIEWED_AT'
          ? persisted.sortBy
          : 'CREATED_AT';
      sortDir.value = persisted.sortDir === 'ASC' ? 'ASC' : 'DESC';
    }

    const urlStatuses =
      typeof routeQueryStatuses === 'string'
        ? routeQueryStatuses
            .split(',')
            .filter((s): s is OutsourceQuoteStatus =>
              ACTIVE_QUOTE_STATUSES.includes(s as OutsourceQuoteStatus),
            )
        : [];
    if (urlStatuses.length > 0) {
      search.statuses = [...urlStatuses];
    } else if (search.statuses.length === 0) {
      const defaults = defaultStatusesForRole(roleMap.value);
      if (defaults.length > 0) search.statuses = [...defaults];
    }
    // 开闸放行首屏 fetch。
    restored.value = true;
  }

  /** 加急行红底 + 行点击 cursor。 */
  function quoteRowClassName({ row }: { row: OutsourceQuoteSchema }): string {
    return row.is_urgent ? 'quote-row-clickable row-urgent' : 'quote-row-clickable';
  }

  /** 操作列自适应宽度：按当前 items 中按钮数最多的行算（每按钮约 76px + 12px padding，
   *  最小 160px 防空列表抖动）。 */
  const actionColumnWidth = computed(() => {
    const maxBtns = items.value.reduce((max, q) => {
      let n = 0;
      // 权限判定在 store 侧做（roleMap 已就位），避免视图侧再算一遍。
      if ((roleMap.value.MANAGER || roleMap.value.CLERK) && q.status === 'DRAFT') n++; // 提交
      if (roleMap.value.MANAGER && q.status === 'SUBMITTED') n += 2; // 通过 + 拒绝
      if (
        (roleMap.value.MANAGER || roleMap.value.CLERK) &&
        (q.status === 'DRAFT' || q.status === 'REJECTED')
      )
        n++; // 删除
      return Math.max(max, n);
    }, 0);
    return Math.max(160, maxBtns * 76 + 12);
  });

  const query = {
    search,
    page,
    pageSize,
    sortBy,
    sortDir,
    items,
    total,
    loading,
    errorMsg,
    emptyText,
    defaultSort,
    onSearch,
    onSortChange,
    resetAllFilters,
    onNativeFilterChange,
    restoreState,
    fetchList,
  };

  const filters = {
    drawingNoFilter,
    nameFilter,
    companyFilter,
    customerFilter,
    statusFilter,
  };

  const options = { customerTree, companyOptions, loadCompanyOptions };

  return {
    query,
    filters,
    options,
    columnDefs,
    columnVisibility,
    roleMap,
    actionColumnWidth,
    quoteRowClassName,
    registerPreviewDrawing,
    invalidate: () => invalidateOutsourceQuotesAll(qc),
  };
});

/** 列 prop → 后端 sort_by 键。报价端点只有三个排序列。 */
const SORT_PROP_MAP: Record<string, 'CREATED_AT' | 'PRICE' | 'REVIEWED_AT'> = {
  part_serial_no: 'CREATED_AT',
  part_drawing_no: 'CREATED_AT',
  part_name: 'CREATED_AT',
  outsource_company_name: 'CREATED_AT',
  process_code: 'CREATED_AT',
  price: 'PRICE',
  part_unit_price: 'CREATED_AT',
  customer_path: 'CREATED_AT',
};