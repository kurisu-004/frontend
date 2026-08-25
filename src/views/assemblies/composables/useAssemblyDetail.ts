// views/assemblies/composables/useAssemblyDetail.ts
//
// 2026-08-25 frontend-overall-refactor：AssemblyDetail 拆分的 useAssemblyDetail。
// 负责 /assemblies/:id 详情页的所有 page-level 业务：
// - 装配件主信息 fetchData
// - 文件过滤（masterFiles / childDrawingMap）
// - 权限矩阵（cancel / delete / edit-content / add-child / upload-pdf）
// - 编辑元数据（updateAssembly）+ 取消 / 删除
// - 添加子件 + 上传总装 PDF
// - 子件图号点击 → 全屏 PDF 预览（Blob URL）
// - 客户列表加载（编辑对话框用）+ 申请人搜索
// - 状态标签 helpers
//
// 设计要点：
// - composable 只持有「业务数据 + 业务函数」；dialog 可见性、FormInstance refs、
//   form 局部数据由 shell 或各 dialog 子组件持有。
// - 所有破坏性操作（cancel / delete / update）返回 Promise<boolean>，
//   由调用方（shell / dialog）根据返回值决定是否关闭 dialog。
// - 出错统一在 composable 内 ElMessage 提示（fetchData 除外——它把 null 留给 shell）；
//   子件添加等业务操作返回 false 时不再二次提示。

import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { UploadFile, FormRules } from 'element-plus'
import {
  addAssemblyChild,
  cancelAssembly,
  getAssembly,
  softDeleteAssembly,
  updateAssembly,
  uploadAssemblyPdf,
} from '@/api/assembly'
import { api } from '@/api/http'
import { listCustomers, type Customer } from '@/api/customer'
import type { PartFileItem } from '@/types/part_file'
import type { Applicant } from '@/types/applicant'
import { useApplicantSearch } from '@/composables/useApplicantSearch'
import { usePermissions } from '@/composables/usePermissions'
import {
  ASSEMBLY_STATUS_LABEL,
  ASSEMBLY_STATUS_TAG_TYPE,
  type AssemblyDetail,
  type AssemblyStatus,
  type AssemblyUpdatePayload,
} from '@/types/assembly'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type OrderStatus,
} from '@/types/parts'

/** 编辑装配件元数据表单（可空字段用空字符串占位，提交时转回 null）。 */
export interface AssemblyEditForm {
  drawing_no: string
  name: string
  customer_id: string
  applicant_name: string
  applicant_id: string
  request_date: string
  planned_delivery_date: string
  actual_delivery_date: string
  is_urgent: boolean
}

function makeEmptyEditForm(): AssemblyEditForm {
  return {
    drawing_no: '',
    name: '',
    customer_id: '',
    applicant_name: '',
    applicant_id: '',
    request_date: '',
    planned_delivery_date: '',
    actual_delivery_date: '',
    is_urgent: false,
  }
}

/** 添加子件表单。 */
export interface AssemblyAddChildForm {
  drawing_no: string
  name: string
  quantity: number
}

function makeEmptyAddChildForm(): AssemblyAddChildForm {
  return { drawing_no: '', name: '', quantity: 1 }
}

/** 编辑对话框表单规则。 */
export const ASSEMBLY_EDIT_RULES: FormRules = {
  drawing_no: [{ required: true, message: '请输入总图图号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入装配体名称', trigger: 'blur' }],
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
}

/** 添加子件对话框表单规则。 */
export const ASSEMBLY_ADD_CHILD_RULES: FormRules = {
  drawing_no: [{ required: true, message: '请输入图号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
}

/** 客户 option label 工具：二级带父级名前缀。 */
export function formatCustomerOptionLabel(
  c: { name: string; parent_name: string | null },
): string {
  return c.parent_name ? `${c.parent_name} / ${c.name}` : c.name
}

export interface UseAssemblyDetailReturn {
  // data
  detail: Ref<AssemblyDetail | null>
  loading: Ref<boolean>
  /** 仅 master 文件（FileListCard 用） */
  masterFiles: ComputedRef<PartFileItem[]>
  /** 子件 id → DRAWING 文件映射（点子件图号直接预览） */
  childDrawingMap: ComputedRef<Record<string, PartFileItem>>
  // permissions
  canCancel: ComputedRef<boolean>
  canDelete: ComputedRef<boolean>
  canEditContent: ComputedRef<boolean>
  canAddChild: ComputedRef<boolean>
  canUploadTotalPdf: ComputedRef<boolean>
  // edit form state
  editForm: AssemblyEditForm
  addChildForm: AssemblyAddChildForm
  // customer + applicant (edit dialog 用)
  leafCustomers: Ref<Customer[]>
  loadingCustomers: Ref<boolean>
  queryApplicants: (qs: string, cb: (items: Applicant[]) => void) => void
  // fetchers
  fetchData: () => Promise<void>
  loadLeafCustomers: () => Promise<void>
  // actions — return Promise<boolean>（true = 业务成功，调用方据此关 dialog）
  updateAssembly: (payload: AssemblyUpdatePayload) => Promise<boolean>
  cancelAssembly: (serialInput: string) => Promise<boolean>
  deleteAssembly: (serialInput: string) => Promise<boolean>
  addChild: () => Promise<boolean>
  uploadPdf: (file: UploadFile) => Promise<boolean>
  /** 子件图号点击 → 拉 PDF Blob，返回 blob URL（或抛错）。 */
  fetchDrawingBlob: (drawing: PartFileItem) => Promise<string>
  // helpers
  statusLabel: (s: AssemblyStatus | string) => string
  statusTagType: (s: AssemblyStatus | string) => 'info' | 'warning' | 'success' | 'danger' | 'primary'
  partStatusLabel: (s: OrderStatus | string) => string
  partStatusTagType: (s: OrderStatus | string) => 'success' | 'warning' | 'info' | 'danger' | 'primary'
  childRowClass: (row: { is_urgent: boolean }) => string
  /** 把 detail.assembly 当前值灌进 editForm（openEditDialog 时调） */
  populateEditForm: () => void
  /** 重置 addChildForm 到默认值 */
  resetAddChildForm: () => void
}

export function useAssemblyDetail(
  assemblyId: Ref<string>,
): UseAssemblyDetailReturn {
  const router = useRouter()
  const { isManager, isClerk } = usePermissions()

  // ============ 权限 ============
  const canCancel = computed(() => isManager.value || isClerk.value)
  const canDelete = computed(() => isManager.value)
  const canEditContent = computed(() => isManager.value || isClerk.value)

  // ============ 主数据 ============
  const detail = ref<AssemblyDetail | null>(null)
  const loading = ref(false)

  async function fetchData(): Promise<void> {
    if (!assemblyId.value) return
    loading.value = true
    try {
      detail.value = await getAssembly(assemblyId.value)
    } catch (e) {
      detail.value = null
      ElMessage.error((e as Error).message ?? '加载装配件详情失败')
    } finally {
      loading.value = false
    }
  }

  // ============ 文件过滤 ============
  const masterFiles = computed<PartFileItem[]>(
    () =>
      (detail.value?.files ?? []).filter(
        (f) => f.kind === 'ASSEMBLY_MASTER',
      ) as PartFileItem[],
  )

  const childDrawingMap = computed<Record<string, PartFileItem>>(() => {
    const m: Record<string, PartFileItem> = {}
    for (const f of detail.value?.files ?? []) {
      if (f.kind === 'DRAWING' && f.owner_id) {
        // repository 端 list_for_assembly 已按 id DESC，单 key 直接覆盖（最新一条胜）
        m[f.owner_id] = f as PartFileItem
      }
    }
    return m
  })

  // ============ 派生权限 ============
  const canUploadTotalPdf = computed(() => {
    if (!canEditContent.value) return false
    if (!detail.value) return false
    if (detail.value.assembly.serial_no) return false  // 已分过 serial 不能再上传
    if (detail.value.files.length > 0) return false
    if (detail.value.children.length > 0) return false
    return detail.value.assembly.status === 'PENDING'
  })

  const canAddChild = computed(() => {
    if (!canEditContent.value) return false
    if (!detail.value) return false
    return detail.value.assembly.status === 'PENDING'
  })

  // ============ 表单状态 ============
  const editForm = reactive<AssemblyEditForm>(makeEmptyEditForm())
  const addChildForm = reactive<AssemblyAddChildForm>(makeEmptyAddChildForm())

  function populateEditForm(): void {
    if (!detail.value) return
    const a = detail.value.assembly
    editForm.drawing_no = a.drawing_no
    editForm.name = a.name
    editForm.customer_id = a.customer_id
    editForm.applicant_name = a.applicant_name ?? ''
    editForm.applicant_id = ''
    editForm.request_date = a.request_date
    editForm.planned_delivery_date = a.planned_delivery_date
    editForm.actual_delivery_date = a.actual_delivery_date ?? ''
    editForm.is_urgent = a.is_urgent
  }

  function resetAddChildForm(): void {
    addChildForm.drawing_no = ''
    addChildForm.name = ''
    addChildForm.quantity = 1
  }

  // ============ 客户列表 + 申请人搜索（编辑对话框用）============
  const leafCustomers = ref<Customer[]>([])
  const loadingCustomers = ref(false)
  async function loadLeafCustomers(): Promise<void> {
    loadingCustomers.value = true
    try {
      const all = await listCustomers()
      leafCustomers.value = all.filter((c) => c.parent_id !== null)
    } catch (e) {
      leafCustomers.value = []
      ElMessage.error((e as Error).message ?? '加载客户列表失败')
    } finally {
      loadingCustomers.value = false
    }
  }

  // 装配体的 applicant 解析到一级客户需 detail.customer_id，
  // 但编辑流中 customer 也允许改，这里保持原行为 fallback null。
  const { querySearch: queryApplicants } = useApplicantSearch({
    resolveRootCustomerId: () => null,
  })

  // ============ 业务操作 ============
  async function updateAssemblyFn(
    payload: AssemblyUpdatePayload,
  ): Promise<boolean> {
    if (!assemblyId.value) return false
    try {
      const updated = await updateAssembly(assemblyId.value, payload)
      detail.value = updated
      ElMessage.success('已保存')
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '保存失败')
      return false
    }
  }

  async function cancelAssemblyFn(serialInput: string): Promise<boolean> {
    if (!detail.value) return false
    const a = detail.value.assembly
    if (!a.serial_no) {
      ElMessage.warning('该装配体暂无序列号，无法执行此操作')
      return false
    }
    if (serialInput.trim() !== a.serial_no) {
      ElMessage.error('序列号不匹配')
      return false
    }
    try {
      const updated = await cancelAssembly(a.id)
      ElMessage.success('已取消装配件')
      detail.value = updated
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败')
      return false
    }
  }

  async function deleteAssemblyFn(serialInput: string): Promise<boolean> {
    if (!detail.value) return false
    const a = detail.value.assembly
    if (!a.serial_no) {
      ElMessage.warning('该装配体暂无序列号，无法执行此操作')
      return false
    }
    if (serialInput.trim() !== a.serial_no) {
      ElMessage.error('序列号不匹配')
      return false
    }
    try {
      await softDeleteAssembly(a.id)
      ElMessage.success('已删除')
      router.push('/parts')
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '操作失败')
      return false
    }
  }

  async function addChildFn(): Promise<boolean> {
    if (!assemblyId.value) return false
    try {
      await addAssemblyChild(assemblyId.value, {
        drawing_no: addChildForm.drawing_no.trim(),
        name: addChildForm.name.trim(),
        quantity: addChildForm.quantity,
      })
      ElMessage.success('子件已添加')
      resetAddChildForm()
      await fetchData()
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '添加子件失败')
      return false
    }
  }

  async function uploadPdfFn(file: UploadFile): Promise<boolean> {
    if (!file.raw) return false
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      ElMessage.error('总装文件必须是 .pdf 后缀')
      return false
    }
    if (!assemblyId.value) return false
    try {
      const updated = await uploadAssemblyPdf(assemblyId.value, file.raw)
      detail.value = updated
      ElMessage.success(
        `上传成功：自动创建 ${updated.children.length} 个子件`,
      )
      return true
    } catch (e) {
      ElMessage.error((e as Error).message ?? '上传总装 PDF 失败')
      return false
    }
  }

  /**
   * 拉取 PDF Blob（子件图号点击 → 全屏预览用）。
   * 调用方负责 URL.revokeObjectURL 释放（onDrawingPreviewClosed）。
   */
  async function fetchDrawingBlob(drawing: PartFileItem): Promise<string> {
    const resp = await api.get<Blob>(`/files/${drawing.id}/content`, {
      responseType: 'blob',
    })
    return URL.createObjectURL(resp.data)
  }

  // ============ 状态标签 helpers ============
  function statusLabel(s: AssemblyStatus | string): string {
    return ASSEMBLY_STATUS_LABEL[s as AssemblyStatus] ?? String(s)
  }
  function statusTagType(
    s: AssemblyStatus | string,
  ): 'info' | 'warning' | 'success' | 'danger' | 'primary' {
    return ASSEMBLY_STATUS_TAG_TYPE[s as AssemblyStatus] ?? 'info'
  }
  function partStatusLabel(s: OrderStatus | string): string {
    return ORDER_STATUS_LABEL[s as OrderStatus] ?? String(s)
  }
  function partStatusTagType(
    s: OrderStatus | string,
  ): 'success' | 'warning' | 'info' | 'danger' | 'primary' {
    return ORDER_STATUS_TAG_TYPE[s as OrderStatus] ?? 'info'
  }
  function childRowClass(row: { is_urgent: boolean }): string {
    return row.is_urgent ? 'row-urgent' : ''
  }

  // 切 assemblyId 时重置
  watch(
    assemblyId,
    () => {
      detail.value = null
    },
    { immediate: true },
  )

  return {
    // data
    detail,
    loading,
    masterFiles,
    childDrawingMap,
    // permissions
    canCancel,
    canDelete,
    canEditContent,
    canAddChild,
    canUploadTotalPdf,
    // forms
    editForm,
    addChildForm,
    populateEditForm,
    resetAddChildForm,
    // customer + applicant
    leafCustomers,
    loadingCustomers,
    queryApplicants,
    // fetchers
    fetchData,
    loadLeafCustomers,
    // actions
    updateAssembly: updateAssemblyFn,
    cancelAssembly: cancelAssemblyFn,
    deleteAssembly: deleteAssemblyFn,
    addChild: addChildFn,
    uploadPdf: uploadPdfFn,
    fetchDrawingBlob,
    // helpers
    statusLabel,
    statusTagType,
    partStatusLabel,
    partStatusTagType,
    childRowClass,
  }
}
