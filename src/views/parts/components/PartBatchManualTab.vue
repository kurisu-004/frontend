<!--
  PartBatchManualTab.vue

  Tab 1「录入」内容：
  - 待新增零件列表（el-table）
  - 添加 / 编辑 Dialog
  - 只读预览 Dialog
  - 图纸预览 Dialog

  2026-08-25 拆分：原 PartBatchNew.vue 第 23-365 行整段挪到本组件，state + handler
  在父组件 usePartBatchManual() 里；本组件 props 全部由父组件 `v-bind` 摊开传入。

  2026-08-25 mobile 适配清理：删除 ResponsiveList 包装，改为纯 el-table（手机卡片视图随 T1 一并撤掉）。

  2026-08-27 T21（B 组 batch 1）：接入列顺序拖动 + ColumnVisibilityPopover。
  - el-table 在 `<el-card>` 内持续挂载（v-else 控制 table vs empty-zone）→
    HTMLElement 路径，onMounted 调 findElTableThead(tableRef.$el) + drag.applyDrag。
  - 「#」index 列 + 「操作」fixed 列保留为字面量 <el-table-column>。
  - 列定义 cellRender 全部用 h()（el-button @click.stop 用 stopPropagation 模拟）。
-->

<template>
  <p class="hint">
    点击下方空白区域或「+ 添加零件」按钮，逐条录入零件信息（含图纸），最后统一提交。
  </p>

  <el-card shadow="never" class="staging-card">
    <div class="staging-header">
      <div class="staging-title-wrap">
        <h3 class="staging-title">待新增零件</h3>
        <span class="staging-count">共 {{ staged.length }} 条</span>
      </div>
      <div class="staging-header-actions">
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>
          <span>添加零件</span>
        </el-button>
      </div>
    </div>

    <!-- 空态：点空白处打开 dialog -->
    <div
      v-if="staged.length === 0"
      class="empty-zone"
      @click="openAddDialog"
    >
      <el-icon :size="64" color="#c0c4cc"><DocumentAdd /></el-icon>
      <p class="empty-primary">暂无待新增零件</p>
      <p class="empty-sub">点击此处或右上角「+ 添加零件」开始添加</p>
    </div>

    <!-- 2026-08-27 T21：列设置按钮（仅列表态展示；空态无表可设） -->
    <div v-else class="table-toolbar">
      <ColumnVisibilityPopover
        :defs="columnDefs"
        :model-value="columnVisibility.currentMap"
        @update:model-value="columnVisibility.update"
        @reset="columnVisibility.showAll"
        @reset-order="drag.reset"
      />
    </div>

    <!-- 列表态 -->
    <el-table
      v-if="staged.length > 0"
      ref="tableRef"
      :data="staged"
      row-key="uid"
      border
      stripe
      size="small"
      :row-class-name="rowClassName"
      @row-click="onRowPreview"
    >
      <template #empty>
        <el-empty description="暂无待新增零件" />
      </template>
      <el-table-column type="index" label="#" width="50" />
      <!--
        2026-08-27 T21：列顺序拖动接入。drag.orderedDefs 提供持久化顺序；
        用 <template v-for> 包裹以兼容 Vue 3 同元素 v-for + v-if 优先级问题。
        fixed="right" 操作列保留为字面量 <el-table-column>。
      -->
      <template v-for="d in drag.orderedDefs.value" :key="columnIdentifier(d)">
        <el-table-column
          v-if="columnVisibility.isVisible(d.key)"
          :prop="d.prop ?? d.key"
          :label="d.label"
          :width="d.width"
          :min-width="d.minWidth"
          :sortable="d.sortable"
          :align="d.align"
          :header-align="d.headerAlign"
          :show-overflow-tooltip="d.showOverflowTooltip"
          :column-key="d.columnKey ?? d.key"
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
      <el-table-column label="操作" min-width="120" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click.stop="onRowPreview(row as StagedEntry)">查看</el-button>
          <el-button link type="danger" size="small" @click.stop="onRemoveRow((row as StagedEntry).uid)">删除</el-button>
        </template>
      </el-table-column>

      <!-- 手机卡片视图已移除（2026-08-25 mobile 适配清理） -->
    </el-table>

    <div class="staging-footer">
      <el-button :disabled="staged.length === 0 || submitting" @click="onClearAll">
        清空
      </el-button>
      <el-button
        type="primary"
        :loading="submitting"
        :disabled="staged.length === 0"
        @click="onSubmit"
      >
        <el-icon><Upload /></el-icon>
        <span>提交 {{ staged.length }} 条</span>
      </el-button>
    </div>
  </el-card>

  <!-- 添加 / 编辑 Dialog -->
  <el-dialog
    :model-value="addDialogVisible"
    :title="editingUid ? '编辑零件' : '添加零件'"
    :width="addDlg.width"
    :top="addDlg.top"
    :fullscreen="addDlg.fullscreen"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => !v && closeAddDialog()"
    @closed="handleDialogClosed"
  >
    <el-form
      ref="formRefLocal"
      :model="form"
      :rules="rules"
      label-width="100px"
      label-position="right"
    >
      <div class="form-grid">
        <div>
          <el-form-item label="图号" prop="drawingNo">
            <el-input v-model="form.drawingNo" placeholder="例如：LT39822" />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" placeholder="请输入品名 / 零件名称" />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="客户" prop="customerId">
            <el-cascader
              v-model="form.customerId"
              :options="customerTree"
              :props="{ value: 'id', label: 'name', children: 'children', checkStrictly: true, emitPath: false }"
              placeholder="选择一级 / 二级客户"
              style="width: 100%"
              clearable
              @change="onCustomerChange"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="申请人" prop="applicantName">
            <el-autocomplete
              v-model="form.applicantName"
              value-key="name"
              :fetch-suggestions="querySearch"
              :trigger-on-focus="true"
              :debounce="0"
              :loading="applicantLoading"
              :disabled="!form.customerId"
              placeholder="选择或输入申请人姓名（不在表中则提交时自动新增）"
              style="width: 100%"
              clearable
              @select="onApplicantSelect"
            />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="数量" prop="quantity">
            <el-input-number v-model="form.quantity" :min="1" :step="1" controls-position="right" style="width: 100%" />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="加急">
            <el-switch v-model="form.isUrgent" />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="请购日期" prop="requestDate">
            <el-date-picker
              v-model="form.requestDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="请选择"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="计划交期" prop="plannedDeliveryDate">
            <el-date-picker
              v-model="form.plannedDeliveryDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="请选择"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </div>

      <!-- 送货单字段（PR-F 2026-07-17） -->
      <div class="form-grid">
        <div>
          <el-form-item label="订单号">
            <el-input v-model="form.orderNo" placeholder="如 6200037950（可选）" />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="系统交期">
            <el-date-picker
              v-model="form.systemDeliveryDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="订单方系统内部交期（可选）"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </div>

      <el-form-item label="备注">
        <el-input v-model="form.note" placeholder="文员手填备注（可选，送货单可见）" />
      </el-form-item>

      <el-form-item label="图纸">
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          :on-change="onDrawingChange"
          :on-remove="onDrawingRemoveUpload"
          :before-upload="beforeDrawingUpload"
          accept=".pdf"
        >
          <el-button>
            <el-icon><Upload /></el-icon>
            <span>{{ form.drawingName ? '更换图纸' : '选择图纸' }}</span>
          </el-button>
        </el-upload>
        <div v-if="form.drawingName" class="drawing-info">
          <el-icon><Picture /></el-icon>
          <span class="drawing-name">{{ form.drawingName }}</span>
          <el-button link type="danger" size="small" @click="onDrawingRemove">移除</el-button>
        </div>
        <p class="form-hint">仅支持 PDF；提交时自动随表图号列点击预览（待新增一览 → 点图号）。</p>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="closeAddDialog">取消</el-button>
      <el-button type="primary" :loading="dialogSubmitting" @click="handleAddConfirm">
        {{ editingUid ? '保存到列表' : '加入列表' }}
      </el-button>
    </template>
  </el-dialog>

  <!-- 图纸 PDF 预览 Dialog -->
  <!-- X / Esc / 遮罩 → emit('update:model-value', false)；父组件 addDialogVisible
       是 readonly prop，本地 @update 把关动作转给 composable 提供的 closeXxx()。 -->
  <el-dialog
    :model-value="drawingPreviewVisible"
    :title="`图纸预览 — ${drawingPreviewRow?.drawingNo ?? ''}`"
    fullscreen
    destroy-on-close
    :before-close="closeDrawingPreview"
    @update:model-value="(v: boolean) => !v && closeDrawingPreview()"
    @closed="onDrawingPreviewClosed"
  >
    <PdfViewer
      v-if="drawingPreviewRow?.drawingUrl"
      :url="drawingPreviewRow.drawingUrl"
      :page="1"


    />
  </el-dialog>

<!-- 预览 Dialog（只读，手机全屏 / 桌面 720px，列数随断点切换） -->
  <el-dialog
    :model-value="previewDialogVisible"
    title="预览零件"
    :width="previewDlg.width"
    :top="previewDlg.top"
    :fullscreen="previewDlg.fullscreen"
    @update:model-value="(v: boolean) => !v && closePreviewDialog()"
  >
    <el-descriptions v-if="previewing" :column="previewDescCol" border>
      <el-descriptions-item label="图号">{{ previewing.drawingNo }}</el-descriptions-item>
      <el-descriptions-item label="名称">{{ previewing.name }}</el-descriptions-item>
      <el-descriptions-item label="申请人">{{ previewing.applicantName || '—' }}</el-descriptions-item>
      <el-descriptions-item label="客户">{{ previewing.customerLabel || '—' }}</el-descriptions-item>
      <el-descriptions-item label="数量">{{ previewing.quantity }}</el-descriptions-item>
      <el-descriptions-item label="加急">
        <el-tag v-if="previewing.isUrgent" type="danger" size="small" effect="dark">加急</el-tag>
        <span v-else class="muted">否</span>
      </el-descriptions-item>
      <el-descriptions-item label="请购日期">{{ previewing.requestDate }}</el-descriptions-item>
      <el-descriptions-item label="计划交期">{{ previewing.plannedDeliveryDate }}</el-descriptions-item>
      <el-descriptions-item label="图纸" :span="2">
        <PdfViewer
          v-if="previewing.drawingUrl"
          :url="previewing.drawingUrl"
          :page="1"


        />
        <span v-else class="muted">未上传</span>
      </el-descriptions-item>
    </el-descriptions>
    <template #footer>
      <el-button @click="closePreviewDialog">关闭</el-button>
      <el-button type="primary" @click="onEditFromPreview">编辑此条</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import { ElButton, ElTag, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import { DocumentAdd, Picture, Plus, Upload } from '@element-plus/icons-vue'
import PdfViewer from '@/components/PdfViewer.vue'
import ColumnDragHandle from '@/components/ColumnDragHandle.vue'
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue'
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility'
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag'
import { findElTableThead } from '@/utils/elTable'
import type { FormState, StagedEntry } from '../composables/usePartBatchManual'

// 父组件 `v-bind="manual"` 摊开传入本组件需要的所有 props。
// 2026-08-25 fix：el-form 的 ref 必须用本组件本地 ref —— 之前 `ref="formRef"` 把
// 表单实例写到父组件传下来的 readonly prop 上静默失败，导致 manual 录入表单
// 校验永远不触发。formRefLocal 拥有 el-form 实例后，handleAddConfirm /
// handleDialogClosed 把它作为参数传给 composable 的 onAddConfirm / onDialogClosed。
const formRefLocal = ref<FormInstance>()

// 2026-08-27 T21：列顺序拖动 + 可见性。
// 「#」index 列 + 「操作」fixed 列不放进 defs（始终可见、不可拖）。
const columnDefs: ColumnDef[] = [
  {
    key: 'drawingNo', label: '图号', prop: 'drawingNo', minWidth: 130, align: 'center',
    cellRender: ({ row }) => {
      const r = row as StagedEntry
      if (r.drawingUrl) {
        return h(ElButton,
          { link: true, type: 'primary', size: 'small',
            onClick: (e: MouseEvent) => { e.stopPropagation(); props.openDrawingPreview(r) } },
          () => r.drawingNo)
      }
      return h('span', { class: 'mono' }, () => r.drawingNo ?? '')
    },
  },
  { key: 'name', label: '名称', prop: 'name', minWidth: 180, showOverflowTooltip: true, align: 'center' },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 70, align: 'right' },
  {
    key: 'applicantName', label: '申请人', minWidth: 120, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as StagedEntry).applicantName || '—'),
  },
  {
    key: 'customerLabel', label: '客户', minWidth: 160, showOverflowTooltip: true, align: 'center',
    cellRender: ({ row }) => h('span', null, () => (row as StagedEntry).customerLabel || '—'),
  },
  { key: 'plannedDeliveryDate', label: '计划交期', prop: 'plannedDeliveryDate', minWidth: 120, align: 'center' },
  {
    key: 'isUrgent', label: '加急', minWidth: 70, align: 'center',
    cellRender: ({ row }) => {
      const r = row as StagedEntry
      if (r.isUrgent) {
        return h(ElTag, { type: 'danger', size: 'small', effect: 'dark' }, () => '加急')
      }
      return h('span', { class: 'muted' }, () => '—')
    },
  },
]
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'part_batch_manual' })
const drag = useColumnDrag(columnDefs, { listKey: 'part_batch_manual' })

// 2026-08-27 T21：el-table 实例 ref。HTMLElement 路径：onMounted 拿 $el + findElTableThead。
// 边角：组件挂载时 staged 可能为 0 → el-table 在 v-else 还没渲染 → tableRef 为 undefined
// （optional chaining 兜底，thead 为 null 时 applyDrag 跳过；用户加第一条后切走 tab 再回来
// 才能恢复拖动）。这是 HTMLElement 路径的标准 trade-off，brief 已认可。
const tableRef = ref()
onMounted(() => {
  const root = tableRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const thead = findElTableThead(root)
  if (thead) drag.applyDrag(thead)
})

const props = defineProps<{
  previewDescCol: number
  addDlg: { width: string | number; top: string; fullscreen: false }
  previewDlg: { width: string | number; top: string; fullscreen: false }
  customerTree: { id: string; name: string; children?: { id: string; name: string }[] }[]
  applicantCandidates: { id: string; name: string }[]
  applicantLoading: boolean
  querySearch: (queryString: string, cb: (items: { id: string; name: string }[]) => void) => void
  staged: StagedEntry[]
  addDialogVisible: boolean
  dialogSubmitting: boolean
  editingUid: string | null
  drawingPreviewVisible: boolean
  drawingPreviewRow: StagedEntry | null
  previewDialogVisible: boolean
  previewing: StagedEntry | null
  submitting: boolean
  form: FormState
  rules: FormRules
  openDrawingPreview: (row: StagedEntry) => void
  onDrawingPreviewClosed: () => void
  closeAddDialog: () => void
  closePreviewDialog: () => void
  closeDrawingPreview: () => void
  openAddDialog: () => void
  onCustomerChange: (pickedId: unknown) => Promise<void>
  onApplicantSelect: (item: Record<string, unknown>) => void
  beforeDrawingUpload: (rawFile: File & { name?: string }) => boolean
  onDrawingChange: (uploadFile: UploadFile) => void
  onDrawingRemoveUpload: () => void
  onDrawingRemove: () => void
  onAddConfirm: (form?: FormInstance) => Promise<void>
  onDialogClosed: (form?: FormInstance) => void
  onRowPreview: (row: StagedEntry) => void
  onEditFromPreview: () => void
  onRemoveRow: (uid: string) => void
  onClearAll: () => Promise<void>
  rowClassName: (p: { row: unknown }) => string
  onSubmit: () => Promise<void>
}>()

/** 把本地 formRef 实例传回 composable 的 onAddConfirm。 */
function handleAddConfirm(): Promise<void> {
  return props.onAddConfirm(formRefLocal.value)
}
/** @closed 触发：composable 需要 form 来 clearValidate()。 */
function handleDialogClosed(): void {
  props.onDialogClosed(formRefLocal.value)
}
</script>

<style lang="scss" scoped>
.hint {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
  padding: 0 4px;
}

.staging-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}

.staging-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.staging-header-actions {
  display: flex;
  gap: 8px;
}
.staging-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.staging-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}
.staging-count {
  color: var(--text-secondary);
  font-size: 13px;
}

.empty-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 16px;
  background: #fafbfc;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;

  &:hover {
    background: #f0f7ff;
    border-color: var(--primary-color);
  }
}

// 2026-08-27 T21：列设置工具条（与 PartListShell 同款）
.table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.empty-primary {
  margin: 12px 0 4px;
  font-size: 15px;
  color: var(--text-primary);
}
.empty-sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.staging-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.muted {
  color: var(--text-secondary);
}

.drawing-info {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  color: var(--text-regular);
  font-size: 13px;
}
.drawing-name {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
.drawing-preview {
  margin-top: 8px;
}
.form-hint {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

:deep(.row-urgent) {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>