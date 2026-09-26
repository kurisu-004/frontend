<!--
  PartBatchManualTab.vue

  Tab 1「录入」内容：
  - 待新增零件列表（el-table）
  - 添加 / 编辑对话框（PartEntryFormDialog）
  - 只读预览 Dialog
  - 图纸预览 Dialog

  2026-08-25 拆分：原 PartBatchNew.vue 第 23-365 行整段挪到本组件，state + handler
  在父组件 usePartBatchManual() 里；本组件 props 全部由父组件 `v-bind` 摊开传入。

  2026-08-25 mobile 适配清理：删除 ResponsiveList 包装，改为纯 el-table（手机卡片视图随 T1 一并撤掉）。

  2026-08-28 改造（B 组 batch 1 列拖动接入）：
  - el-table 在 `<el-card>` 内持续挂载（v-else 控制 table vs empty-zone）→
    传 el-table 实例 ref 给 drag.applyDrag(tableRef)，composable 内部解析表头 +
    MutationObserver 自愈（覆盖 staged=0 → 加第一行 → 表头首次渲染的过渡）。
  - 「#」index 列 + 「操作」fixed 列保留为字面量 <el-table-column>。
  - 列定义 cellRender 全部用 h()（el-button @click.stop 用 stopPropagation 模拟）。
  - 拖点挂到表头 <tr>（列换序；绑 thead 会变成拖整行）。

  2026-09-24 重构：录入对话框整段抽到 PartEntryFormDialog.vue；本组件不再持
  localForm / formRefLocal / FormRules，只挂载表单壳并透传 emit。校验走父
  composable 的 partEntrySchema + formErrors（auth 范本）。
-->

<template>
  <p class="hint">
    点击下方空白区域或「+ 添加零件」按钮，逐条录入零件信息（含图纸），最后统一提交。
  </p>

  <!-- 2026-09-18 A3：mount 时 hydrate 完成后顶部 el-alert 总览「已恢复 N 条已上传图纸」 -->
  <el-alert
    v-if="hydrateRestoredCount > 0"
    :title="`已恢复 ${hydrateRestoredCount} 条已上传图纸`"
    type="success"
    :closable="false"
    show-icon
    class="hydrate-summary"
  />
  <el-alert
    v-else-if="orphanFileRefs.length > 0"
    :title="`发现 ${orphanFileRefs.length} 个孤儿文件未引用`"
    type="info"
    :closable="false"
    show-icon
    class="hydrate-summary"
  />

  <!-- 2026-09-18 A3：孤儿文件待认领面板（与 PDF Tab 同语义；典型场景：上批次上传过
       但刷新时 draft 因 user_id 不匹配被丢弃）。 -->
  <el-alert
    v-if="orphanFileRefs.length > 0"
    type="warning"
    :closable="false"
    show-icon
    class="orphan-alert"
  >
    <template #title>
      <span>孤儿文件待认领（{{ orphanFileRefs.length }} 个）</span>
    </template>
    <ul class="orphan-list">
      <li v-for="f in orphanFileRefs" :key="f.client_ref">
        <code>{{ f.original_filename }}</code>
        <span class="orphan-meta">（{{ f.kind }} · {{ (f.file_size / 1024).toFixed(1) }} KB）</span>
      </li>
    </ul>
    <p class="orphan-hint">
      这些文件存在于 upload session 但未关联到任何条目 —— 可忽略（最终随 session discard 回收）。
    </p>
  </el-alert>

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
    <div v-if="staged.length === 0" class="empty-zone" @click="openAddDialog">
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
        @resetOrder="drag.reset"
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
          :label-class-name="drag.dragLabelClass(d)"
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
          <el-button link type="primary" size="small" @click.stop="onRowPreview(row as StagedEntry)"
            >查看</el-button
          >
          <el-button
            link
            type="danger"
            size="small"
            @click.stop="onRemoveRow((row as StagedEntry).uid)"
            >删除</el-button
          >
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

  <!-- 2026-09-24 重构：原 dialog 段（含 el-form + 表单字段 + 上传）整体抽到
       PartEntryFormDialog.vue，本组件只挂壳并透传 emit / form 同步。父组件
       composable 持有 form / formErrors / handler。 -->
  <PartEntryFormDialog
    :visible="addDialogVisible"
    :editing="editingUid !== null"
    :form="form"
    :form-errors="formErrors"
    :validate-field="validateField"
    :add-dlg="addDlg"
    :customer-tree="customerTree"
    :applicant-loading="applicantLoading"
    :query-search="querySearch"
    :dialog-submitting="dialogSubmitting"
    :drawing-uploading="drawingUploading"
    :request-drawing-upload="requestDrawingUpload"
    :drawing-uploaded="onDrawingUploaded"
    :drawing-items-change="onDrawingItemsChange"
    :drawing-all-done="onDrawingAllDone"
    :drawing-upload-error="onDrawingUploadError"
    :customer-change="onCustomerChange"
    :applicant-select="onApplicantSelect"
    @update:form="onManualFormChange"
    @confirm="onAddConfirm"
    @close="closeAddDialog"
    @closed="onDialogClosed"
    @validateField="validateField"
    @drawingItemsChange="onDrawingItemsChange"
    @drawingUploaded="onDrawingUploaded"
    @drawingAllDone="onDrawingAllDone"
    @drawingUploadError="onDrawingUploadError"
  />

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
    <PdfViewer v-if="drawingPreviewRow?.drawingUrl" :url="drawingPreviewRow.drawingUrl" :page="1" />
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
      <el-descriptions-item label="申请人">{{
        previewing.applicantName || '—'
      }}</el-descriptions-item>
      <el-descriptions-item label="客户">{{
        previewing.customerLabel || '—'
      }}</el-descriptions-item>
      <el-descriptions-item label="数量">{{ previewing.quantity }}</el-descriptions-item>
      <el-descriptions-item label="加急">
        <el-tag v-if="previewing.isUrgent" type="danger" size="small" effect="dark">加急</el-tag>
        <span v-else class="muted">否</span>
      </el-descriptions-item>
      <el-descriptions-item label="请购日期">{{ previewing.requestDate }}</el-descriptions-item>
      <el-descriptions-item label="计划交期">{{
        previewing.plannedDeliveryDate
      }}</el-descriptions-item>
      <el-descriptions-item label="图纸" :span="2">
        <PdfViewer v-if="previewing.drawingUrl" :url="previewing.drawingUrl" :page="1" />
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
// 2026-09-24 重构：原 localForm 双向同步 / formRefLocal / FormRules / handleAddConfirm
// / handleDialogClosed / handleUploaderChange 等逻辑全部搬到 PartEntryFormDialog.vue。
// 本组件只剩列表态 + 预览 dialogs + 父组件 v-bind 透传。父 composable 的 handler
// 直接绑到本组件模板（emit 透传给 dialog 子组件）。

import { h, onMounted, ref } from 'vue';
import { ElButton, ElTag, type TableInstance } from 'element-plus';
import { DocumentAdd, Plus, Upload } from '@element-plus/icons-vue';
import PdfViewer from '@/components/PdfViewer.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import type { StagedEntry, FormState } from '../composables/usePartBatchManual';
import type { PartEntryFieldErrors, PartEntryInput } from '../partEntrySchema';
import type {
  CosUploadedItem,
  CosUploaderItem,
  CosUploadSession,
} from '@/composables/useCosUploader';
import type { Applicant } from '@/types/applicant';
import PartEntryFormDialog from './PartEntryFormDialog.vue';

const props = defineProps<{
  previewDescCol: number;
  addDlg: { width: string | number; top: string; fullscreen: false };
  previewDlg: { width: string | number; top: string; fullscreen: false };
  customerTree: { id: string; name: string; children?: { id: string; name: string }[] }[];
  applicantLoading: boolean;
  querySearch: (queryString: string, cb: (items: Applicant[]) => void) => void;
  staged: StagedEntry[];
  addDialogVisible: boolean;
  dialogSubmitting: boolean;
  editingUid: string | null;
  drawingPreviewVisible: boolean;
  drawingPreviewRow: StagedEntry | null;
  previewDialogVisible: boolean;
  previewing: StagedEntry | null;
  submitting: boolean;
  form: FormState;
  // 2026-09-24 替代 EP FormRules：父 composable formErrors ref。
  formErrors: PartEntryFieldErrors;
  validateField: (field: keyof PartEntryInput) => void;
  /** 2026-09-17 M4：图纸上传中标记。「加入列表」按钮 :disabled 用。 */
  drawingUploading: boolean;
  // 2026-09-18 A3：hydrate 结果（顶部 el-alert + 孤儿文件面板）
  hydrateRestoredCount: number;
  orphanFileRefs: {
    client_ref: string;
    kind: string;
    original_filename: string;
    file_size: number;
  }[];
  openDrawingPreview: (row: StagedEntry) => void;
  onDrawingPreviewClosed: () => void;
  closeAddDialog: () => void;
  closePreviewDialog: () => void;
  closeDrawingPreview: () => void;
  openAddDialog: () => void;
  onCustomerChange: (pickedId: unknown) => Promise<void>;
  onApplicantSelect: (item: Record<string, unknown>) => void;
  // 2026-09-17 M4：图纸上传回调五件套（替代 beforeDrawingUpload +
  // onDrawingChange + onDrawingRemoveUpload + onDrawingRemove 四件套）。
  requestDrawingUpload: (files: File[]) => Promise<CosUploadSession>;
  onDrawingUploaded: (item: CosUploadedItem) => void;
  onDrawingItemsChange: (items: CosUploaderItem[]) => void;
  onDrawingAllDone: () => void;
  onDrawingUploadError: (item: CosUploaderItem) => void;
  // 2026-09-24 重构：onAddConfirm / onDialogClosed 不再吃 FormInstance。
  onAddConfirm: () => Promise<void>;
  onDialogClosed: () => void;
  onRowPreview: (row: StagedEntry) => void;
  onEditFromPreview: () => void;
  onRemoveRow: (uid: string) => void;
  onClearAll: () => Promise<void>;
  rowClassName: (p: { row: unknown }) => string;
  onSubmit: () => Promise<void>;
}>();

// PR-2 2026-09-13 兼容：父级 form = reactive<FormState>(...)。PartEntryFormDialog
// 已经内部持 localForm 并 emit('update:form')。本组件仍要保留这条 emit 通道
// 透传给 shell（PartBatchNew.vue 的 onManualFormChange），语义不变。
const emit = defineEmits<{
  'update:form': [v: FormState];
}>();

// 2026-08-27 T21：列顺序拖动 + 可见性。
// 「#」index 列 + 「操作」fixed 列不放进 defs（始终可见、不可拖）。
const columnDefs: ColumnDef[] = [
  {
    key: 'drawingNo',
    label: '图号',
    prop: 'drawingNo',
    minWidth: 130,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StagedEntry;
      if (r.drawingUrl) {
        return h(
          ElButton,
          {
            link: true,
            type: 'primary',
            size: 'small',
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              props.openDrawingPreview(r);
            },
          },
          () => r.drawingNo,
        );
      }
      return h('span', { class: 'mono' }, r.drawingNo ?? '');
    },
  },
  // 2026-09-18 A3：图纸上传状态列。
  {
    key: 'drawingUpload',
    label: '图纸上传',
    minWidth: 90,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StagedEntry;
      if (r.drawingClientRef && r.drawingBinding) {
        return h(ElTag, { type: 'success', size: 'small' }, () => '已上传');
      }
      if (r.drawingName && !r.drawingBinding && !r.drawingFile) {
        return h(ElTag, { type: 'warning', size: 'small' }, () => '需重传');
      }
      return h('span', { class: 'muted' }, '—');
    },
  },
  {
    key: 'name',
    label: '名称',
    prop: 'name',
    minWidth: 180,
    showOverflowTooltip: true,
    align: 'center',
  },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 70, align: 'right' },
  {
    key: 'applicantName',
    label: '申请人',
    minWidth: 120,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as StagedEntry).applicantName || '—'),
  },
  {
    key: 'customerLabel',
    label: '客户',
    minWidth: 160,
    showOverflowTooltip: true,
    align: 'center',
    cellRender: ({ row }) => h('span', null, (row as StagedEntry).customerLabel || '—'),
  },
  {
    key: 'plannedDeliveryDate',
    label: '计划交期',
    prop: 'plannedDeliveryDate',
    minWidth: 120,
    align: 'center',
  },
  {
    key: 'isUrgent',
    label: '加急',
    minWidth: 70,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as StagedEntry;
      if (r.isUrgent) {
        return h(ElTag, { type: 'danger', size: 'small', effect: 'dark' }, () => '加急');
      }
      return h('span', { class: 'muted' }, '—');
    },
  },
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'part_batch_manual' });
const drag = useColumnDrag(columnDefs, { listKey: 'part_batch_manual' });

// 2026-08-28 改造：传 el-table 实例 ref，composable 内部解析表头 + MutationObserver
// 自愈。组件挂载时 staged=0 → tableRef.value=null → composable 不绑；staged 变化触发
// ref 更新 → composable 内部 watch 重新归一化 + 挂 observer → 表头首次渲染时自愈。
// 2026-09-21 对齐 TS 严格：模板 ref 收紧为 EP TableInstance；null 初值
const tableRef = ref<TableInstance | null>(null);
onMounted(() => {
  drag.applyDrag(tableRef);
});

function onManualFormChange(v: FormState): void {
  emit('update:form', v);
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
  transition:
    background 0.15s,
    border-color 0.15s;

  &:hover {
    background: #f0f7ff;
    border-color: var(--primary-color);
  }
}

// 2026-08-27 T21：列设置工具条（与 ListShell 同款）
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

/* 2026-09-18 A3：hydrate 顶部总览 alert 与孤儿文件面板 */
.hydrate-summary {
  margin: 0 0 12px;
}
.orphan-alert {
  margin: 0 0 12px;
}
.orphan-list {
  margin: 6px 0;
  padding-left: 20px;
  font-size: 13px;
}
.orphan-meta {
  color: var(--text-secondary);
  margin-left: 6px;
}
.orphan-hint {
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
