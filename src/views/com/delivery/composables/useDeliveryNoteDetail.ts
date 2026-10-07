// views/com/delivery/composables/useDeliveryNoteDetail.ts
//
// /delivery-notes/:id 详情页的所有 page-level 数据状态 + 派生：
// - 主数据 note（`GET /com/delivery/note/{id}`）
// - 角色矩阵 role（MANAGER / CLERK / INSPECTOR）
// - 业务派生：canEdit / treeLineItems / existingBatchIds
// - 列显隐 columnDefs + columnVisibility
// - 状态 / 标签 helpers（partStatusLabel / partStatusTagType / deliveryLineRowClassName）
// - 客户端排序 onLineItemSort（详情一次性返回全量 line_items；null 兜底末尾）
// - UI state：editDeliveryDate（日期 picker v-model）/ selectedItemIds（表格选中）
//
// 设计要点：
// - composable 只持有「数据 + 派生 + UI 状态变量」；dialog 可见性等临时 UI 状态由 shell 持有；
// - fetcher 让 fetch 自然抛出 → 顶层 shell 捕获提示（与 ListShell 同款模式）。
//   详情页有「加载失败占位」的明确语义，所以失败时 note 置 null。
// - 事件流时间线与「添加零件」入口已随端点下线消失（`GET /{id}/events` 与
//   `POST /{id}/add-parts` 端点删除，入单只有扫码一条路）。

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { getNote } from '@/api/com/deliveryNote';
import type {
  DeliveryNoteDetailData,
  DeliveryNoteLineItemData,
} from './deliveryNoteSchema';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG_TYPE, type OrderStatus } from '@/types/parts';
import { canAddRemoveParts, canView } from '@/utils/deliveryNotePermissions';
// 读 auth 只走 Pinia store（useAuthStore），不解构（见 CLAUDE.md §auth）。
import { useAuthStore } from '@/stores/auth';
import { useColumnVisibility, type ColumnDef } from '@/composables/useColumnVisibility';
import { shippableSetsOfGroup } from '../utils/assemblySets';

export interface DeliveryNoteRoleMap {
  MANAGER: boolean;
  CLERK: boolean;
  INSPECTOR: boolean;
}

/** 装配件父行 + 子件行的扁平 + 嵌套结构（供 el-table tree-props 渲染）。 */
export interface AssemblyTreeRow extends Omit<DeliveryNoteLineItemData, 'quantity'> {
  /**
   * 数量：散件行 = 批次数量；装配件父行 = 本单可出货套数（与打印对话框「合并一套」
   * 父行同口径同数值）。后端没给 shippable_sets 时为 null，表格渲染「—」——
   * 不可兜成 0（口径见 utils/assemblySets）。
   */
  quantity: number | null;
  is_asm_row?: boolean;
  has_children?: boolean;
  children?: DeliveryNoteLineItemData[];
  unit?: string;
}

export interface UseDeliveryNoteDetailReturn {
  // data
  note: Ref<DeliveryNoteDetailData | null>;
  loading: Ref<boolean>;
  // role / permissions
  role: ComputedRef<DeliveryNoteRoleMap>;
  canEdit: ComputedRef<boolean>;
  canView: ComputedRef<boolean>;
  // derived
  existingBatchIds: ComputedRef<string[]>;
  treeLineItems: ComputedRef<AssemblyTreeRow[]>;
  // column visibility
  columnDefs: readonly ColumnDef[];
  columnVisibility: ReturnType<typeof useColumnVisibility>;
  // UI state
  editDeliveryDate: Ref<string>;
  selectedItemIds: Ref<string[]>;
  // fetchers
  fetchDetail: () => Promise<void>;
  // helpers
  partStatusLabel: (s: OrderStatus | string) => string;
  partStatusTagType: (
    s: OrderStatus | string,
  ) => 'primary' | 'success' | 'warning' | 'info' | 'danger';
  deliveryLineRowClassName: (ctx: { row: AssemblyTreeRow }) => string;
  /** 客户端排序（详情一次性返回全量 line_items；null 强制末尾） */
  onLineItemSort: (sort: { prop: string | null; order: 'ascending' | 'descending' | null }) => void;
  /** 把外部选中写入 selectedItemIds */
  setSelectedItemIds: (ids: string[]) => void;
  /** 页面级 store 的 $dispose 契约占位（详情页是壳直调 composable，无 Pinia 单例，
   *  切路由即销毁；这里保留同名方法让 shell 的 onBeforeUnmount 语义可对照）。 */
  $dispose: () => void;
}

export function useDeliveryNoteDetail(noteId: Ref<string>): UseDeliveryNoteDetailReturn {
  // 2026-09-26：消费侧禁止解构 store（沿 usePartsListStore 不变量 #3），统一 auth.xxx。
  const auth = useAuthStore();

  // ============ 角色矩阵 ============
  const role = computed<DeliveryNoteRoleMap>(() => ({
    MANAGER: auth.hasRole('MANAGER'),
    CLERK: auth.hasRole('CLERK'),
    INSPECTOR: auth.hasRole('INSPECTOR'),
  }));

  // ============ 主数据 ============
  const note = ref<DeliveryNoteDetailData | null>(null);
  const loading = ref(false);

  async function fetchDetail(): Promise<void> {
    const id = noteId.value;
    if (!id) return;
    loading.value = true;
    try {
      const d = await getNote(id);
      note.value = d;
      // 进入页面时同步本地 editDeliveryDate 到当前 delivery_date；
      // 用户改了日期后这个 ref 也保持本地未保存状态。
      editDeliveryDate.value = d.delivery_date ?? '';
    } catch (e) {
      note.value = null;
      throw e; // 让 shell 捕获并 ElMessage.error
    } finally {
      loading.value = false;
    }
  }

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

  // ============ 装配件父行 + 子件行 tree 结构 ============
  const treeLineItems = computed<AssemblyTreeRow[]>(() => {
    if (!note.value) return [];
    const flat = note.value.line_items;
    const asmGroups = new Map<string, DeliveryNoteLineItemData[]>();
    const insertedAsm = new Set<string>();
    flat.forEach((li) => {
      if (li.assembly_id) {
        const arr = asmGroups.get(li.assembly_id) ?? [];
        arr.push(li);
        asmGroups.set(li.assembly_id, arr);
      }
    });
    const result: AssemblyTreeRow[] = [];
    flat.forEach((li) => {
      if (!li.assembly_id) {
        result.push(li as AssemblyTreeRow);
        return;
      }
      if (insertedAsm.has(li.assembly_id)) return;
      const children = asmGroups.get(li.assembly_id) ?? [];
      result.push({
        id: `ASM_${li.assembly_id}`,
        // 装配件父行的 version 是「任一子件版本占位」：父行不参与任何写端点调用，
        // 随子件一起刷新。
        version: li.version,
        is_asm_row: true,
        has_children: true,
        assembly_id: li.assembly_id,
        assembly_serial_no: li.assembly_serial_no,
        assembly_drawing_no: li.assembly_drawing_no,
        assembly_name: li.assembly_name,
        assembly_order_no: li.assembly_order_no,
        // 父行各列展示值（沿用 line_item 列字段，让 el-table 排序 / 模板不分支）
        serial_no: li.assembly_serial_no ?? '',
        drawing_no: li.assembly_drawing_no ?? '',
        order_no: li.assembly_order_no ?? '',
        name: li.assembly_name ?? '',
        applicant_name: children[0]?.applicant_name ?? '',
        customer_name: children[0]?.customer_name ?? '',
        customer_path: children[0]?.customer_path ?? '',
        // 父行数量 = 本单可出货套数（后端算，与打印对话框同源同值）；
        // 后端没给数时 null → 表格渲染「—」。口径见 utils/assemblySets。
        quantity: shippableSetsOfGroup(children),
        unit: '套',
        note: '',
        status: 'INSPECTION', // 仅占位（父行不展示 status 列）
        batch_label: null,
        batch_no: null,
        part_id: '',
        request_date: null,
        planned_delivery_date: children[0]?.planned_delivery_date ?? null,
        system_delivery_date: null,
        parent_customer_name: children[0]?.parent_customer_name ?? null,
        children,
      });
      insertedAsm.add(li.assembly_id);
    });
    return result;
  });

  // ============ 列显隐（line items 表）============
  const columnDefs: readonly ColumnDef[] = [
    { key: 'batch_label', label: '批次' },
    { key: 'serial_no', label: '序列号' },
    { key: 'drawing_no', label: '图号' },
    { key: 'order_no', label: '订单号' },
    { key: 'name', label: '名称' },
    { key: 'customer', label: '客户（二级）' },
    { key: 'applicant_name', label: '申请人' },
    { key: 'quantity', label: '数量' },
    { key: 'request_date', label: '请购日期' },
    { key: 'planned_delivery_date', label: '计划交期' },
    { key: 'system_delivery_date', label: '系统交期' },
    { key: 'note', label: '备注' },
    { key: 'status', label: '状态' },
  ];
  const columnVisibility = useColumnVisibility(columnDefs, {
    listKey: 'delivery_note_detail_line_items',
  });

  // ============ UI state ============
  const editDeliveryDate = ref<string>('');
  const selectedItemIds = ref<string[]>([]);

  function setSelectedItemIds(ids: string[]): void {
    selectedItemIds.value = ids;
  }

  // 切 noteId 时清空选中
  watch(noteId, () => {
    selectedItemIds.value = [];
  });

  // ============ 标签 / 行样式 helpers ============
  function partStatusLabel(s: OrderStatus | string): string {
    return (ORDER_STATUS_LABEL as Record<string, string>)[s] ?? String(s);
  }
  function partStatusTagType(
    s: OrderStatus | string,
  ): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
    return (
      (
        ORDER_STATUS_TAG_TYPE as Record<
          string,
          'primary' | 'success' | 'warning' | 'info' | 'danger'
        >
      )[s] ?? 'info'
    );
  }
  function deliveryLineRowClassName({ row }: { row: AssemblyTreeRow }): string {
    void row;
    return '';
  }

  // ============ 客户端排序 ============
  function onLineItemSort({
    prop,
    order,
  }: {
    prop: string | null;
    order: 'ascending' | 'descending' | null;
  }): void {
    if (!note.value || !prop || !order) return;
    const dir = order === 'ascending' ? 1 : -1;
    note.value.line_items.sort((a: DeliveryNoteLineItemData, b: DeliveryNoteLineItemData) => {
      const av = a[prop as keyof DeliveryNoteLineItemData] as unknown;
      const bv = b[prop as keyof DeliveryNoteLineItemData] as unknown;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  return {
    // data
    note,
    loading,
    // role / permissions
    role,
    canEdit,
    canView: canView_,
    // derived
    existingBatchIds,
    treeLineItems,
    // column visibility
    columnDefs,
    columnVisibility,
    // UI state
    editDeliveryDate,
    selectedItemIds,
    // fetchers
    fetchDetail,
    // helpers
    partStatusLabel,
    partStatusTagType,
    deliveryLineRowClassName,
    onLineItemSort,
    setSelectedItemIds,
    $dispose: () => {
      note.value = null;
      selectedItemIds.value = [];
    },
  };
}