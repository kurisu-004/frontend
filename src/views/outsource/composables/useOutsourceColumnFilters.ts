// src/views/outsource/composables/useOutsourceColumnFilters.ts
//
// 2026-10-09 新建：外协三页（公司一览 / 外协对账 / 报价一览）共用的**表头筛选状态机**。
// 形态照 `views/parts/list/composables/usePartsColumnFilters.ts` 与
// `views/inspection/composables/useInspectionColumnFilters.ts`：
//   - 文本列 / 日期区间 / 枚举多选列：每列一组 `{visible, draft, active, confirm, reset}`
//     状态机（枚举多选另给 `range` / `multi` 扩展）；
//   - 两态枚举（启用/停用、已对账/未对账）走 EP **原生** `:filters`，`filteredValue` 由
//     search 派生、`@filter-change` 由 `onNativeFilterChange` 翻译回 search。
//
// 为什么共用一个 composable（而不是三页各写一份）：三页的筛选维度里有一整类是同构的
// —— 「图号 / 名称两个直连 ILIKE 子串」在三页都出现（报价与对账页 2026-10-09 同时把
// `keyword` 拆成这两项），各自的 confirm / reset 语义完全一致（写 search → onSearch →
// 关 popover）。抄三份会让「重置筛选要不要同时清 draft」这类决策出现三个真相源。
//
// 两段式（draft → confirm）的原因沿用零件一览：popover 里输入的是草稿，只有点「确定」
// 才写进 search 并触发一次查询；直接 v-model 绑 search 会每敲一个字符发一次请求。
//
// **筛选状态（search）由调用方持有**（页面级 store 或视图），本 composable 只读它并
// 按各列的确认动作写回 —— 与 `usePartsColumnFilters` / `useInspectionColumnFilters` 的
// 分工同形。

import { computed, ref, type ComputedRef, type Ref } from 'vue';

/** 文本列状态机（公司名 / 图号 / 名称）。 */
export interface OutsourceTextFilter {
  visible: Ref<boolean>;
  draft: Ref<string>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

/** 日期区间状态机（发送时间 / 回收时间 / 其它 NaiveDateTime 闭区间）。 */
export interface OutsourceDateRangeFilter {
  visible: Ref<boolean>;
  /** popover 内的**未确认草稿**；确认后才写进 search 的 from / to。 */
  range: Ref<[string, string] | null>;
  active: ComputedRef<boolean>;
  sync: () => void;
  confirm: () => void;
  reset: () => void;
}

/**
 * EP 原生多选枚举列（状态 / 对账）。
 *
 * 原生列没有 draft：EP 的 `:filters` 下拉本身就是「勾完立即生效」的交互，
 * `filteredValue` 由 search 派生保证外部重置能把勾清掉，`@filter-change` 负责翻译
 * 回 search（照 `usePartsColumnFilters.onNativeFilterChange`）。
 */
export interface OutsourceNativeMultiFilter<W = string> {
  /** 候选集：`{text, value}`（value 用字符串承载，翻译层负责转回目标类型）。 */
  options: { text: string; value: string }[];
  /** 绑到 `<el-table-column :filtered-value>`；派生自 search，不是独立状态。 */
  filteredValue: ComputedRef<string[]>;
  active: ComputedRef<boolean>;
  count: ComputedRef<number>;
  /** `value` 字符串 → search 字段类型的映射（默认原样，boolean 列覆盖它）。 */
  toValue: (raw: string) => W;
}

/** 两态布尔列（启用 / 停用、已对账 / 未对账）的原生过滤器别名。 */
export type OutsourceNativeBoolFilter = OutsourceNativeMultiFilter<boolean>;

export interface UseOutsourceColumnFiltersDeps<T extends Record<string, unknown>> {
  /** 调用方持有的 search（reactive）。文本 / 日期列按键名读写它。 */
  search: T;
  /** 统一触发入口（调用方的 `onSearch`：页码拨回 1 + 让 queryKey 换键）。 */
  onSearch: () => void;
}

/** 构造一组原生多选枚举列的状态派生 + `@filter-change` 翻译器。
 *
 *  用法：`makeNativeMultiFilter({ search, onSearch }, { key: 'isActive', options,
 *  toValue })`，调用方拿返回的 `filteredValue / active / count` 绑列，并用
 * `applyNativeChange(payload)` 处理 EP 事件。
 *
 *  ⚠️ EP 的 `filter-change` **只上报本次变更的那一列**（key = column-key，全清为 `[]`，
 *  未变更的列不在 payload 里），所以翻译器要按 `key in payload` 逐列判断。 */
export function makeNativeMultiFilter<T extends Record<string, unknown>, W = string>(
  deps: UseOutsourceColumnFiltersDeps<T>,
  config: {
    key: string;
    options: { text: string; value: string }[];
    /** search 里存的是数组形态（多选）。 */
  },
): {
  filter: OutsourceNativeMultiFilter<W>;
  applyNativeChange: (payload: Record<string, string[]>) => boolean;
} {
  const bag = deps.search as Record<string, unknown>;
  const current = (): string[] => {
    const raw = bag[config.key];
    return Array.isArray(raw) ? (raw as string[]) : [];
  };
  const filteredValue = computed(() => current());
  const active = computed(() => current().length > 0);
  const count = computed(() => current().length);

  function applyNativeChange(payload: Record<string, string[]>): boolean {
    if (!(config.key in payload)) return false;
    bag[config.key] = [...payload[config.key]!];
    deps.onSearch();
    return true;
  }

  return {
    filter: {
      options: config.options,
      filteredValue,
      active,
      count,
      toValue: (raw: string) => raw as unknown as W,
    },
    applyNativeChange,
  };
}

/**
 * 两态枚举的原生多选过滤器（启用 / 停用、已对账 / 未对账）。
 *
 * search 里存的是 `boolean | undefined`（三态：undefined = 不过滤），而 EP 的
 * `:filters` 只吃字符串数组 ⇒ `toValue` 负责 `'true'` / `'false'` → boolean，
 * 翻译器负责反方向。**两个值都不选 = 不筛**（而不是「什么都不匹配」），
 * 这样用户在 EP 下拉里点掉全部勾选就能回到未筛选态。
 */
export function makeNativeBoolFilter<T extends Record<string, unknown>>(
  deps: UseOutsourceColumnFiltersDeps<T>,
  config: {
    key: string;
    trueLabel: string;
    falseLabel: string;
  },
): {
  filter: OutsourceNativeMultiFilter<boolean>;
  applyNativeChange: (payload: Record<string, string[]>) => boolean;
} {
  const bag = deps.search as Record<string, unknown>;
  const current = (): string[] => {
    const raw = bag[config.key];
    if (raw === true) return ['true'];
    if (raw === false) return ['false'];
    return [];
  };
  const filteredValue = computed(() => current());
  const active = computed(() => bag[config.key] !== undefined);
  const count = computed(() => (active.value ? 1 : 0));

  function applyNativeChange(payload: Record<string, string[]>): boolean {
    if (!(config.key in payload)) return false;
    const picked = payload[config.key]!;
    // 四态映射：空 = 不过滤；只勾 true / 只勾 false = 精确筛；两个都勾 = 与不过滤
    // 等价（用户表达的是「都要」，后端没有 OR 谓词可映射，故归一成不过滤）。
    let next: boolean | undefined;
    if (picked.length === 0) next = undefined;
    else if (picked.includes('true') && picked.includes('false')) next = undefined;
    else next = picked.includes('true');
    bag[config.key] = next;
    deps.onSearch();
    return true;
  }

  return {
    filter: {
      options: [
        { text: config.trueLabel, value: 'true' },
        { text: config.falseLabel, value: 'false' },
      ],
      filteredValue,
      active,
      count,
      toValue: (raw: string) => raw === 'true',
    },
    applyNativeChange,
  };
}

export function useOutsourceColumnFilters<T extends Record<string, unknown>>(
  deps: UseOutsourceColumnFiltersDeps<T>,
) {
  // ============ 文本列（公司名 / 图号 / 名称）============
  function makeTextFilter(field: string): OutsourceTextFilter {
    // search 是泛型 T，TS 不允许对泛型下标**写**；统一取一个 `Record<string, unknown>`
    // 视图做读写（值形态由各页的 search state 约定，运行时同一批 ref）。
    const bag = deps.search as Record<string, unknown>;
    const visible = ref(false);
    const draft = ref('');
    const active = computed(() => String(bag[field] ?? '').trim() !== '');
    /** popover 打开时把已确认值回写草稿，保证二次打开看到原状。 */
    function sync(): void {
      draft.value = String(bag[field] ?? '');
    }
    function confirm(): void {
      bag[field] = draft.value.trim();
      visible.value = false;
      deps.onSearch();
    }
    function reset(): void {
      draft.value = '';
      bag[field] = '';
      visible.value = false;
      deps.onSearch();
    }
    return { visible, draft, active, sync, confirm, reset };
  }

  // ============ 日期区间（draft → confirm 两段式）============
  // 为什么要 draft（区间同样走两段式）：直写 search 会让「旧 page=3 + 新筛选」先发一次
  // （多半 0 行、闪一个空态），点确定后又发一次 —— 与同页文本筛选的 draft→confirm 单发
  // 行为不对称。
  function makeDateRangeFilter(fromKey: string, toKey: string): OutsourceDateRangeFilter {
    const bag = deps.search as Record<string, unknown>;
    const visible = ref(false);
    const range = ref<[string, string] | null>(null);
    const active = computed(
      () => String(bag[fromKey] ?? '') !== '' || String(bag[toKey] ?? '') !== '',
    );
    function sync(): void {
      const from = String(bag[fromKey] ?? '');
      const to = String(bag[toKey] ?? '');
      range.value = from || to ? ([from, to] as [string, string]) : null;
    }
    function confirm(): void {
      bag[fromKey] = range.value?.[0] ?? '';
      bag[toKey] = range.value?.[1] ?? '';
      visible.value = false;
      deps.onSearch();
    }
    function reset(): void {
      range.value = null;
      bag[fromKey] = '';
      bag[toKey] = '';
      visible.value = false;
      deps.onSearch();
    }
    return { visible, range, active, sync, confirm, reset };
  }

  return { makeTextFilter, makeDateRangeFilter };
}