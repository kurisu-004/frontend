// src/views/outsource/composables/useOutsourceSentPartsPage.ts
//
// 2026-10-09 新建：外协对账页（`/outsource/companies/:id/sent-parts`）的页面级状态
// composable。**不是 Pinia store** —— 本页的全部状态都随路由参数 `companyId` 走，
// 换公司即换一份（切公司要重置筛选与页码），Pinia 单例语义在这里没有价值；而
// `companyId` 来自 `useRoute`，按「store 不 import vue-router」的硬约束也不该进 store。
// 形态照 `views/inspection/composables/useInspectionListStore.ts` 的切片（search /
// 分页 / 排序 / 行内编辑 / options），只是宿主是组件实例而非 Pinia。
//
// 本轮三项变更：
//   1. **接真分页**：此前是裸 `el-table` + `loadList()` 里硬编码 `limit: 50, offset: 0`，
//      超过 50 行静默丢数据（无报错、无提示，`total` 也不显示）。改走域内 query hook
//      （page / pageSize 进 queryKey）+ `el-pagination`。
//      ⚠️ 为什么不用 `<PagedTable>`：它内部 `usePagedListQuery` 持有**自己那份** items 副本
//      （由 fetcher 的返回值填充），而本 hook 的数据源是 TanStack 缓存 —— 两份 items 会
//      各说各话（query 更新后 PagedTable 的副本不跟着动）。待品检页已踩过同一条路线，
//      那里也是脱开 PagedTable 直接用 `el-pagination`。
//   2. **删掉 `getOutsourceCompany` 调用**：公司名改读 `sent-parts` 信封新增的
//      `outsource_company_name`（公司不存在 / 已软删时为 null ⇒ 显示「未知公司」）。
//   3. 表头筛选：图号 / 名称 / 客户 / 外协工序 / 发送时间 / 回收时间 / 对账。

import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { reconcileUpdateShipment } from '@/api/outsource';
import { useProcessesQuery } from '@/composables/queries/useProcessesQuery';
import { useCustomerTree } from '@/composables/useCustomerTree';
import { useListStatePersist } from '@/composables/useListFilterPersist';
import { buildOutsourceSentPartColumnDefs } from '../outsourceSentPartColumnDefs';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import type { OutsourceSentPartItemSchema } from './outsourceListSchema';
import {
  makeNativeBoolFilter,
  useOutsourceColumnFilters,
} from './useOutsourceColumnFilters';
import {
  invalidateOutsourceSentPartsAll,
  useOutsourceSentPartsQuery,
} from './useOutsourceSentPartsQuery';
import type { OutsourceSentPartSortKey } from '@/types/outsource';
import type { SortDir } from '@/types/parts';
import type { Process } from '@/types/process';

/** 本页的 search shape（表头筛选的唯一状态源）。 */
export interface OutsourceSentPartsSearchState {
  /** `t_part.drawing_no` ILIKE 子串。 */
  drawing_no: string;
  /** `t_part.name` ILIKE 子串。 */
  name: string;
  /** 零件**直属**客户雪花 ID 字符串；空串 = 不筛。 */
  customer_id: string;
  /** shipment 工序雪花 ID 字符串；空串 = 不筛。 */
  process_id: string;
  /** 已对账 / 未对账三态：undefined = 不过滤。 */
  is_billed: boolean | undefined;
  /** `sent_at` 闭区间下界（含）。 */
  sent_from: string;
  /** `sent_at` 闭区间上界（含）。 */
  sent_to: string;
  /** `received_at` 闭区间下界（含）。 */
  received_from: string;
  /** `received_at` 闭区间上界（含）。 */
  received_to: string;
}

function initialSearch(): OutsourceSentPartsSearchState {
  return {
    drawing_no: '',
    name: '',
    customer_id: '',
    process_id: '',
    is_billed: undefined,
    sent_from: '',
    sent_to: '',
    received_from: '',
    received_to: '',
  };
}

/** 行内编辑缓冲（三个可编辑字段；`version` 是端点的 OCC 锚，不进缓冲）。 */
interface EditBuffer {
  unit_price: number | null;
  quantity: number | null;
  is_billed: boolean;
}

export function useOutsourceSentPartsPage(companyId: string) {
  // 必须在组件 setup 内调用本 composable（`useQueryClient` 依赖注入上下文）。
  const queryClient = useQueryClient();

  // ============ 切片：search / 分页 / 排序 / 主查询 ============
  const search = reactive<OutsourceSentPartsSearchState>(initialSearch());
  const page = ref(1);
  const pageSize = ref(50);
  // 默认排序与后端非法值退化一致：SENT_AT / DESC。
  const sortBy = ref<OutsourceSentPartSortKey>('SENT_AT');
  const sortDir = ref<SortDir>('DESC');
  // enabled 闸门：默认 false，restoreState() 末尾开闸（避免双 fetch）。
  const restored = ref(false);

  function buildParams() {
    return {
      company_id: companyId,
      drawing_no: search.drawing_no.trim() || undefined,
      name: search.name.trim() || undefined,
      customer_id: search.customer_id || undefined,
      process_id: search.process_id || undefined,
      is_billed: search.is_billed,
      sent_from: search.sent_from || undefined,
      sent_to: search.sent_to || undefined,
      received_from: search.received_from || undefined,
      received_to: search.received_to || undefined,
      sort_by: sortBy.value,
      sort_dir: sortDir.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    };
  }

  const listQuery = useOutsourceSentPartsQuery({
    params: computed(() => buildParams()),
    enabled: restored,
  });
  const { fetchList } = listQuery;

  const items = computed<OutsourceSentPartItemSchema[]>(
    () => listQuery.data.value?.items ?? [],
  );
  const total = computed<number>(() => Number(listQuery.data.value?.total ?? 0));
  const loading = listQuery.isFetching;
  // 2026-10-09：页头公司名改读信封（原先要额外发一次 GET /{id}）。
  // 公司不存在 / 已软删时后端返 null（端点不因公司缺失而 404）。
  const companyName = computed<string>(
    () => listQuery.data.value?.outsource_company_name ?? '未知公司',
  );
  const errorMsg = computed<string | null>(() => {
    const e = listQuery.error.value;
    return e ? e.message : null;
  });
  const emptyText = computed<string>(() => errorMsg.value ?? '暂无对账记录');

  function onSearch(): void {
    page.value = 1;
  }

  // el-table 的 `default-sort` 要 prop 名（不是后端 sort_by 键）。
  const defaultSort = computed<{ prop: string; order: 'ascending' | 'descending' }>(() => ({
    prop: SORT_KEY_TO_PROP[sortBy.value],
    order: sortDir.value === 'ASC' ? 'ascending' : 'descending',
  }));

  function onSortChange({
    prop,
    order,
  }: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }): void {
    // 用户点「取消排序」（第三次点击）不改状态：保持上一次排序继续查。
    if (!prop || !order) return;
    const next = PROP_TO_SORT_KEY[prop];
    if (!next) return;
    sortBy.value = next;
    sortDir.value = order === 'ascending' ? 'ASC' : 'DESC';
    page.value = 1;
  }

  // ============ 切片：filters（表头筛选状态机）============
  const { makeTextFilter, makeDateRangeFilter } = useOutsourceColumnFilters({ search, onSearch });
  const drawingNoFilter = makeTextFilter('drawing_no');
  const nameFilter = makeTextFilter('name');
  const customerFilter = makeTextFilter('customer_id');
  const processFilter = makeTextFilter('process_id');
  const sentDateFilter = makeDateRangeFilter('sent_from', 'sent_to');
  const receivedDateFilter = makeDateRangeFilter('received_from', 'received_to');
  const billedBool = makeNativeBoolFilter({ search, onSearch }, {
    key: 'is_billed',
    trueLabel: '已对账',
    falseLabel: '未对账',
  });
  const billedFilter = billedBool.filter;

  /** 工具栏「重置筛选」：清已确认值 + 未确认草稿 + popover 打开态。**保留**排序与每页条数。 */
  function resetAllFilters(): void {
    drawingNoFilter.reset();
    nameFilter.reset();
    customerFilter.reset();
    processFilter.reset();
    sentDateFilter.reset();
    receivedDateFilter.reset();
    search.is_billed = undefined;
    page.value = 1;
  }

  /** EP `filter-change` 只上报本次变更的那一列 ⇒ 只可能是对账列。 */
  function onNativeFilterChange(payload: Record<string, string[]>): void {
    billedBool.applyNativeChange(payload);
  }

  // 持久化：筛选 + 排序（不持久化 page / 每页条数）。companyId 走 URL，不进快照。
  const { restore: restorePersist } = useListStatePersist('outsource_company_sent_parts', {
    search,
    sortBy,
    sortDir,
  });

  function restoreState(): void {
    const persisted = restorePersist() as
      | {
          search?: Partial<OutsourceSentPartsSearchState>;
          sortBy?: string;
          sortDir?: string;
        }
      | null
      | undefined;
    if (persisted) {
      // lenient 逐字段恢复：旧快照（keyword / sent_from / sent_to 时代）多出的键被忽略，
      // 缺失的键落回默认，不会整份丢弃。
      const s = persisted.search ?? {};
      search.drawing_no = s.drawing_no ?? search.drawing_no;
      search.name = s.name ?? search.name;
      search.customer_id = s.customer_id ?? search.customer_id;
      search.process_id = s.process_id ?? search.process_id;
      search.sent_from = s.sent_from ?? search.sent_from;
      search.sent_to = s.sent_to ?? search.sent_to;
      search.received_from = s.received_from ?? search.received_from;
      search.received_to = s.received_to ?? search.received_to;
      const active = s.is_billed;
      search.is_billed = active === true || active === false ? active : undefined;
      // localStorage 里是 string，按后端 sort 白名单收敛（非法值回落默认）。
      sortBy.value = SENT_PART_SORT_KEY_SET.has(persisted.sortBy as OutsourceSentPartSortKey)
        ? (persisted.sortBy as OutsourceSentPartSortKey)
        : 'SENT_AT';
      sortDir.value = persisted.sortDir === 'ASC' || persisted.sortDir === 'DESC'
        ? persisted.sortDir
        : 'DESC';
    }
    restored.value = true;
  }

  // ============ 切片：行内编辑（双击 → Enter 保存 / Esc 取消）============
  const editingId = ref<string | null>(null);
  const savingEdit = ref(false);
  const editBuffer = reactive<EditBuffer>({ unit_price: null, quantity: null, is_billed: false });

  function startEdit(row: OutsourceSentPartItemSchema): void {
    if (editingId.value && editingId.value !== row.shipment_id) {
      ElMessage.warning('请先保存或取消当前正在编辑的行');
      return;
    }
    editBuffer.unit_price = Number(row.unit_price);
    editBuffer.quantity = row.quantity;
    editBuffer.is_billed = row.is_billed;
    editingId.value = row.shipment_id;
  }

  function cancelEdit(): void {
    editingId.value = null;
  }

  /**
   * 总价列的显示源（后端 `total_price` 优先）。
   *
   * 取舍：`total_price` 由后端直出，它是总价列与合计行的**单一真源** —— 未编辑的行
   * 直接展示后端值，前端不再二次推导（两份算法一旦漂移，对账单上的数字就会和后端算的
   * 不一致）。唯一例外是行内编辑态：后端值尚未更新（`reconcile-update` 要等 Enter 才
   * 提交），此时当缓冲里的 `unit_price` / `quantity` 与行内原值**确实不同**时用缓冲实时
   * 重算，让操作员敲数字时就看到总价变化；缓冲与原值一致（刚双击进入、还没动）时仍走
   * `row.total_price`，避免浮点误差与后端 Decimal 串末位对不上。
   */
  function displayTotalPrice(row: OutsourceSentPartItemSchema): string {
    if (editingId.value === row.shipment_id) {
      const bufPrice = editBuffer.unit_price;
      const bufQty = editBuffer.quantity;
      const priceChanged = bufPrice !== null && bufPrice !== Number(row.unit_price);
      const qtyChanged = bufQty !== null && bufQty !== row.quantity;
      if (priceChanged || qtyChanged) {
        const p = Number(bufPrice ?? row.unit_price ?? 0);
        const q = Number(bufQty ?? row.quantity ?? 0);
        return Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0
          ? (q * p).toFixed(2)
          : '—';
      }
    }
    return row.total_price;
  }

  // ============ 切片：mutations（行内保存）============
  const reconcileMutation = useMutation({
    mutationKey: ['outsource', 'sent-parts', 'reconcile-update'],
    mutationFn: (vars: { shipmentId: string; version: number; payload: Parameters<typeof reconcileUpdateShipment>[1] }) =>
      reconcileUpdateShipment(vars.shipmentId, vars.payload),
    onSuccess: async () => {
      // 一律前缀全失效拿后端权威值，不在 mutation 回调里复述「哪几个字段会变」。
      await invalidateOutsourceSentPartsAll(queryClient);
      ElMessage.success('保存成功');
    },
    onError: (e: Error) => ElMessage.error(e.message ?? '保存失败'),
  });

  async function saveEdit(row: OutsourceSentPartItemSchema): Promise<void> {
    if (editBuffer.quantity !== null && editBuffer.quantity < 1) {
      ElMessage.warning('数量必须 ≥ 1');
      return;
    }
    if (editBuffer.unit_price !== null && editBuffer.unit_price < 0) {
      ElMessage.warning('单价必须 ≥ 0');
      return;
    }
    savingEdit.value = true;
    try {
      await reconcileMutation.mutateAsync({
        shipmentId: row.shipment_id,
        // OCC 锚：shipment.version 必须原样回传（后端 `reconcile-update` 必填）。
        version: row.version,
        payload: {
          version: row.version,
          unit_price: editBuffer.unit_price,
          quantity: editBuffer.quantity,
          is_billed: editBuffer.is_billed,
        },
      });
      editingId.value = null;
    } catch {
      // 错误已由 mutation 的 onError 提示；保持编辑态让用户改完重试。
    } finally {
      savingEdit.value = false;
    }
  }

  // Enter 保存 / Esc 取消的键盘事件委托（黑名单：popper / 下拉 / 日期 picker / 对话框）。
  function onEditKeydown(e: KeyboardEvent): void {
    if (editingId.value == null) return;
    const target = e.target as HTMLElement | null;
    if (target && ENTER_BLACKLIST.some((sel) => target.closest(sel))) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const row = items.value.find((r) => r.shipment_id === editingId.value);
    if (row) void saveEdit(row);
  }

  // ============ 切片：options（下拉候选）============
  const { tree: customerTree } = useCustomerTree();
  const processesQuery = useProcessesQuery({ category: 'OUTSOURCE', limit: 200 });
  const outsourceProcesses = computed<Process[]>(
    () => (processesQuery.data.value?.items ?? []) as Process[],
  );
  /** 「外协工序」筛选列的候选：`{id, code, name}` 三元组（label 在列定义里拼 `code — name`）。 */
  const processOptions = computed(() =>
    outsourceProcesses.value.map((p) => ({ id: p.id, code: p.code, name: p.name })),
  );

  // ============ 列定义 + 列可见性 ============
  const columnDefs = buildOutsourceSentPartColumnDefs({
    drawingNoFilter,
    nameFilter,
    customerFilter,
    processFilter,
    sentDateFilter,
    receivedDateFilter,
    billedFilter,
    edit: { editingId, saving: savingEdit, buffer: editBuffer, displayTotalPrice },
    options: { customerTree, processes: processOptions },
  });
  const columnVisibility = useColumnVisibility(columnDefs, {
    listKey: 'outsource_company_sent_parts',
  });

  /** 加急行整行红底（与零件一览 / 看板同款）。 */
  function rowClassName({ row }: { row: OutsourceSentPartItemSchema }): string {
    return row.is_urgent ? 'row-urgent' : '';
  }

  /** 合计行：总价列求和（逐行读后端 `total_price`，不前端重算 q × p）+ 首列当前页条数。 */
  function summaryMethod({
    columns,
    data,
  }: {
    columns: Array<{ property?: string; label?: string }>;
    data: OutsourceSentPartItemSchema[];
  }): string[] {
    return columns.map((col, index) => {
      if (col.label === '总价') {
        const sum = data.reduce((acc, row) => {
          const t = Number(row.total_price);
          return acc + (Number.isFinite(t) ? t : 0);
        }, 0);
        return sum.toFixed(2);
      }
      if (index === 0) return `合计（本页 ${data.length} 条）`;
      return '';
    });
  }

  return {
    query: {
      search,
      page,
      pageSize,
      sortBy,
      sortDir,
      items,
      total,
      loading,
      companyName,
      errorMsg,
      emptyText,
      defaultSort,
      onSortChange,
      resetAllFilters,
      onNativeFilterChange,
      restoreState,
      fetchList,
    },
    filters: {
      drawingNoFilter,
      nameFilter,
      customerFilter,
      processFilter,
      sentDateFilter,
      receivedDateFilter,
      billedFilter,
      customerTree,
      processOptions,
    },
    edit: {
      editingId,
      saving: savingEdit,
      editBuffer,
      startEdit,
      cancelEdit,
      saveEdit,
      displayTotalPrice,
      onEditKeydown,
    },
    mutations: { reconcileMutation },
    columnDefs,
    columnVisibility,
    rowClassName,
    summaryMethod,
  };
}

/** 后端 sort_by 白名单 ↔ 列 prop 映射（三个可排序列：单价 / 发送时间 / 回收时间）。 */
const PROP_TO_SORT_KEY: Record<string, OutsourceSentPartSortKey | undefined> = {
  unit_price: 'PRICE',
  sent_at: 'SENT_AT',
  received_at: 'RECEIVED_AT',
};
const SORT_KEY_TO_PROP: Record<OutsourceSentPartSortKey, string> = {
  PRICE: 'unit_price',
  SENT_AT: 'sent_at',
  RECEIVED_AT: 'received_at',
};
const SENT_PART_SORT_KEY_SET = new Set<OutsourceSentPartSortKey>(['PRICE', 'SENT_AT', 'RECEIVED_AT']);

/** Enter / Esc 键的黑名单：这些容器里的按键属于 popper / 下拉 / 日期 picker / 对话框。 */
const ENTER_BLACKLIST = ['.el-popper.is-light', '.el-select-dropdown', '.el-date-picker', '.el-dialog'];