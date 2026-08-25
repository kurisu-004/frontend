<!--
  AssemblyChildrenTable.vue

  装配件「子件 / 上传 PDF」复合区域：
  - 上传总装 PDF 卡（仅当 canUploadTotalPdf 时显示）
  - 子件表格卡（el-table；手机卡片视图 2026-08-25 mobile 清理已移除）
  - 「添加子件」对话框（含 form 状态 + form ref + 校验）
  - 「子件图号点击」全屏 PDF 预览对话框（含 Blob URL 生命周期）

  本组件持有以下 UI 状态：
  - addChildVisible / addChildSubmitting / addChildFormRef
  - addChildForm（由父组件通过 prop 注入——composable 持有 source of truth）
  - drawingPreviewVisible / drawingPreviewFile / drawingPreviewBlobUrl

  业务函数（addChild / uploadPdf / fetchDrawingBlob）由父组件通过 prop 注入；
  本组件只负责 UI 编排 + 表单校验 + Blob URL 释放。

  2026-08-25 frontend-overall-refactor：从 AssemblyDetail.vue 抽出。
-->
<template>
  <!-- 上传总装 PDF：仅当装配体当前没有 master + 没有子件时才可上传 -->
  <el-card v-if="canUploadTotalPdf" shadow="never" class="upload-pdf-card">
    <div class="upload-pdf-row">
      <div class="upload-pdf-hint">
        <el-icon><Upload /></el-icon>
        <span>
          该装配体暂无总装 PDF。
          <strong>上传 PDF 后系统会自动按页拆分子件</strong>（第 1 页 = 总装图，第 2..N 页 = 子件 01、02…）。
        </span>
      </div>
      <el-upload
        :show-file-list="false"
        :auto-upload="false"
        :on-change="onUploadTotalPdf"
        accept=".pdf"
      >
        <el-button type="primary" :loading="uploading">
          <el-icon><Upload /></el-icon>
          <span>上传总装 PDF（自动拆分子件）</span>
        </el-button>
      </el-upload>
    </div>
  </el-card>

  <el-card shadow="never" class="children-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">
          子零件
          <el-tag v-if="children" type="info" size="small" effect="plain">
            {{ children.length }} 个
          </el-tag>
        </span>
        <div class="card-actions">
          <el-button
            type="primary"
            plain
            :disabled="!canAddChild"
            @click="openAddChildDialog"
          >
            <el-icon><Plus /></el-icon>
            <span>添加子件</span>
          </el-button>
        </div>
      </div>
    </template>

    <el-table
      :data="children ?? []"
      row-key="id"
      border
      stripe
      size="small"
      :row-class-name="childRowClass"
    >
      <template #empty>
        <el-empty description="暂无子零件" />
      </template>
      <el-table-column type="index" label="#" width="50" />
      <el-table-column label="序列号" min-width="100" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.serial_no" type="success" size="small" effect="dark">
            {{ row.serial_no }}
          </el-tag>
          <span v-else class="muted">未分配</span>
        </template>
      </el-table-column>
      <el-table-column label="图号" min-width="160" align="center">
        <template #default="{ row }">
          <el-link
            v-if="childDrawingMap[row.id]"
            type="primary"
            @click="onChildDrawingClick(row, childDrawingMap[row.id]!)"
          >
            {{ row.drawing_no }}
          </el-link>
          <span v-else class="mono">{{ row.drawing_no }}</span>
        </template>
      </el-table-column>
      <el-table-column
        prop="name"
        label="名称"
        min-width="160"
        show-overflow-tooltip
        align="center"
      />
      <el-table-column prop="quantity" label="数量" min-width="70" align="right" />
      <el-table-column label="状态" min-width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="partStatusTagType(row.status)" size="small">
            {{ partStatusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="计划交期" min-width="120" align="center">
        <template #default="{ row }">{{ row.planned_delivery_date }}</template>
      </el-table-column>
      <el-table-column label="所在位置" min-width="160" align="center">
        <template #default="{ row }">
          <span v-if="row.current_holder_display">{{ row.current_holder_display }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="80" align="center" fixed="right">
        <template #default="{ row }">
          <el-button
            link
            type="primary"
            size="small"
            @click="goPartDetail(row.id)"
          >
            详情
          </el-button>
        </template>
      </el-table-column>

      <!-- 手机卡片视图已移除（2026-08-25 mobile 适配清理） -->
    </el-table>
  </el-card>

  <!-- 子件图号直接预览 PDF（全屏） -->
  <el-dialog
    :model-value="drawingPreviewVisible"
    :title="drawingPreviewFile?.original_filename ?? '图纸预览'"
    fullscreen
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => (drawingPreviewVisible = v)"
    @closed="onDrawingPreviewClosed"
  >
    <PdfViewer
      v-if="drawingPreviewFile && drawingPreviewBlobUrl"
      :url="drawingPreviewBlobUrl"
      :page="1"
    />
    <div v-else class="loading-tip">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>加载中…</span>
    </div>
  </el-dialog>

  <!-- 添加子件对话框 -->
  <el-dialog
    :model-value="addChildVisible"
    title="添加子件"
    :width="addChildDlg.width"
    :top="addChildDlg.top"
    :fullscreen="addChildDlg.fullscreen"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => (addChildVisible = v)"
    @closed="onAddChildClosed"
  >
    <p class="confirm-hint">
      为本装配体添加一个子件。如需为该子件上传 PDF，请到子件详情页使用「上传图纸」按钮。
    </p>
    <el-form
      ref="addChildFormRef"
      :model="addChildForm"
      :rules="addChildRules"
      label-width="96px"
    >
      <el-form-item label="图号" prop="drawing_no">
        <el-input v-model="addChildForm.drawing_no" placeholder="例如：E42FX1020107101-1" />
      </el-form-item>
      <el-form-item label="名称" prop="name">
        <el-input v-model="addChildForm.name" placeholder="例如：基础板" />
      </el-form-item>
      <el-form-item label="数量" prop="quantity">
        <el-input-number
          v-model="addChildForm.quantity"
          :min="1"
          :step="1"
          controls-position="right"
          style="width: 100%"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="addChildVisible = false">取消</el-button>
      <el-button type="primary" :loading="addChildSubmitting" @click="onAddChildSubmit">
        添加
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import type { UploadFile, FormInstance } from 'element-plus'
import { ElMessage } from 'element-plus'
import { Loading, Plus, Upload } from '@element-plus/icons-vue'

import PdfViewer from '@/components/PdfViewer.vue'
import { useDialogSize } from '@/composables/useDialogSize'
import type { PartFileItem } from '@/types/part_file'
import type { PartListItem } from '@/types/parts'
import type { OrderStatus } from '@/types/parts'
import {
  ASSEMBLY_ADD_CHILD_RULES,
  type AssemblyAddChildForm,
} from '../composables/useAssemblyDetail'

interface Props {
  children: PartListItem[] | null
  /** 子件 id → DRAWING 文件映射（点子件图号直接预览） */
  childDrawingMap: Record<string, PartFileItem>
  /** 权限 flag */
  canAddChild: boolean
  canUploadTotalPdf: boolean
  /** form 数据（composable 持有 source of truth，本组件直接 v-model） */
  addChildForm: AssemblyAddChildForm
  /** 状态 → label / tag-type（composable 提供） */
  partStatusLabel: (s: OrderStatus | string) => string
  partStatusTagType: (s: OrderStatus | string) => 'success' | 'warning' | 'info' | 'danger' | 'primary'
  childRowClass: (row: { is_urgent: boolean }) => string
  /** 业务函数（composable 注入） */
  addChild: () => Promise<boolean>
  uploadPdf: (file: UploadFile) => Promise<boolean>
  fetchDrawingBlob: (drawing: PartFileItem) => Promise<string>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** 添加子件 / 上传 PDF 成功后由父组件 refresh */
  (e: 'refresh'): void
}>()

const router = useRouter()

const addChildDlg = useDialogSize({ desktopWidth: 480 })

// ============ 添加子件对话框状态 ============
const addChildVisible = ref(false)
const addChildSubmitting = ref(false)
const addChildFormRef = ref<FormInstance>()
const addChildRules = ASSEMBLY_ADD_CHILD_RULES

function openAddChildDialog(): void {
  addChildVisible.value = true
}

function onAddChildClosed(): void {
  // dialog close 时不重置 form（保持用户已输入）——仅提交成功 / 取消时 reset
}

async function onAddChildSubmit(): Promise<void> {
  if (!addChildFormRef.value) return
  try {
    await addChildFormRef.value.validate()
  } catch {
    return
  }
  addChildSubmitting.value = true
  try {
    const ok = await props.addChild()
    if (ok) {
      addChildVisible.value = false
      emit('refresh')
    }
  } finally {
    addChildSubmitting.value = false
  }
}

// ============ 上传总装 PDF ============
const uploading = ref(false)
async function onUploadTotalPdf(uploadFile: UploadFile): Promise<void> {
  uploading.value = true
  try {
    const ok = await props.uploadPdf(uploadFile)
    if (ok) emit('refresh')
  } finally {
    uploading.value = false
  }
}

// ============ 子件图号 → 全屏 PDF 预览 ============
const drawingPreviewVisible = ref(false)
const drawingPreviewFile = ref<PartFileItem | null>(null)
const drawingPreviewBlobUrl = ref('')

async function onChildDrawingClick(
  _row: unknown,
  drawing: PartFileItem,
): Promise<void> {
  drawingPreviewFile.value = drawing
  drawingPreviewVisible.value = true
  try {
    if (drawingPreviewBlobUrl.value) {
      URL.revokeObjectURL(drawingPreviewBlobUrl.value)
    }
    drawingPreviewBlobUrl.value = await props.fetchDrawingBlob(drawing)
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载图纸失败')
    drawingPreviewVisible.value = false
  }
}

function onDrawingPreviewClosed(): void {
  if (drawingPreviewBlobUrl.value) {
    URL.revokeObjectURL(drawingPreviewBlobUrl.value)
  }
  drawingPreviewBlobUrl.value = ''
  drawingPreviewFile.value = null
}

function goPartDetail(id: string): void {
  router.push(`/parts/${id}`)
}
</script>

<style lang="scss" scoped>
.upload-pdf-card,
.children-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
.upload-pdf-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.upload-pdf-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-regular);
  font-size: 13px;
  flex: 1;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-size: 16px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.card-actions {
  display: flex;
  gap: 8px;
}
.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: var(--text-regular);
}
.muted {
  color: var(--text-secondary);
}
.loading-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 80px 0;
  color: var(--text-regular);
}
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>
