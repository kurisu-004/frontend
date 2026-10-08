// views/com/delivery/composables/useDeliveryNoteDetail.ts
//
// /delivery-notes/:id 详情页的派生层 + UI 状态。主数据来自同域 query hook
// `useDeliveryNoteDetailQuery`（useQuery + Zod 守门），本 composable 只做：
// - 角色矩阵 role（MANAGER / CLERK / INSPECTOR）与权限派生 canEdit / canView
// - 零件 / 装配件树行（treeLineItems，含客户端排序）
// - 列显隐 columnDefs + columnVisibility
// - 行高亮 helper（deliveryLineRowClassName：已打印标签绿底）
// - UI state：editDeliveryDate（日期 picker v-model）/ selectedRows（表格勾选的行）/
//   客户端排序态（sortBy / sortDir）
//
// ⚠️ **排序不改缓存**：详情一次返回全量 line_items，客户端排序在派生层做
// （`sortedLineItems` 派生副本），不 sort query data 本身 —— 那是 TanStack Query
// 缓存里的对象，原地改会让「别的消费者读到排过序的数组」且绕过失效。折叠（行形）
// 也只在派生层做，且保输入序 —— 折叠若自行重排会把表头排序静默还原。
//
// 设计要点：
// - composable 只持有「派生 + UI 状态变量」；dialog 可见性等临时 UI 状态由 shell 持有；
// - 事件流时间线与「添加零件」入口已随端点下线消失（`GET /{id}/events` 与
//   `POST /{id}/add-parts` 端点删除，入单只有扫码一条路）。

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { toValue } from 'vue';
import { canAddRemoveParts, canView } from '@/utils/deliveryNotePermissions';
// 读 auth 只走 Pinia store（useAuthStore），不解构（见 CLAUDE.md §auth）。
import { useAuthStore } from '@/stores/auth';
import { useColumnVisibility } from '@/composables/useColumnVisibility';
import { buildPartTreeRows, type PartTreeRow } from '../utils/deliveryNotePartRows';
import {
  buildDeliveryNoteLineItemsColumnDefs,
  DELIVERY_NOTE_LINE_ITEMS_LIST_KEY,
} from '../deliveryNoteLineItemsColumnDefs';
import { useDeliveryNoteDetailQuery } from './useDeliveryNoteDetailQuery';
import { usePrintedLabels } from './usePrintedLabels';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteLineItemData,
} from './deliveryNoteSchema';

export interface DeliveryNoteRoleMap {
  MANAGER: boolean;
  CLERK: boolean;
  INSPECTOR: boolean;
}

export interface UseDeliveryNoteDetailReturn {
  // data（query 的投影）
  note: Ref<DeliveryNoteDetailData | null>;
  loading: Ref<boolean>;
  // role / permissions
  role: ComputedRef<DeliveryNoteRoleMap>;
  canEdit: ComputedRef<boolean>;
  canView: ComputedRef<boolean>;
  // derived
  existingBatchIds: ComputedRef<string[]>;
  treeLineItems: ComputedRef<PartTreeRow[]>;
  /** 行 id → 该行代表的全部批次 id（勾选行按批次移除时展开用）。 */
  rowIdToBatchIds: ComputedRef<Map<string, string[]>>;
  // column visibility
  columnDefs: ReturnType<typeof buildDeliveryNoteLineItemsColumnDefs>;
  columnVisibility: ReturnType<typeof useColumnVisibility>;
  // UI state
  editDeliveryDate: Ref<string>;
  /** 表格勾选的零件 / 装配件行（不是批次 id —— 一行可能代表多个批次）。 */
  selectedRows: Ref<PartTreeRow[]>;
  // fetchers
  fetchDetail: () => Promise<void>;
  // helpers
  deliveryLineRowClassName: (ctx: { row: PartTreeRow }) => string;
  /** 客户端排序（详情一次性返回全量 line_items；null 强制末尾） */
  onLineItemSort: (sort: { prop: string | null; order: 'ascending' | 'descending' | null }) => void;
  /** 把表格勾选写入 selectedRows */
  setSelectedRows: (rows: PartTreeRow[]) => void;
  /** 卸载时清本 composable 自建的 UI 状态（query 缓存由 queryClient 统一管）。 */
  $dispose: () => void;
}

export function useDeliveryNoteDetail(
  noteId: MaybeRefOrGetter<string>,
): UseDeliveryNoteDetailReturn {
  // 2026-09-26：消费侧禁止解构 store（沿 usePartsListStore 不变量 #3），统一 auth.xxx。
  const auth = useAuthStore();

  // ============ 角色矩阵 ============
  const role = computed<DeliveryNoteRoleMap>(() => ({
    MANAGER: auth.hasRole('MANAGER'),
    CLERK: auth.hasRole('CLERK'),
    INSPECTOR: auth.hasRole('INSPECTOR'),
  }));

  // ============ 主数据（useQuery + Zod 守门）============
  const detailQuery = useDeliveryNoteDetailQuery(noteId);
  const note = computed<DeliveryNoteDetailData | null>(() => detailQuery.data.value ?? null);
  const loading = detailQuery.isFetching;
  const fetchDetail = detailQuery.fetchDetail;

  // ============ 权限派生 ============
  const canView_ = computed(() => note.value != null && canView(note.value.status));
  const canAdd = computed(
    () => note.value != null && canAddRemoveParts(note.value.status, role.value),
  );
  const canEdit = computed(() => canAdd.value); // canEdit 与 canAdd 同步

  /** 当前单上已有批次 id 列表。 */
  const existingBatchIds = computed(() =>
    note.value == null ? [] : note.value.line_items.map((it) => String(it.id)),
  );

  // ============ 客户端排序（派生副本，不动缓存）============
  const sortBy = ref<string | null>(null);
  const sortDir = ref<1 | -1>(1);

  const sortedLineItems = computed<DeliveryNoteLineItemData[]>(() => {
    const items = note.value?.line_items ?? [];
    if (!sortBy.value) return items;
    const prop = sortBy.value;
    const dir = sortDir.value;
    return [...items].sort((a, b) => {
      const av = a[prop as keyof DeliveryNoteLineItemData] as unknown;
      const bv = b[prop as keyof DeliveryNoteLineItemData] as unknown;
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // null 强制末尾
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  });

  function onLineItemSort({
    prop,
    order,
  }: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }): void {
    // 三态点击（order=null = 清排序）回到「后端返回顺序」。后端详情 SQL 按 `delivery_seq`
    // （本单内挂单先后）返回，所以这个语义就是**按加入送货单的先后顺序**。注：「序号」列
    // 自己也被 EP 排一次（读行上的 `seq`），两层同向、不冲突。
    if (!prop || !order) {
      sortBy.value = null;
      return;
    }
    sortBy.value = prop;
    sortDir.value = order === 'ascending' ? 1 : -1;
  }

  // ============ 零件 / 装配件树行 ============
  // 绿底随 `usePrintedLabels` 的 localStorage 记录实时重算：`isPrintedBatch` 在本
  // computed 求值**期间**同步读 `_store`，Vue 按「求值期间发生的 ref 读」收集依赖 ——
  // 不需要在这里显式再读一次 store。
  const printedLabelStore = usePrintedLabels();
  const treeLineItems = computed<PartTreeRow[]>(() =>
    buildPartTreeRows(sortedLineItems.value, printedLabelStore.isPrintedBatch),
  );
  /** 行 id → 批次 id 集合（勾选行按批次移除时展开；一行 = 多个批次）。 */
  const rowIdToBatchIds = computed<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>();
    const walk = (rows: readonly PartTreeRow[]): void => {
      for (const r of rows) {
        map.set(r.id, r.batch_ids);
        if (r.children) walk(r.children);
      }
    };
    walk(treeLineItems.value);
    return map;
  });

  // ============ 列显隐（line items 表）============
  const columnDefs = buildDeliveryNoteLineItemsColumnDefs();
  const columnVisibility = useColumnVisibility(columnDefs, {
    listKey: DELIVERY_NOTE_LINE_ITEMS_LIST_KEY,
  });

  // ============ UI state ============
  const editDeliveryDate = ref<string>('');
  /** 表格勾选的零件 / 装配件行（EP selection 的投影；行本身代表多个批次）。 */
  const selectedRows = ref<PartTreeRow[]>([]);

  function setSelectedRows(rows: PartTreeRow[]): void {
    selectedRows.value = rows;
  }

  // note 变化时把本地 editDeliveryDate 同步到当前 delivery_date；用户改了日期后这个
  // ref 保持本地未保存状态（直到下次 note 变化）。
  watch(
    () => note.value?.delivery_date ?? '',
    (v) => {
      editDeliveryDate.value = v;
    },
    { immediate: true },
  );

  // 切 noteId 时清空选中与排序态
  watch(
    () => toValue(noteId),
    () => {
      selectedRows.value = [];
      sortBy.value = null;
    },
  );

  // ============ 行样式 helper ============
  /**
   * 行高亮类名（绿底 = 该行已打过标签）。
   *
   * 判据只有 `row.label_printed` 一条，**不对装配件父行开特例**：绿底口径在
   * `utils/deliveryNotePartRows` 里定死为「零件行 any / 装配件父行 all」，本函数与扫码建单页
   * 草稿卡片的 `rowClassName` 同款 —— 同一行形态（装配件父行 + 子件行）在两张表上是同一套语义。
   */
  function deliveryLineRowClassName({ row }: { row: PartTreeRow }): string {
    return row.label_printed ? 'row-printed' : '';
  }

  return {
    note,
    loading,
    role,
    canEdit,
    canView: canView_,
    existingBatchIds,
    treeLineItems,
    rowIdToBatchIds,
    columnDefs,
    columnVisibility,
    editDeliveryDate,
    selectedRows,
    fetchDetail,
    deliveryLineRowClassName,
    onLineItemSort,
    setSelectedRows,
    $dispose: () => {
      selectedRows.value = [];
      sortBy.value = null;
    },
  };
}