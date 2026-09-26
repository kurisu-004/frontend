// views/parts/list/composables/usePartsColumnFilters.ts
//
// 2026-08-22 从 PartsList.vue 抽出：表头筛选状态集合（文本/日期/客户/位置/原生列 + 扫码）。
//
// 设计：
// - 文本列 + 日期列 + 客户 + 位置：每个 column 一组 {visible, draft, active, confirm, reset}
//   （custom 字段各有 isNullDraft / range 等扩展）；
// - 原生列：仅「状态」走 EP :filters 下拉，filtered-value 由 search 派生，
//   @filter-change 由 onNativeFilterChange 翻译回 search + onSearch()。
// - 客户 / 位置 tree 由 useCustomerTree / usePartLocationTree 提供，一并导出供行内
//   编辑复用。
//
// 2026-09-27 前后端字段对齐：移除「下一道工序」原生列相关状态机——
//   - nextProcessOptions / nextProcessFilteredValue / nextProcessSelectedCount /
//     nextProcessFilterActive / loadNextProcessOptions 全部删除；
//   - useProcessesQuery 不再需要（原本只服务此列下拉）；
//   - onNativeFilterChange 不再处理 'next_process' 列变化；
//   - onSerialNoScan / 草稿同步不再清 nextProcessIds / nextProcessDraft。
// 同步删除 usePartsListQuery.ts 中 nextProcessIds search state + `next_process_ids`
// query 参数构造。

import { computed, ref, type Ref } from 'vue';
import { ORDER_STATUS_LABEL, type OrderStatus } from '@/types/parts';
import { useCustomerTree } from '@/composables/useCustomerTree';
import { splitLocationSelection, usePartLocationTree } from '@/views/parts/list/composables/usePartLocationTree';
import type { CustomerCascaderNode } from '@/composables/useCustomerTree';
import type { LocationTreeNode } from '@/types/parts';
import type { PartsSearchState } from './usePartsListQuery';

// 2026-09-26（B 任务）移除：原 listProcesses 动态调用已迁 useProcessesQuery，import 不再需要。

/** 2026-08-22：原生 EP :filters 下拉中「仅加急」选项的哨兵值。
 *  status + isUrgent 两条独立筛选被合并到 status 列的同一个 multi-select 下拉中。 */
export const URGENT_FILTER_VALUE = '__URGENT__';

type TextField = 'serialNo' | 'drawingNo' | 'name';

interface TextFilter {
  visible: Ref<boolean>;
  draft: Ref<string>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

interface TextWithNullFilter extends TextFilter {
  isNullDraft: Ref<boolean | undefined>;
}

interface DateRangeFilter {
  visible: Ref<boolean>;
  range: Ref<[string, string] | null>;
  active: ComputedRef<boolean>;
  confirm: () => void;
  reset: () => void;
}

interface DateRangeWithNullFilter extends DateRangeFilter {
  isNullDraft: Ref<boolean | undefined>;
  sync: () => void;
}

interface CustomerFilter {
  visible: Ref<boolean>;
  draft: Ref<string | null>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

interface LocationFilter {
  visible: Ref<boolean>;
  draft: Ref<string[]>;
  active: ComputedRef<boolean>;
  count: ComputedRef<number>;
  onShow: () => void;
  confirm: () => void;
  reset: () => void;
}

// Vue 的 ComputedRef 不从 vue 显式 import 时类型不识别，这里用 typeof
import type { ComputedRef } from 'vue';

export interface UsePartsColumnFiltersDeps {
  search: PartsSearchState;
  /** 调用方提供的统一触发入口（page=1 + fetchList） */
  onSearch: () => void;
  /** 调用方提供的持久化写入（扫码场景手动触发） */
  snapshot: () => void;
}

/** 2026-09-21 显式返回类型。 */
export interface UsePartsColumnFiltersReturn {
  serialNoFilter: TextFilter;
  drawingNoFilter: TextFilter;
  nameFilter: TextFilter;
  orderNoFilter: TextWithNullFilter;
  requestDateFilter: DateRangeFilter;
  plannedDateFilter: DateRangeFilter;
  systemDateFilter: DateRangeWithNullFilter;
  customerTree: ComputedRef<CustomerCascaderNode[]>;
  customerFilter: CustomerFilter;
  locationTree: ReturnType<typeof usePartLocationTree>['tree'];
  locationFilter: LocationFilter;
  statusNativeOptions: { text: string; value: string }[];
  statusFilteredValue: ComputedRef<string[]>;
  statusFilterActive: ComputedRef<boolean>;
  statusSelectedCount: ComputedRef<number>;
  onNativeFilterChange: (payload: Record<string, string[]>) => void;
  serialNoFlash: Ref<boolean>;
  onSerialNoScan: (rawCode: string) => void;
  statusDraft: Ref<OrderStatus[]>;
  statusUrgentDraft: Ref<boolean>;
}

export function usePartsColumnFilters(
  deps: UsePartsColumnFiltersDeps,
): UsePartsColumnFiltersReturn {
  // ============ 客户树 + 位置树（供 popover 和行内编辑复用） ============
  const { tree: customerTree } = useCustomerTree();
  const { tree: locationTree, load: loadLocationTree } = usePartLocationTree();

  // ============ 文本列（popover + 输入框） ============
  function makeTextFilter(field: TextField): TextFilter {
    const visible = ref(false);
    const draft = ref('');
    const active = computed(() => deps.search[field].trim() !== '');
    function sync(): void {
      draft.value = deps.search[field];
    }
    function confirm(): void {
      deps.search[field] = draft.value.trim();
      visible.value = false;
      deps.onSearch();
    }
    function reset(): void {
      draft.value = '';
      deps.search[field] = '';
      visible.value = false;
      deps.onSearch();
    }
    return { visible, draft, active, sync, confirm, reset };
  }

  const serialNoFilter = makeTextFilter('serialNo');
  const drawingNoFilter = makeTextFilter('drawingNo');
  const nameFilter = makeTextFilter('name');

  // ============ 订单号（额外带「仅空白」checkbox） ============
  const orderNoPopoverVisible = ref(false);
  const orderNoDraft = ref('');
  const orderNoIsNullDraft = ref<boolean | undefined>(undefined);
  const orderNoFilterActive = computed(
    () => deps.search.orderNo.trim() !== '' || deps.search.orderNoIsNull === true,
  );
  function syncOrderNoDraft(): void {
    orderNoDraft.value = deps.search.orderNo;
    orderNoIsNullDraft.value = deps.search.orderNoIsNull;
  }
  function resetOrderNoDraft(): void {
    orderNoDraft.value = '';
    orderNoIsNullDraft.value = undefined;
    deps.search.orderNo = '';
    deps.search.orderNoIsNull = undefined;
    orderNoPopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmOrderNoFilter(): void {
    deps.search.orderNo = orderNoDraft.value.trim();
    deps.search.orderNoIsNull = orderNoIsNullDraft.value;
    orderNoPopoverVisible.value = false;
    deps.onSearch();
  }
  const orderNoFilter: TextWithNullFilter = {
    visible: orderNoPopoverVisible,
    draft: orderNoDraft,
    isNullDraft: orderNoIsNullDraft,
    active: orderNoFilterActive,
    sync: syncOrderNoDraft,
    confirm: confirmOrderNoFilter,
    reset: resetOrderNoDraft,
  };

  // ============ 日期列（popover + daterange） ============
  // 2026-08-22：统一走 deps.onSearch()（原 PartsList 日期走 onDateRangeChange 不清批量；
  // 统一后 date 重置也清批量，与 2026-07-31「改筛选即清空批量选择」一致）。
  type DateRange = [string, string] | null;
  type DateRangeKey =
    | 'requestDateFrom'
    | 'requestDateTo'
    | 'plannedDeliveryDateFrom'
    | 'plannedDeliveryDateTo'
    | 'systemDeliveryDateFrom'
    | 'systemDeliveryDateTo';

  function makeRangeModel(fromKey: DateRangeKey, toKey: DateRangeKey) {
    return computed<DateRange>({
      get: () =>
        deps.search[fromKey] || deps.search[toKey]
          ? ([deps.search[fromKey], deps.search[toKey]] as [string, string])
          : null,
      set: (val: DateRange) => {
        deps.search[fromKey] = val?.[0] ?? '';
        deps.search[toKey] = val?.[1] ?? '';
      },
    });
  }

  const requestDateRange = makeRangeModel('requestDateFrom', 'requestDateTo');
  const plannedDateRange = makeRangeModel('plannedDeliveryDateFrom', 'plannedDeliveryDateTo');
  const systemDateRange = makeRangeModel('systemDeliveryDateFrom', 'systemDeliveryDateTo');

  const requestDatePopoverVisible = ref(false);
  const requestDateFilterActive = computed(
    () => deps.search.requestDateFrom !== '' || deps.search.requestDateTo !== '',
  );
  function resetRequestDateDraft(): void {
    deps.search.requestDateFrom = '';
    deps.search.requestDateTo = '';
    requestDatePopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmRequestDateFilter(): void {
    requestDatePopoverVisible.value = false;
    deps.onSearch();
  }
  const requestDateFilter: DateRangeFilter = {
    visible: requestDatePopoverVisible,
    range: requestDateRange,
    active: requestDateFilterActive,
    confirm: confirmRequestDateFilter,
    reset: resetRequestDateDraft,
  };

  const plannedDatePopoverVisible = ref(false);
  const plannedDateFilterActive = computed(
    () => deps.search.plannedDeliveryDateFrom !== '' || deps.search.plannedDeliveryDateTo !== '',
  );
  function resetPlannedDateDraft(): void {
    deps.search.plannedDeliveryDateFrom = '';
    deps.search.plannedDeliveryDateTo = '';
    plannedDatePopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmPlannedDateFilter(): void {
    plannedDatePopoverVisible.value = false;
    deps.onSearch();
  }
  const plannedDateFilter: DateRangeFilter = {
    visible: plannedDatePopoverVisible,
    range: plannedDateRange,
    active: plannedDateFilterActive,
    confirm: confirmPlannedDateFilter,
    reset: resetPlannedDateDraft,
  };

  // ============ 系统交期（额外带「仅空白」checkbox） ============
  const systemDatePopoverVisible = ref(false);
  const systemDateFilterActive = computed(
    () =>
      deps.search.systemDeliveryDateFrom !== '' ||
      deps.search.systemDeliveryDateTo !== '' ||
      deps.search.systemDeliveryDateIsNull === true,
  );
  const systemDateIsNullDraft = ref<boolean | undefined>(undefined);
  function syncSystemDateDraft(): void {
    systemDateIsNullDraft.value = deps.search.systemDeliveryDateIsNull;
  }
  function resetSystemDateDraft(): void {
    deps.search.systemDeliveryDateFrom = '';
    deps.search.systemDeliveryDateTo = '';
    deps.search.systemDeliveryDateIsNull = undefined;
    systemDateIsNullDraft.value = undefined;
    systemDatePopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmSystemDateFilter(): void {
    deps.search.systemDeliveryDateIsNull = systemDateIsNullDraft.value;
    systemDatePopoverVisible.value = false;
    deps.onSearch();
  }
  const systemDateFilter: DateRangeWithNullFilter = {
    visible: systemDatePopoverVisible,
    range: systemDateRange,
    isNullDraft: systemDateIsNullDraft,
    active: systemDateFilterActive,
    confirm: confirmSystemDateFilter,
    reset: resetSystemDateDraft,
    sync: syncSystemDateDraft,
  };

  // ============ 客户列（popover + tree-select） ============
  const customerPopoverVisible = ref(false);
  const customerDraft = ref<string | null>(null);
  const customerFilterActive = computed(() => deps.search.customerId !== '');
  function syncCustomerDraft(): void {
    customerDraft.value = deps.search.customerId || null;
  }
  function resetCustomerDraft(): void {
    customerDraft.value = null;
    deps.search.customerId = '';
    customerPopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmCustomerFilter(): void {
    deps.search.customerId = customerDraft.value ?? '';
    customerPopoverVisible.value = false;
    deps.onSearch();
  }
  const customerFilter: CustomerFilter = {
    visible: customerPopoverVisible,
    draft: customerDraft,
    active: customerFilterActive,
    sync: syncCustomerDraft,
    confirm: confirmCustomerFilter,
    reset: resetCustomerDraft,
  };

  // ============ 位置列（popover + tree-select，splitLocationSelection 拆大类和叶子） ============
  const locationPopoverVisible = ref(false);
  const locationDraft = ref<string[]>([]);
  const locationFilterActive = computed(
    () => deps.search.locations.length > 0 || deps.search.holderIds.length > 0,
  );
  const locationSelectedCount = computed(
    () => deps.search.locations.length + deps.search.holderIds.length,
  );
  function onLocationPopoverShow(): void {
    // 1. 懒加载（幂等：模块级 Promise 缓存）
    void loadLocationTree();
    // 2. draft 回写已确认筛选（大类 + holder 叶子合并），确保再次打开看到原状
    locationDraft.value = [...deps.search.locations, ...deps.search.holderIds];
  }
  function resetLocationDraft(): void {
    locationDraft.value = [];
    deps.search.locations = [];
    deps.search.holderIds = [];
    locationPopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmLocationFilter(): void {
    const split = splitLocationSelection(locationDraft.value);
    deps.search.locations = split.locations;
    deps.search.holderIds = split.holderIds;
    locationPopoverVisible.value = false;
    deps.onSearch();
  }
  const locationFilter: LocationFilter = {
    visible: locationPopoverVisible,
    draft: locationDraft,
    active: locationFilterActive,
    count: locationSelectedCount,
    onShow: onLocationPopoverShow,
    confirm: confirmLocationFilter,
    reset: resetLocationDraft,
  };

  // ============ 原生列：状态 + 下一道工序 ============
  // 状态：与 ORDER_STATUS_LABEL 同源 + 末尾追加「仅加急」哨兵值。
  const statusNativeOptions: { text: string; value: string }[] = [
    ...(Object.keys(ORDER_STATUS_LABEL) as OrderStatus[]).map((v) => ({
      text: ORDER_STATUS_LABEL[v],
      value: v,
    })),
    { text: '仅加急', value: URGENT_FILTER_VALUE },
  ];
  const statusFilteredValue = computed<string[]>(() => [
    ...deps.search.statuses,
    ...(deps.search.isUrgent === true ? [URGENT_FILTER_VALUE] : []),
  ]);
  const statusFilterActive = computed(
    () => deps.search.statuses.length > 0 || deps.search.isUrgent === true,
  );
  const statusSelectedCount = computed(() => deps.search.statuses.length);

  // 2026-09-27 前后端字段对齐：删除「下一道工序」原生列相关状态机——
  // procQuery / nextProcessList / nextProcessOptions / nextProcessFilteredValue /
  // nextProcessFilterActive / nextProcessSelectedCount / loadNextProcessOptions /
  // nextProcessDraft 全部随本列删除。后续若恢复此筛选，重新引入即可。

  // ============ filter-change 翻译 ============
  // 2026-08-22：EP 2.14 filter-change 只上报本次变更的那一列
  // （key=column-key，值数组，全清为 []，未变更不在 payload）。
  function onNativeFilterChange(payload: Record<string, string[]>): void {
    let changed = false;
    if ('status' in payload) {
      const v = payload.status;
      deps.search.statuses = v.filter((x): x is OrderStatus => x !== URGENT_FILTER_VALUE);
      deps.search.isUrgent = v.includes(URGENT_FILTER_VALUE) ? true : null;
      changed = true;
    }
    if (changed) deps.onSearch();
  }

  // ============ 扫码：序列号直搜 ============
  // 2026-08-04：扫码枪扫描序列号直接搜索（与 onReset 类似但保留 serialNo）。
  // 2026-08-22：从 PartsList 抽出，editingId 守卫由 view 在订阅处判断（不放在 composable 里）。
  const serialNoFlash = ref(false);
  function onSerialNoScan(rawCode: string): void {
    const code = rawCode.trim();
    if (!code) return;
    // 清空所有筛选（keyword/orderNo/drawingNo/name/serialNo/statuses/isUrgent/customerId/
    // 3 个日期区间/locations），只保留 serialNo 搜索。
    deps.search.keyword = '';
    deps.search.drawingNo = '';
    deps.search.name = '';
    deps.search.orderNo = '';
    deps.search.orderNoIsNull = undefined;
    deps.search.serialNo = code;
    deps.search.statuses = [];
    deps.search.isUrgent = null;
    deps.search.customerId = '';
    deps.search.requestDateFrom = '';
    deps.search.requestDateTo = '';
    deps.search.plannedDeliveryDateFrom = '';
    deps.search.plannedDeliveryDateTo = '';
    deps.search.systemDeliveryDateFrom = '';
    deps.search.systemDeliveryDateTo = '';
    deps.search.systemDeliveryDateIsNull = undefined;
    deps.search.locations = [];
    deps.search.holderIds = [];
    // 同步刷新 popover 内 draft 状态（避免下次打开还看到旧的）。
    statusDraft.value = [];
    statusUrgentDraft.value = false;
    customerDraft.value = null;
    locationDraft.value = [];
    drawingNoFilter.draft.value = '';
    nameFilter.draft.value = '';
    orderNoDraft.value = '';
    orderNoIsNullDraft.value = undefined;
    serialNoFilter.draft.value = code;
    systemDateIsNullDraft.value = undefined;
    // 序列号 popover 自动打开，便于用户看到 scan-flash 0.6s 脉冲动画。
    serialNoFilter.visible.value = true;
    // 持久化（与 onReset 同步写 localStorage）。
    deps.snapshot();
    // 触发查询（onSearch 内会清空批量选择 + fetchList）。
    deps.onSearch();
    // 视觉反馈：serialNo 输入框脉冲动画 0.6s。
    serialNoFlash.value = true;
    setTimeout(() => {
      serialNoFlash.value = false;
    }, 600);
  }

  // ============ 状态 popover 草稿（native 列切换前的兼容草稿，主要给扫码同步用） ============
  // 2026-08-22：状态列改为原生 :filters，不再需要完整 popover；statusDraft / statusUrgentDraft
  // 仅作为「扫码同步清空」的目标引用保留，避免破坏 deps.search → 派生 reactive 流。
  const statusDraft = ref<OrderStatus[]>([]);
  const statusUrgentDraft = ref(false);

  return {
    // 文本列
    serialNoFilter,
    drawingNoFilter,
    nameFilter,
    orderNoFilter,
    // 日期列
    requestDateFilter,
    plannedDateFilter,
    systemDateFilter,
    // 客户 / 位置
    customerTree,
    customerFilter,
    locationTree,
    locationFilter,
    // 原生列
    statusNativeOptions,
    statusFilteredValue,
    statusFilterActive,
    statusSelectedCount,
    onNativeFilterChange,
    // 扫码
    serialNoFlash,
    onSerialNoScan,
    // 兼容（扫码同步草稿，外部不需要直接用）
    statusDraft,
    statusUrgentDraft,
  };
}

// 让 TypeScript 推断时拿得到 CustomerCascaderNode / LocationTreeNode 形状
export type { CustomerCascaderNode, LocationTreeNode };
