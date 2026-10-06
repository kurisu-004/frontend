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
//   - 系统交期 → search.systemDeliveryDateFrom / To（draft → confirm 两段式）
//   - 客户   → search.customerId          （ElTreeSelect 单选，draft → confirm）
//
// 两段式（draft → confirm）的原因：popover 里的输入是「草稿」，只有点「确定」才写进
// search 并触发一次查询；直接 v-model 绑 search 会每敲一个字符发一次请求，日期区间
// 则会让「旧页码 + 新筛选」先闪一次空态再发第二次。

import { computed, ref, type ComputedRef, type Ref } from 'vue';
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
  /** 客户雪花 ID 字符串（后端 `customer_id`），禁止 Number()（19 位雪花 ID 会丢精度）。
   *  空串 = 不筛。 */
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
  /** popover 内的**未确认草稿**（ElDatePicker 的 v-model 载体）。确认后才写进 search。 */
  range: Ref<[string, string] | null>;
  active: ComputedRef<boolean>;
  sync: () => void;
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
  customerFilter: CustomerFilter;
  /** 客户树（共享 `useCustomersQuery` 缓存，ElTreeSelect 的 data）。 */
  customerTree: ComputedRef<CustomerCascaderNode[]>;
}

export function useInspectionColumnFilters(
  deps: UseInspectionColumnFiltersDeps,
): UseInspectionColumnFiltersReturn {
  // 客户树走共享基础数据层（useCustomerTree → useCustomersQuery，30s staleTime），
  // 与零件一览页共用同一份缓存。
  // 2026-10-03：只取 tree —— 本页的 confirmCustomerFilter 刻意**不**用
  // resolveRootCustomerId（见该函数注释），loading 也没有消费方，故两者不导出。
  const { tree: customerTree } = useCustomerTree();

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

  // ============ 系统交期区间（draft → confirm 两段式）============
  // 2026-10-03：日期筛选从「计划交期」改「系统交期」—— 计划交期列随 VO 收口删除，
  // 继续筛一个用户看不到的列没有意义。
  //
  // 为什么也走 draft（此前是 computed 直写 search、无 draft）：区间同样是一次
  // 「选完点确定」的动作，直写 search 会让「旧 page=3 + 新筛选」先发一次
  // （多半 0 行、闪一个空态），点确定后又发一次 —— 与本页另外三个文本筛选的
  // draft→confirm 单发行为不对称。`views/parts/list` 的同名筛选仍是直写形态，
  // 那是另一个页面，本次不动。
  const systemDateRange = ref<[string, string] | null>(null);

  const systemDatePopoverVisible = ref(false);
  const systemDateFilterActive = computed(
    () => deps.search.systemDeliveryDateFrom !== '' || deps.search.systemDeliveryDateTo !== '',
  );
  /** popover 打开时把已确认值回写草稿，保证二次打开看到原状。 */
  function syncSystemDateRange(): void {
    systemDateRange.value =
      deps.search.systemDeliveryDateFrom || deps.search.systemDeliveryDateTo
        ? ([deps.search.systemDeliveryDateFrom, deps.search.systemDeliveryDateTo] as [
            string,
            string,
          ])
        : null;
  }
  function resetSystemDate(): void {
    systemDateRange.value = null;
    deps.search.systemDeliveryDateFrom = '';
    deps.search.systemDeliveryDateTo = '';
    systemDatePopoverVisible.value = false;
    deps.onSearch();
  }
  function confirmSystemDate(): void {
    deps.search.systemDeliveryDateFrom = systemDateRange.value?.[0] ?? '';
    deps.search.systemDeliveryDateTo = systemDateRange.value?.[1] ?? '';
    systemDatePopoverVisible.value = false;
    deps.onSearch();
  }
  const systemDateFilter: DateRangeFilter = {
    visible: systemDatePopoverVisible,
    range: systemDateRange,
    active: systemDateFilterActive,
    sync: syncSystemDateRange,
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
    customerFilter,
    customerTree,
  };
}
