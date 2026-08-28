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
          <!-- 2026-08-27 Task 9：列设置 -->
          <ColumnVisibilityPopover
            :defs="columnDefs"
            :model-value="columnVisibility.currentMap"
            @update:model-value="columnVisibility.update"
            @reset="columnVisibility.showAll"
            @reset-order="drag.reset"
          />
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
      ref="tableRef"
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
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :align="d.align"
          :sortable="d.sortable"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
          :label-class-name="drag.dragLabelClass(d)"
        >
          <template v-if="d.cellRender" #default="scope">
            <component :is="d.cellRender(scope)" />
          </template>
          <template v-if="resolveDraggable(d) && !d.type && !d.fixed" #header>
            <span>{{ d.label }}</span>
            <ColumnDragHandle :title="`拖动 ${d.label} 列`" />
          </template>
        </el-table-column>
      </template>
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
import { h, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { UploadFile, FormInstance } from 'element-plus'
import { ElLink, ElMessage, ElTag } from 'element-plus'
import { Loading, Plus, Upload } from '@element-plus/icons-vue'

import PdfViewer from '@/components/PdfViewer.vue'
import { useDialogSize } from '@/composables/useDialogSize'
import type { PartFileItem } from '@/types/part_file'
import type { PartListItem } from '@/types/parts'
import type { OrderStatus } from '@/types/parts'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
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

// ============ 2026-08-27 Task 9：子件表列顺序拖动 + 可见性 ============
// 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
// MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
// type=index 的「#」列与 fixed=right 的「操作」列不进 defs。
const tableRef = ref()
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no', label: '序列号', prop: 'serial_no', minWidth: 100, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      return r.serial_no
        ? h(ElTag, { type: 'success', size: 'small', effect: 'dark' }, () => r.serial_no)
        : h('span', { class: 'muted' }, '未分配')
    },
  },
  {
    key: 'drawing_no', label: '图号', prop: 'drawing_no', minWidth: 160, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      // 硬约束 #11：EP 合成空行 { row: {} } → r.id 可能 undefined，需守卫
      const drawing = r.id ? props.childDrawingMap[r.id] : undefined
      return drawing
        ? h(
          ElLink,
          { type: 'primary', onClick: () => void onChildDrawingClick(r, drawing) },
          () => r.drawing_no,
        )
        : h('span', { class: 'mono' }, r.drawing_no)
    },
  },
  {
    key: 'name', label: '名称', prop: 'name', minWidth: 160, align: 'center',
    showOverflowTooltip: true,
  },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 70, align: 'right' },
  {
    key: 'status', label: '状态', prop: 'status', minWidth: 100, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      return h(
        ElTag,
        { type: props.partStatusTagType(r.status), size: 'small' },
        () => props.partStatusLabel(r.status),
      )
    },
  },
  {
    key: 'planned_delivery_date', label: '计划交期', prop: 'planned_delivery_date',
    minWidth: 120, align: 'center',
  },
  {
    key: 'current_holder_display', label: '所在位置', prop: 'current_holder_display',
    minWidth: 160, align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem
      return r.current_holder_display
        ? h('span', r.current_holder_display)
        : h('span', { class: 'muted' }, '—')
    },
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'assembly_children' })
const drag = useColumnDrag(columnDefs, { listKey: 'assembly_children' })
// 2026-08-28 改造：直接传实例 ref；composable 内部 watch(ref) + MutationObserver 自愈。
drag.applyDrag(tableRef)

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
