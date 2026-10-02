// views/inspection/composables/useInspectionColumnFilters.ts
//
// 2026-10-03 新增：待品检一览页的表头筛选状态机（照 `views/parts/list/composables/
// usePartsColumnFilters.ts` 的形态，但只保留本页实际有的 5 个筛选列）。
//
// 为什么从「顶部 filter 卡」搬进表头（用户需求）：待品检页原来把图号 / 名称 / 序列号 /
// 计划交期放在顶部一条 filter 行里，与「零件一览」的交互范式不一致；本页要照零件一览
// 的样子把筛选收进表头 popover。计划交期列随 VO 收口删除，日期筛选改筛**系统交期**。
//
// 5 个筛选列与 search 字段的一一对应：
//   - 序列号 → search.serialNo            （draft → confirm 两段式）
//   - 图号   → search.drawingNo           （draft → confirm 两段式）
//   - 名称   → search.name                （draft → confirm 两段式）
//   - 系统交期 → search.systemDeliveryDateFrom / To（computed range model 直写，无 draft）
//   - 客户   → search.customerId          （ElTreeSelect 单选，draft → confirm）
//
// 两段式（draft → confirm）的原因：popover 里的输入是「草稿」，只有点「确定」才写进
// search 并触发一次查询；直接 v-model 绑 search 会每敲一个字符发一次请求。

import { computed, ref, type ComputedRef, type Ref, type WritableComputedRef } from 'vue';
import { useCustomerTree } from '@/composables/useCustomerTree';
import type { CustomerCascaderNode } from '@/composables/useCustomerTree';

/** 待品检页的 search state shape。**由 store 持有**（reactive），本 composable 只读它
 *  并按各列的确认动作写回 —— 与 `usePartsColumnFilters` 消费 `PartsSearchState` 的
 *  分工同形。定义在本文件而非 store 文件，是为了让 store 单向 import 本模块
 *  （value import），避免 store ⇄ filters 的循环依赖。 */
export interface InspectionSearchState {
  /** 序列号 ILIKE 子串（后端 `serial_no`）。 */
  serialNo: string;
  /** 图号 ILIKE 子串（后端 `drawing_no`）。 */
  drawingNo: string;
  /** 名称 ILIKE 子串（后端 `name`）。 */
  name: string;
  /** 客户雪花 ID 字符串（后端 `customer_id`）。**禁止 Number()**（CLAUDE.md §3：
   *  19 位 ID 在 JS Number 丢精度）。空串 = 不筛。 */
  customerId: string;
  /** 系统交期区间起点（含端点）；空串 = 不限。 */
  systemDeliveryDateFrom: string;
  /** 系统交期区间终点（含端点）；空串 = 不限。 */
  systemDeliveryDateTo: string;
}

type TextField = 'serialNo' | 'drawingNo' | 'name';

interface TextFilter {
  visible: Ref<boolean>;
  draft: Ref<string>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

interface DateRangeFilter {
  visible: Ref<boolean>;
  active: ComputedRef<boolean>;
  confirm: () => void;
  reset: () => void;
}

interface CustomerFilter {
  visible: Ref<boolean>;
  draft: Ref<string | null>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

export interface UseInspectionColumnFiltersDeps {
  /** store 持有的 search reactive。 */
  search: InspectionSearchState;
  /** 统一触发入口（store.query.onSearch：page=1）。 */
  onSearch: () => void;
}

export interface UseInspectionColumnFiltersReturn {
  serialNoFilter: TextFilter;
  drawingNoFilter: TextFilter;
  nameFilter: TextFilter;
  /** 系统交期区间 popover 状态机。 */
  systemDateFilter: DateRangeFilter;
  /** 系统交期区间的 v-model 载体（computed getter/setter 直写 search，无 draft）。
   *  单独导出是为了让列定义的 ElDatePicker 直接绑它 —— 见 `inspectionColumnDefs.ts`。 */
  systemDateRange: WritableComputedRef<[string, string] | null>;
  customerFilter: CustomerFilter;
  /** 客户树（共享 `useCustomersQuery` 缓存，ElTreeSelect 的 data）。 */
  customerTree: ComputedRef<CustomerCascaderNode[]>;
  customerLoading: ReturnType<typeof useCustomerTree>['loading'];
  /** 选中叶子客户 → 其 L1 根客户 id（后端拿 L1 会展开成 L1+L2 全集）。 */
  resolveRootCustomerId: (pickedId: string | null) => string | null;
}

export function useInspectionColumnFilters(
  deps: UseInspectionColumnFiltersDeps,
): UseInspectionColumnFiltersReturn {
  // 客户树走共享基础数据层（useCustomerTree → useCustomersQuery，30s staleTime），
  // 与零件一览页共用同一份缓存。
  const { tree: customerTree, loading: customerLoading, resolveRootCustomerId } = useCustomerTree();

  // ============ 文本列（序列号 / 图号 / 名称）============
  function makeTextFilter(field: TextField): TextFilter {
    const visible = ref(false);
    const draft = ref('');
    const active = computed(() => deps.search[field].trim() !== '');
    /** popover 打开时把已确认值回写草稿，保证二次打开看到原状。 */
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

  // ============ 系统交期区间（无 draft：range model 直写 search）============
  // 2026-10-03：日期筛选从「计划交期」改「系统交期」—— 计划交期列随 VO 收口删除，
  // 继续筛一个用户看不到的列没有意义。区间只有起止两格、没有「文本草稿」这层中间态，
  // 所以直接用 computed 的 get/set 双向桥（照 usePartsColumnFilters 的 makeRangeModel）。
  const systemDateRange = computed<[string, string] | null>({
    get: () =>
      deps.search.systemDeliveryDateFrom || deps.search.systemDeliveryDateTo
        ? ([deps.search.systemDeliveryDateFrom, deps.search.systemDeliveryDateTo] as [
            string,
            string,
          ])
        : null,
    set: (val) => {
      deps.search.systemDeliveryDateFrom = val?.[0] ?? '';
      deps.search.systemDeliveryDateTo = val?.[1] ?? '';
    },
  });

  const systemDatePopoverVisible = ref(false);
  const systemDateFilterActive = computed(
    () => deps.search.systemDeliveryDateFrom !== '' || deps.search.systemDeliveryDateTo !== '',
  );
  function resetSystemDate(): void {
    systemDateRange.value = null;
    systemDatePopoverVisible.value = false;
    deps.onSearch();
  }
  /** 值已由 ElDatePicker 直接写进 search，这里只关 popover + 触发查询。 */
  function confirmSystemDate(): void {
    systemDatePopoverVisible.value = false;
    deps.onSearch();
  }
  const systemDateFilter: DateRangeFilter = {
    visible: systemDatePopoverVisible,
    active: systemDateFilterActive,
    confirm: confirmSystemDate,
    reset: resetSystemDate,
  };

  // ============ 客户列（popover + ElTreeSelect 单选）============
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
    // 直接写选中节点的 id：选 L1 时后端按 `customer_id` 展开成 L1+L2 全集，
    // 选 L2 时只命中该 L2（与零件一览同款；用 resolveRootCustomerId 反而会把
    // L2 的选择放大成整个 L1 组）。
    // 雪花 ID 必须保持字符串 —— 走 Number() 会丢精度导致 IN 永不命中。
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

  return {
    serialNoFilter,
    drawingNoFilter,
    nameFilter,
    systemDateFilter,
    systemDateRange,
    customerFilter,
    customerTree,
    customerLoading,
    resolveRootCustomerId,
  };
}
