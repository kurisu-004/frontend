<!--
  AssemblyDetail.vue

  /assemblies/:id — 装配件详情页（装配壳）。

  拆分为 4 个子组件 + 1 个 composable（2026-08-25 frontend-overall-refactor）：
  - <AssemblyInfoCard> — 信息卡 + 头部操作按钮
  - <AssemblyChildrenTable> — 子件表 + 添加子件 / 上传总装 PDF / 图号 PDF 预览
  - <AssemblyEditDialog> — 编辑元数据对话框（v-model:visible）
  - composable useAssemblyDetail — 业务状态 + fetcher + 业务函数（Promise<boolean>）

  Shell 责任：
  - route id 监听 + 调 fetchData
  - 编辑对话框可见性 / submitting（UI 状态，由 shell 自管）
  - 取消 / 删除共用确认对话框（留在 shell；逻辑简短）
  - 调 composable 的业务函数；按返回值决定是否关 dialog

  数据来源：GET /api/v1/assemblies/:id
-->
<template>
  <div class="assembly-detail" v-loading="loading">
    <AssemblyInfoCard
      v-if="detail"
      :assembly="detail.assembly"
      :can-edit-content="canEditContent"
      :can-cancel="canCancel"
      :can-delete="canDelete"
      :status-label="statusLabel"
      :status-tag-type="statusTagType"
      @back="onBack"
      @edit="openEditDialog"
      @cancel="openConfirmDialog('cancel')"
      @delete="openConfirmDialog('delete')"
    />

    <FileListCard
      v-if="detail"
      :files="masterFiles"
      owner-type="assembly"
      :owner-id="assemblyId"
      :show-upload="false"
      :show-delete="false"
      kind="ASSEMBLY_MASTER"
      @refresh="fetchData"
    />

    <AssemblyChildrenTable
      v-if="detail"
      :children="detail.children"
      :child-drawing-map="childDrawingMap"
      :can-add-child="canAddChild"
      :can-upload-total-pdf="canUploadTotalPdf"
      :add-child-form="addChildForm"
      :part-status-label="partStatusLabel"
      :part-status-tag-type="partStatusTagType"
      :child-row-class="childRowClass"
      :add-child="addChild"
      :upload-pdf="uploadPdf"
      :fetch-drawing-blob="fetchDrawingBlob"
      @refresh="fetchData"
    />

    <!-- 编辑元数据对话框（CLERK + MANAGER） -->
    <AssemblyEditDialog
      v-model:visible="editVisible"
      :submitting="editSubmitting"
      :customers="leafCustomers"
      :form="editForm"
      :query-applicants="queryApplicants"
      @open="loadLeafCustomers"
      @submit="onEditSubmit"
    />

    <!-- 取消 / 删除 共用确认对话框 -->
    <el-dialog
      v-model="confirmVisible"
      :title="confirmAction === 'cancel' ? '取消装配件' : '删除装配件'"
      :width="confirmDlg.width"
      :top="confirmDlg.top"
      :fullscreen="confirmDlg.fullscreen"
      :close-on-click-modal="false"
    >
      <p class="confirm-hint">
        {{
          confirmAction === 'cancel'
            ? `确认取消装配件「${detail?.assembly.name ?? ''}」？将级联取消 ${detail?.assembly.child_count ?? 0} 个非终态子件。`
            : `确认删除装配件「${detail?.assembly.name ?? ''}」？将级联软删 ${detail?.assembly.child_count ?? 0} 个子零件 + 全部关联文件。`
        }}
      </p>
      <el-form label-width="96px" style="margin-top: 16px">
        <el-form-item label="序列号">
          <el-input
            v-model="confirmSerial"
            :placeholder="`请输入装配件序列号：${detail?.assembly.serial_no ?? ''}`"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button
          :type="confirmAction === 'cancel' ? 'warning' : 'danger'"
          :loading="confirmSubmitting"
          :disabled="!confirmSerial.trim()"
          @click="onConfirmSubmit"
        >
          {{ confirmAction === 'cancel' ? '确认取消' : '确认删除' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FileListCard from '@/components/FileListCard.vue'
import { useDialogSize } from '@/composables/useDialogSize'
import type { AssemblyUpdatePayload } from '@/types/assembly'
import AssemblyInfoCard from './components/AssemblyInfoCard.vue'
import AssemblyChildrenTable from './components/AssemblyChildrenTable.vue'
import AssemblyEditDialog from './components/AssemblyEditDialog.vue'
import { useAssemblyDetail } from './composables/useAssemblyDetail'

const route = useRoute()
const router = useRouter()

// ============ 路由 → assemblyId ============
const assemblyId = computed<string>(() => {
  const raw = route.params.id
  return String(Array.isArray(raw) ? raw[0] : raw ?? '')
})

// ============ composable：业务状态 + 业务函数 ============
const {
  detail,
  loading,
  masterFiles,
  childDrawingMap,
  canCancel,
  canDelete,
  canEditContent,
  canAddChild,
  canUploadTotalPdf,
  editForm,
  addChildForm,
  populateEditForm,
  leafCustomers,
  queryApplicants,
  fetchData,
  loadLeafCustomers,
  updateAssembly,
  cancelAssembly,
  deleteAssembly,
  addChild,
  uploadPdf,
  fetchDrawingBlob,
  statusLabel,
  statusTagType,
  partStatusLabel,
  partStatusTagType,
  childRowClass,
} = useAssemblyDetail(assemblyId)

// ============ 编辑对话框（UI 状态留在 shell；宽度由 AssemblyEditDialog 内部 useDialogSize 管）============
const editVisible = ref(false)
const editSubmitting = ref(false)

function openEditDialog(): void {
  populateEditForm()
  editVisible.value = true
}

async function onEditSubmit(payload: AssemblyUpdatePayload): Promise<void> {
  editSubmitting.value = true
  try {
    const ok = await updateAssembly(payload)
    if (ok) editVisible.value = false
  } finally {
    editSubmitting.value = false
  }
}

// ============ 取消 / 删除 共用确认对话框 ============
const confirmDlg = useDialogSize({ desktopWidth: 480 })
const confirmVisible = ref(false)
const confirmAction = ref<'cancel' | 'delete'>('cancel')
const confirmSerial = ref('')
const confirmSubmitting = ref(false)

function openConfirmDialog(action: 'cancel' | 'delete'): void {
  confirmAction.value = action
  confirmSerial.value = ''
  confirmVisible.value = true
}

async function onConfirmSubmit(): Promise<void> {
  if (!detail.value) return
  confirmSubmitting.value = true
  try {
    const ok = confirmAction.value === 'cancel'
      ? await cancelAssembly(confirmSerial.value)
      : await deleteAssembly(confirmSerial.value)
    if (ok) confirmVisible.value = false
  } finally {
    confirmSubmitting.value = false
  }
}

// ============ 导航 ============
function onBack(): void {
  router.push('/parts')
}

watch(() => route.params.id, fetchData)
onMounted(fetchData)
</script>

<style lang="scss" scoped>
.assembly-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
