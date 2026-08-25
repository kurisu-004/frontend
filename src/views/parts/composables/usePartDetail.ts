// views/parts/composables/usePartDetail.ts
//
// 2026-08-25 frontend-overall-refactor：PartDetail 拆分的 usePartDetail。
// 负责 /parts/:id 详情页的所有 page-level 业务：
// - 零件主信息 fetchPart
// - 行内编辑 editing / form / saving
// - 取消订单 / 删除（confirm dialog 由 shell 持有 UI 状态）
// - 品检通过 / 指定工序（failInsp dialog 由 shell 持有 UI 状态）
// - 外协回收（receive dialog 由 shell 持有 UI 状态）
// - 批次拆分 / 取消批次（split dialog 由 PartBatchMonitorCard 持有 UI 状态）
// - 状态 / 事件标签 helpers
//
// composable 只持有纯业务数据 + 业务函数；dialog 可见性、form 数据 refs 由
// 各自的子组件或 shell 持有，调用本 composable 的纯函数完成提交。

import { computed, reactive, ref, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  cancelPart,
  cancelPartBatch,
  getPart,
  listPartBatches,
  listPartEvents,
  passInspection,
  softDeletePart,
  splitPartBatch,
  updatePart,
  type PartBatch,
  type PartEvent,
  type PartItem,
  type PartUpdatePayload,
} from '@/api/parts'
import { getAssemblyForPart } from '@/api/assembly'
import type { AssemblyDetail } from '@/types/assembly'
import { failInspection, receiveFromOutsource } from '@/api/parts'
import { usePermissions } from '@/composables/usePermissions'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  PART_EVENT_LABEL,
  PART_EVENT_TAG_TYPE,
  type OrderStatus,
  type PartEventType,
} from '@/types/parts'

/** 行内编辑 form。 */
export interface PartEditForm {
  name: string
  drawing_no: string
  quantity: number
  is_urgent: boolean
  planned_delivery_date: string
  actual_delivery_date: string | null
  order_no: string | null
  system_delivery_date: string | null
  note: string | null
}

function makeEmptyEditForm(): PartEditForm {
  return {
    name: '',
    drawing_no: '',
    quantity: 1,
    is_urgent: false,
    planned_delivery_date: '',
    actual_delivery_date: null,
    order_no: null,
    system_delivery_date: null,
    note: null,
  }
}

export function usePartDetail(partId: Ref<string>) {
  const router = useRouter()
  const {
    isManager,
    isClerk,
    isInspector,
    isCncProgrammer: isCnc,
  } = usePermissions()

  // ============ 权限 ============
  const canEditPart = computed(() => isManager.value || isClerk.value)
  const canCancelPart = computed(() => isManager.value || isClerk.value)
  const canDeletePart = computed(() => isManager.value)
  const canInspect = computed(
    () => isManager.value || isClerk.value || isInspector.value,
  )
  const canReceiveFromOutsource = computed(() => isManager.value || isClerk.value)
  /** 图纸 / 3D 模型：MANAGER + CLERK（文员日常操作） */
  const canManageDrawings = computed(() => isManager.value || isClerk.value)
  const canManage3DModels = computed(() => isManager.value || isClerk.value)
  /** G 代码 / 设定单：MANAGER + CNC_PROGRAMMER */
  const canManageCncFiles = computed(() => isManager.value || isCnc.value)
  const canManageSetupSheet = computed(() => isManager.value || isCnc.value)
  /** 批次管理：MANAGER + CLERK */
  const canManageBatches = computed(() => isManager.value || isClerk.value)

  // ============ 主数据 ============
  const part = ref<PartItem | null>(null)
  const infoLoading = ref(false)

  async function fetchPart(): Promise<void> {
    infoLoading.value = true
    try {
      part.value = await getPart(partId.value)
    } catch (e) {
      part.value = null
      ElMessage.error((e as Error).message ?? '加载零件失败')
    } finally {
      infoLoading.value = false
    }
  }

  // ============ 历史 ============
  const events = ref<PartEvent[] | null>(null)
  const eventsLoading = ref(false)
  async function fetchEvents(): Promise<void> {
    eventsLoading.value = true
    try {
      events.value = await listPartEvents(partId.value)
    } catch (e) {
      events.value = null
      ElMessage.error((e as Error).message ?? '加载历史记录失败')
    } finally {
      eventsLoading.value = false
    }
  }

  // ============ 行内编辑（PartInfoCard 读 editing/form/saving）============
  const editing = ref(false)
  const saving = ref(false)
  const form = reactive<PartEditForm>(makeEmptyEditForm())

  function onStartEdit(): void {
    if (!part.value) return
    form.name = part.value.name
    form.drawing_no = part.value.drawing_no
    form.quantity = part.value.quantity
    form.is_urgent = part.value.is_urgent
    form.planned_delivery_date = part.value.planned_delivery_date
    form.actual_delivery_date = part.value.actual_delivery_date
    form.order_no = part.value.order_no
    form.system_delivery_date = part.value.system_delivery_date
    form.note = part.value.note
    editing.value = true
  }

  function onCancelEdit(): void {
    editing.value = false
  }

  async function onSave(): Promise<void> {
    saving.value = true
    try {
      const payload: PartUpdatePayload = {
        name: form.name.trim(),
        drawing_no: form.drawing_no.trim(),
        quantity: form.quantity,
        is_urgent: form.is_urgent,
        planned_delivery_date: form.planned_delivery_date,
        actual_delivery_date: form.actual_delivery_date || null,
        order_no: form.order_no || null,
        system_delivery_date: form.system_delivery_date || null,
        note: form.note || null,
      }
      part.value = await updatePart(partId.value, payload)
      ElMessage.success('保存成功')
      editing.value = false
    } catch (e) {
      ElMessage.error((e as Error).message ?? '保存失败')
    } finally {
      saving.value = false
    }
  }

  // ============ 装配件详情（PartAssemblyLinkCard 用）============
  const assemblyDetail = ref<AssemblyDetail | null>(null)
  const assemblyLoading = ref(false)
  async function fetchAssembly(): Promise<void> {
    if (!part.value || part.value.assembly_id == null) {
      assemblyDetail.value = null
      return
    }
    assemblyLoading.value = true
    try {
      assemblyDetail.value = await getAssemblyForPart(part.value.id)
    } catch (e) {
      assemblyDetail.value = null
      ElMessage.error((e as Error).message ?? '加载装配件信息失败')
    } finally {
      assemblyLoading.value = false
    }
  }

  // ============ 取消订单 / 删除（confirm dialog 由 shell 持有 UI 状态）============
  /**
   * shell 收集到流水号后调用（流水号校验由 shell 负责）。
   * 成功后 shell 关闭 confirm dialog 并刷新。
   */
  async function onCancelOrder(): Promise<boolean> {
    try {
      await cancelPart(partId.value)
      ElMessage.success('已取消')
      await fetchPart()
      void fetchEvents()
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败')
      return false
    }
  }

  async function onDeletePart(): Promise<boolean> {
    try {
      await softDeletePart(partId.value)
      ElMessage.success('已删除')
      router.push('/parts')
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败')
      return false
    }
  }

  // ============ 品检通过 ============
  async function onPassInspection(): Promise<boolean> {
    if (!part.value) return false
    try {
      await passInspection(partId.value)
      ElMessage.success('品检通过')
      await fetchPart()
      void fetchEvents()
      return true
    } catch (e) {
      ElMessage.error(`品检通过失败：${(e as Error).message}`)
      return false
    }
  }

  // ============ 指定工序（failInsp dialog 由 shell 持有 UI 状态）============
  async function onFailInspection(payload: {
    shelfId: string
    processId: string
    note: string | null
  }): Promise<boolean> {
    try {
      await failInspection(partId.value, {
        shelf_id: payload.shelfId,
        next_process_id: payload.processId,
        note: payload.note,
      })
      ElMessage.success('已指定下一道工序')
      await fetchPart()
      void fetchEvents()
      return true
    } catch (e) {
      ElMessage.error(`指定工序失败：${(e as Error).message}`)
      return false
    }
  }

  // ============ 外协回收（receive dialog 由 shell 持有 UI 状态）============
  async function onReceiveFromOutsourceFn(payload: {
    shelfId: string
    processId: string
  }): Promise<boolean> {
    try {
      await receiveFromOutsource(partId.value, {
        shelf_id: payload.shelfId,
        next_process_id: payload.processId,
      })
      ElMessage.success('外协已回收')
      await fetchPart()
      void fetchEvents()
      return true
    } catch (e) {
      ElMessage.error(`外协回收失败：${(e as Error).message}`)
      return false
    }
  }

  // ============ 批次（PartBatchMonitorCard 渲染 + 拆分 / 取消）============
  const batches = ref<PartBatch[]>([])
  const batchesLoading = ref(false)
  async function fetchBatches(): Promise<void> {
    batchesLoading.value = true
    try {
      batches.value = await listPartBatches(partId.value)
    } catch (e) {
      batches.value = []
      ElMessage.error((e as Error).message ?? '加载批次失败')
    } finally {
      batchesLoading.value = false
    }
  }

  async function onSplitBatch(
    batch: PartBatch,
    quantity: number,
  ): Promise<PartBatch[] | null> {
    try {
      const newBatches = await splitPartBatch(partId.value, {
        batch_id: batch.id,
        quantity,
      })
      ElMessage.success('拆分成功')
      await fetchPart()
      void fetchEvents()
      return newBatches
    } catch (e) {
      ElMessage.error(`拆分失败：${(e as Error).message}`)
      return null
    }
  }

  async function onCancelBatch(batch: PartBatch): Promise<PartBatch[] | null> {
    try {
      const newBatches = await cancelPartBatch(partId.value, batch.id)
      ElMessage.success('批次已取消')
      await fetchPart()
      void fetchEvents()
      return newBatches
    } catch (e) {
      ElMessage.error(`取消批次失败：${(e as Error).message}`)
      return null
    }
  }

  // ============ 状态 / 事件标签 helpers ============
  function statusLabel(s: OrderStatus): string {
    return ORDER_STATUS_LABEL[s] ?? s
  }
  function statusTagType(s: OrderStatus): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
    return ORDER_STATUS_TAG_TYPE[s] ?? 'info'
  }
  function statusLabelOf(s: string | null | undefined): string {
    if (!s) return ''
    return ORDER_STATUS_LABEL[s as OrderStatus] ?? s
  }
  function eventLabel(t: string): string {
    return PART_EVENT_LABEL[t as PartEventType] ?? t
  }
  function eventTagType(t: string): 'primary' | 'success' | 'warning' | 'info' | 'danger' {
    return PART_EVENT_TAG_TYPE[t as PartEventType] ?? 'info'
  }

  // ============ 切 partId 时重置 ============
  watch(partId, (next) => {
    if (!next) return
    editing.value = false
    assemblyDetail.value = null
  })

  // part 加载后，若有 assembly_id 拉装配件详情
  watch(
    () => part.value?.assembly_id,
    () => {
      void fetchAssembly()
    },
  )

  return {
    // data
    part,
    infoLoading,
    events,
    eventsLoading,
    editing,
    saving,
    form,
    assemblyDetail,
    assemblyLoading,
    batches,
    batchesLoading,
    // permissions
    canEditPart,
    canCancelPart,
    canDeletePart,
    canInspect,
    canReceiveFromOutsource,
    canManageDrawings,
    canManage3DModels,
    canManageCncFiles,
    canManageSetupSheet,
    canManageBatches,
    // fetchers
    fetchPart,
    fetchEvents,
    fetchAssembly,
    fetchBatches,
    // edit
    onStartEdit,
    onCancelEdit,
    onSave,
    // cancel / delete
    onCancelOrder,
    onDeletePart,
    // inspection
    onPassInspection,
    onFailInspection,
    // outsource receive
    onReceiveFromOutsource: onReceiveFromOutsourceFn,
    // batch split / cancel
    onSplitBatch,
    onCancelBatch,
    // label helpers
    statusLabel,
    statusTagType,
    statusLabelOf,
    eventLabel,
    eventTagType,
  }
}
