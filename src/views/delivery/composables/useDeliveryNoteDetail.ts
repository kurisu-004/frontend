// views/delivery/composables/useDeliveryNoteDetail.ts
//
// 2026-08-25 frontend-overall-refactor：DeliveryNoteDetail 拆分的 useDeliveryNoteDetail。
// 负责 /delivery-notes/:id 详情页的所有 page-level 数据状态 + 派生：
// - 主数据 note + events fetch
// - 角色矩阵 role（MANAGER / CLERK / INSPECTOR）
// - 业务派生：canAdd / canEdit / uninspectedItems / existingBatchIdsForPicker / treeLineItems
// - 列显隐 columnVisibility + columnDefs
// - 状态/标签 helpers（partStatusLabel / partStatusTagType / deliveryLineRowClassName）
// - 客户端排序 onLineItemSort（详情一次性返回全量 line_items；null 兜底末尾）
// - UI state：editDeliveryDate（日期 picker v-model）/ selectedItemIds（表格选中）
//
// 设计要点：
// - composable 只持有「数据 + 派生 + UI 状态变量」；dialog 可见性、submitting flag 等
//   临时 UI 状态由 shell / dialog 组件持有。
// - fetcher 让 fetch 自然抛出 → 顶层 shell 捕获提示（与 PartListShell 同款 T14p5 模式）。
//   但本页不强求该模式——详情页有「加载失败占位」的明确语义，所以 detail.value 失败时为 null。

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  getNote,
  listNoteEvents,
  type AddPartsItem,
} from '@/api/deliveryNote'
import {
  type DeliveryNoteDetailOut,
  type DeliveryNoteEventOut,
  type DeliveryNoteLineItem,
} from '@/types/deliveryNote'
import type { OrderStatus } from '@/types/parts'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
} from '@/types/parts'
import {
  canAddRemoveParts,
  canView,
  hasManageNoteRole,
} from '@/utils/deliveryNotePermissions'
import { useAuthSession } from '@/composables/useAuthSession'
import { useColumnVisibility, type ColumnDef } from '@/composables/useColumnVisibility'

export interface DeliveryNoteRoleMap {
  MANAGER: boolean
  CLERK: boolean
  INSPECTOR: boolean
}

/** 装配件父行 + 子件行的扁平 + 嵌套结构（供 el-table tree-props 渲染）。 */
export interface AssemblyTreeRow extends DeliveryNoteLineItem {
  is_asm_row?: boolean
  has_children?: boolean
  children?: DeliveryNoteLineItem[]
  unit?: string
}

export interface UseDeliveryNoteDetailReturn {
  // data
  note: Ref<DeliveryNoteDetailOut | null>
  events: Ref<DeliveryNoteEventOut[]>
  loading: Ref<boolean>
  // role / permissions
  role: ComputedRef<DeliveryNoteRoleMap>
  canAdd: ComputedRef<boolean>
  canEdit: ComputedRef<boolean>
  canView: ComputedRef<boolean>
  // derived
  uninspectedItems: ComputedRef<DeliveryNoteLineItem[]>
  existingBatchIdsForPicker: ComputedRef<string[]>
  treeLineItems: ComputedRef<AssemblyTreeRow[]>
  // column visibility
  columnDefs: readonly ColumnDef[]
  columnVisibility: ReturnType<typeof useColumnVisibility>
  // UI state
  editDeliveryDate: Ref<string>
  selectedItemIds: Ref<string[]>
  // fetchers
  fetchDetail: () => Promise<void>
  // helpers
  partStatusLabel: (s: OrderStatus | string) => string
  partStatusTagType: (s: OrderStatus | string) =>
    'primary' | 'success' | 'warning' | 'info' | 'danger'
  deliveryLineRowClassName: (ctx: { row: AssemblyTreeRow }) => string
  /** 客户端排序（详情一次性返回全量 line_items；null 强制末尾） */
  onLineItemSort: (sort: { prop: string | null; order: 'ascending' | 'descending' | null }) => void
  /** 把外部选中（picker 提交等）写入 selectedItemIds */
  setSelectedItemIds: (ids: string[]) => void
  /** 暴露出来给 actions 用：当前 note 的 AddPartsItem（仅 batch_id） */
  buildAddPartsItems: (ids: string[]) => AddPartsItem[]
}

export function useDeliveryNoteDetail(
  noteId: Ref<string>,
): UseDeliveryNoteDetailReturn {
  const { hasRole } = useAuthSession()

  // ============ 角色矩阵 ============
  const role = computed<DeliveryNoteRoleMap>(() => ({
    MANAGER: hasRole('MANAGER'),
    CLERK: hasRole('CLERK'),
    INSPECTOR: hasRole('INSPECTOR'),
  }))

  // ============ 主数据 ============
  const note = ref<DeliveryNoteDetailOut | null>(null)
  const events = ref<DeliveryNoteEventOut[]>([])
  const loading = ref(false)

  async function fetchDetail(): Promise<void> {
    const id = noteId.value
    if (!id) return
    loading.value = true
    try {
      note.value = await getNote(id)
      events.value = await listNoteEvents(id)
      // 进入页面时同步本地 editDeliveryDate 到当前 delivery_date；
      // 用户改了日期后这个 ref 也保持本地未保存状态。
      editDeliveryDate.value = note.value?.delivery_date ?? ''
    } catch (e) {
      note.value = null
      events.value = []
      throw e  // 让 shell 捕获并 ElMessage.error
    } finally {
      loading.value = false
    }
  }

  // ============ 权限派生 ============
  const canView_ = computed(() => note.value != null && canView(note.value.status))
  const canAdd = computed(() => note.value != null && canAddRemoveParts(note.value.status, role.value))
  const canEdit = computed(() => canAdd.value)  // canEdit 与 canAdd 同步

  // ============ 未送检 / 阻塞件 ============
  // 后端允许入单的两个状态：INSPECTION（已送检 / 待贴标）与 READY_TO_SHIP（合格）；
  // 其它一律视为「未送检 / 阻塞」，提交前必须走批量过检弹窗。
  const uninspectedItems = computed<DeliveryNoteLineItem[]>(() =>
    (note.value?.line_items ?? []).filter(
      (li) => li.status !== 'INSPECTION' && li.status !== 'READY_TO_SHIP',
    ),
  )

  /** 当前单上已有批次 id 列表（picker 高亮禁用用） */
  const existingBatchIdsForPicker = computed(() =>
    note.value == null ? [] : note.value.line_items.map((it) => it.id),
  )

  // ============ 装配件父行 + 子件行 tree 结构 ============
  const treeLineItems = computed<AssemblyTreeRow[]>(() => {
    if (!note.value) return []
    const flat = note.value.line_items
    const asmGroups = new Map<string, DeliveryNoteLineItem[]>()
    const loose: DeliveryNoteLineItem[] = []
    flat.forEach((li) => {
      if (li.assembly_id) {
        const arr = asmGroups.get(li.assembly_id) ?? []
        arr.push(li)
        asmGroups.set(li.assembly_id, arr)
      } else {
        loose.push(li)
      }
    })
    const result: AssemblyTreeRow[] = []
    const insertedAsm = new Set<string>()
    flat.forEach((li) => {
      if (!li.assembly_id) {
        result.push(li as AssemblyTreeRow)
        return
      }
      if (insertedAsm.has(li.assembly_id)) return
      const children = asmGroups.get(li.assembly_id) ?? []
      result.push({
        id: `ASM_${li.assembly_id}`,
        // 2026-08-29：line_items[].version 变为必填后，AssemblyTreeRow（extends
        // DeliveryNoteLineItem）也要求 version；装配件父行 version 语义是「任一
        // 子件版本占位」（父行不参与 batch-to-* 调用，fetchDetail 后随子件刷掉）。
        version: li.version,
        is_asm_row: true,
        has_children: true,
        assembly_id: li.assembly_id,
        assembly_serial_no: li.assembly_serial_no,
        assembly_drawing_no: li.assembly_drawing_no,
        assembly_name: li.assembly_name,
        assembly_order_no: li.assembly_order_no,
        // 父行各列展示值（沿用 line_item 列字段，让 el-table 排序/模板不分支）
        serial_no: li.assembly_serial_no ?? '',
        drawing_no: li.assembly_drawing_no ?? '',
        order_no: li.assembly_order_no ?? '',
        name: li.assembly_name ?? '',
        applicant_name: children[0]?.applicant_name ?? '',
        customer_name: children[0]?.customer_name ?? '',
        customer_path: children[0]?.customer_path ?? '',
        quantity: 1,
        unit: '套',
        note: '',
        is_urgent: children.some((c) => c.is_urgent),
        status: 'INSPECTION', // 仅占位（父行不展示 status 列）
        batch_label: null,
        batch_no: null,
        part_id: '',
        request_date: null,
        planned_delivery_date: children[0]?.planned_delivery_date ?? null,
        system_delivery_date: null,
        is_scanned: false,
        scanned: false,
        parent_customer_name: children[0]?.parent_customer_name ?? null,
        children,
      })
      insertedAsm.add(li.assembly_id)
    })
    return result
  })

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
  ]
  const columnVisibility = useColumnVisibility(columnDefs, {
    listKey: 'delivery_note_detail_line_items',
  })

  // ============ UI state ============
  const editDeliveryDate = ref<string>('')
  const selectedItemIds = ref<string[]>([])

  function setSelectedItemIds(ids: string[]): void {
    selectedItemIds.value = ids
  }

  // 切 noteId 时清空选中
  watch(noteId, () => {
    selectedItemIds.value = []
  })

  // ============ 标签 / 行样式 helpers ============
  function partStatusLabel(s: OrderStatus | string): string {
    return (ORDER_STATUS_LABEL as Record<string, string>)[s] ?? String(s)
  }
  function partStatusTagType(
    s: OrderStatus | string,
  ): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
    return (ORDER_STATUS_TAG_TYPE as Record<
      string,
      'primary' | 'success' | 'warning' | 'info' | 'danger'
    >)[s] ?? 'info'
  }
  function deliveryLineRowClassName({ row }: { row: AssemblyTreeRow }): string {
    // 虚拟装配件父行的 urgent 取任一子件加急（与子件红底联动）
    if (row.is_asm_row) {
      return row.is_urgent ? 'row-urgent' : ''
    }
    return row.is_urgent ? 'row-urgent' : ''
  }

  // ============ 客户端排序 ============
  function onLineItemSort({
    prop,
    order,
  }: {
    prop: string | null
    order: 'ascending' | 'descending' | null
  }): void {
    if (!note.value || !prop || !order) return
    const dir = order === 'ascending' ? 1 : -1
    note.value.line_items.sort((a: DeliveryNoteLineItem, b: DeliveryNoteLineItem) => {
      const av = a[prop as keyof DeliveryNoteLineItem] as unknown
      const bv = b[prop as keyof DeliveryNoteLineItem] as unknown
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }

  // ============ AddPartsItem 构造（actions 用）============
  function buildAddPartsItems(ids: string[]): AddPartsItem[] {
    return ids.map((id) => ({ batch_id: id }))
  }

  // mark `canView_` as used internally (kept in interface for shell use)
  void canView_
  void hasManageNoteRole

  return {
    // data
    note,
    events,
    loading,
    // role / permissions
    role,
    canAdd,
    canEdit,
    canView: canView_,
    // derived
    uninspectedItems,
    existingBatchIdsForPicker,
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
    buildAddPartsItems,
  }
}
