<!--
  PartBatchManualTab.vue

  Tab 1「录入」内容：
  - 待新增零件列表（ResponsiveList）
  - 添加 / 编辑 Dialog
  - 只读预览 Dialog
  - 图纸预览 Dialog

  2026-08-25 拆分：原 PartBatchNew.vue 第 23-365 行整段挪到本组件，state + handler
  在父组件 usePartBatchManual() 里；本组件 props 全部由父组件 `v-bind` 摊开传入。
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

    <!-- 列表态 -->
    <ResponsiveList
      v-else
      :items="staged"
      row-key="uid"
      empty-text="暂无待新增零件"
      :card-class="(row) => (row.isUrgent ? 'rl-card--urgent' : '')"
      border
      stripe
      size="small"
      :row-class-name="rowClassName"
      @row-click="onRowPreview"
      @card-click="onRowPreview"
    >
      <el-table-column type="index" label="#" width="50" />
      <el-table-column label="图号" min-width="130" align="center">
        <template #default="{ row }">
          <el-button
            v-if="(row as StagedEntry).drawingUrl"
            link type="primary" size="small"
            @click.stop="openDrawingPreview(row as StagedEntry)"
          >
            {{ row.drawingNo }}
          </el-button>
          <span v-else class="mono">{{ row.drawingNo }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip align="center"/>
      <el-table-column prop="quantity" label="数量" min-width="70" align="right" />
      <el-table-column label="申请人" min-width="120" show-overflow-tooltip align="center">
        <template #default="{ row }">{{ row.applicantName || '—' }}</template>
      </el-table-column>
      <el-table-column label="客户" min-width="160" show-overflow-tooltip align="center">
        <template #default="{ row }">{{ row.customerLabel || '—' }}</template>
      </el-table-column>
      <el-table-column prop="plannedDeliveryDate" label="计划交期" min-width="120" align="center"/>
      <el-table-column label="加急" min-width="70" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.isUrgent" type="danger" size="small" effect="dark">加急</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="120" align="center" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click.stop="onRowPreview(row as StagedEntry)">查看</el-button>
          <el-button link type="danger" size="small" @click.stop="onRemoveRow((row as StagedEntry).uid)">删除</el-button>
        </template>
      </el-table-column>

      <!-- 手机卡片 -->
      <template #card="{ row }">
        <div class="rl-card-head">
          <span class="rl-card-title">{{ (row as StagedEntry).name }}</span>
          <el-tag v-if="(row as StagedEntry).isUrgent" type="danger" size="small" effect="dark">加急</el-tag>
        </div>
        <div class="rl-card-sub">
          图号 {{ (row as StagedEntry).drawingNo || '—' }}
        </div>
        <div class="rl-kv">
          <div class="rl-kv__item">
            <span class="rl-kv__key">数量</span>
            <span class="rl-kv__val">{{ (row as StagedEntry).quantity }}</span>
          </div>
          <div class="rl-kv__item">
            <span class="rl-kv__key">计划交期</span>
            <span class="rl-kv__val">{{ (row as StagedEntry).plannedDeliveryDate || '—' }}</span>
          </div>
          <div class="rl-kv__item">
            <span class="rl-kv__key">申请人</span>
            <span class="rl-kv__val">{{ (row as StagedEntry).applicantName || '—' }}</span>
          </div>
          <div class="rl-kv__item rl-kv__item--full">
            <span class="rl-kv__key">客户</span>
            <span class="rl-kv__val">{{ (row as StagedEntry).customerLabel || '—' }}</span>
          </div>
        </div>
        <div class="rl-card-actions">
          <el-button link type="primary" size="small" @click.stop="openDrawingPreview(row as StagedEntry)">图纸预览</el-button>
          <el-button link type="primary" size="small" @click.stop="onRowPreview(row as StagedEntry)">查看</el-button>
          <el-button link type="danger" size="small" @click.stop="onRemoveRow((row as StagedEntry).uid)">删除</el-button>
        </div>
      </template>
    </ResponsiveList>

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
    v-model="addDialogVisible"
    :title="editingUid ? '编辑零件' : '添加零件'"
    :width="addDlg.width"
    :top="addDlg.top"
    :fullscreen="addDlg.fullscreen"
    :close-on-click-modal="false"
    @closed="onDialogClosed"
  >
    <el-form
      ref="formRef"
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
      <el-button type="primary" :loading="dialogSubmitting" @click="onAddConfirm">
        {{ editingUid ? '保存到列表' : '加入列表' }}
      </el-button>
    </template>
  </el-dialog>

  <!-- 图纸 PDF 预览 Dialog -->
  <el-dialog
    v-model="drawingPreviewVisible"
    :title="`图纸预览 — ${drawingPreviewRow?.drawingNo ?? ''}`"
    fullscreen
    destroy-on-close
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
    v-model="previewDialogVisible"
    title="预览零件"
    :width="previewDlg.width"
    :top="previewDlg.top"
    :fullscreen="previewDlg.fullscreen"
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
import type { FormInstance, FormRules, UploadFile } from 'element-plus'
import { DocumentAdd, Picture, Plus, Upload } from '@element-plus/icons-vue'
import PdfViewer from '@/components/PdfViewer.vue'
import ResponsiveList from '@/components/ResponsiveList.vue'
import type { FormState, StagedEntry } from '../composables/usePartBatchManual'

// 父组件 `v-bind="manual"` 摊开传入本组件需要的所有 props。
defineProps<{
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
  formRef: FormInstance | undefined
  rules: FormRules
  openDrawingPreview: (row: StagedEntry) => void
  onDrawingPreviewClosed: () => void
  closeAddDialog: () => void
  closePreviewDialog: () => void
  openAddDialog: () => void
  onCustomerChange: (pickedId: unknown) => Promise<void>
  onApplicantSelect: (item: Record<string, unknown>) => void
  beforeDrawingUpload: (rawFile: File & { name?: string }) => boolean
  onDrawingChange: (uploadFile: UploadFile) => void
  onDrawingRemoveUpload: () => void
  onDrawingRemove: () => void
  onAddConfirm: () => Promise<void>
  onDialogClosed: () => void
  onRowPreview: (row: StagedEntry) => void
  onEditFromPreview: () => void
  onRemoveRow: (uid: string) => void
  onClearAll: () => Promise<void>
  rowClassName: (p: { row: unknown }) => string
  onSubmit: () => Promise<void>
}>()
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