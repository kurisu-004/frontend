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

  2026-08-28 改造（B 组 batch 1 列拖动接入）：
  - el-table 在 `<el-card>` 内持续挂载（v-else 控制 table vs empty-zone）→
    传 el-table 实例 ref 给 drag.applyDrag(tableRef)，composable 内部解析表头 +
    MutationObserver 自愈（覆盖 staged=0 → 加第一行 → 表头首次渲染的过渡）。
  - 「#」index 列 + 「操作」fixed 列保留为字面量 <el-table-column>。
  - 列定义 cellRender 全部用 h()（el-button @click.stop 用 stopPropagation 模拟）。
  - 拖点挂到表头 <tr>（列换序；绑 thead 会变成拖整行）。
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
        <span class="orphan-meta"
          >（{{ f.kind }} · {{ (f.file_size / 1024).toFixed(1) }} KB）</span
        >
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
      :model="localForm"
      :rules="rules"
      label-width="100px"
      label-position="right"
    >
      <div class="form-grid">
        <div>
          <el-form-item label="图号" prop="drawingNo">
            <el-input v-model="localForm.drawingNo" placeholder="例如：LT39822" />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="名称" prop="name">
            <el-input v-model="localForm.name" placeholder="请输入品名 / 零件名称" />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="客户" prop="customerId">
            <el-cascader
              v-model="localForm.customerId"
              :options="customerTree"
              :props="{
                value: 'id',
                label: 'name',
                children: 'children',
                checkStrictly: true,
                emitPath: false,
              }"
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
              v-model="localForm.applicantName"
              value-key="name"
              :fetch-suggestions="querySearch"
              :trigger-on-focus="true"
              :debounce="0"
              :loading="applicantLoading"
              :disabled="!localForm.customerId"
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
            <el-input-number
              v-model="localForm.quantity"
              :min="1"
              :step="1"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="加急">
            <el-switch v-model="localForm.isUrgent" />
          </el-form-item>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <el-form-item label="请购日期" prop="requestDate">
            <el-date-picker
              v-model="localForm.requestDate"
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
              v-model="localForm.plannedDeliveryDate"
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
            <el-input v-model="localForm.orderNo" placeholder="如 6200037950（可选）" />
          </el-form-item>
        </div>
        <div>
          <el-form-item label="系统交期">
            <el-date-picker
              v-model="localForm.systemDeliveryDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="订单方系统内部交期（可选）"
              style="width: 100%"
            />
          </el-form-item>
        </div>
      </div>

      <el-form-item label="备注">
        <el-input v-model="localForm.note" placeholder="文员手填备注（可选，送货单可见）" />
      </el-form-item>

      <el-form-item label="图纸">
        <div class="drawing-uploader">
          <!-- 2026-09-17 M4：图纸上传走 CosUploader（前端直传 COS tmp 区）。
               - accept=".pdf" + :multiple=false：单 PDF 限；
               - :max-size-m-b="300"：与 nginx 300m 上限对齐；
               - 不开 computeHash：sha 由 composable.requestDrawingUpload 内
                 computeSha256 算一次（避免大 PDF 算两次）；
               - @change 本地 wrapper trim 旧项只留最新（绕开 el-upload :limit
                 统计坑：cosUploader.removeItem 不会清 el-upload 内部列表）。
          -->
          <CosUploader
            ref="uploaderRef"
            :request-upload="requestDrawingUpload"
            accept=".pdf"
            :multiple="false"
            :max-size-m-b="300"
            tip="仅支持 PDF；提交时自动随表图号列点击预览（待新增一览 → 点图号）。"
            empty-text="未选择图纸（可选）"
            @change="handleUploaderChange"
            @uploaded="onDrawingUploaded"
            @all-done="onDrawingAllDone"
            @error="onDrawingUploadError"
          />
          <p v-if="editingUid && localForm.drawingName" class="form-hint">
            当前图纸：{{ localForm.drawingName }}；重新上传将替换。
          </p>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="closeAddDialog">取消</el-button>
      <el-button
        type="primary"
        :loading="dialogSubmitting"
        :disabled="drawingUploading"
        @click="handleAddConfirm"
      >
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
import { h, onMounted, reactive, ref, toRaw, watch } from 'vue';
import { ElButton, ElTag, type FormInstance, type FormRules } from 'element-plus';
import { DocumentAdd, Plus, Upload } from '@element-plus/icons-vue';
import PdfViewer from '@/components/PdfViewer.vue';
import CosUploader from '@/components/CosUploader.vue';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import type {
  CosUploadedItem,
  CosUploaderItem,
  CosUploadSession,
} from '@/composables/useCosUploader';
import type { FormState, StagedEntry } from '../composables/usePartBatchManual';

const props = defineProps<{
  previewDescCol: number;
  addDlg: { width: string | number; top: string; fullscreen: false };
  previewDlg: { width: string | number; top: string; fullscreen: false };
  customerTree: { id: string; name: string; children?: { id: string; name: string }[] }[];
  applicantCandidates: { id: string; name: string }[];
  applicantLoading: boolean;
  querySearch: (queryString: string, cb: (items: { id: string; name: string }[]) => void) => void;
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
  rules: FormRules;
  /** 2026-09-17 M4：图纸上传中标记。「加入列表」按钮 :disabled 用。 */
  drawingUploading: boolean;
  // 2026-09-18 A3：hydrate 结果（顶部 el-alert + 孤儿文件面板）
  hydrateRestoredCount: number;
  orphanFileRefs: { client_ref: string; kind: string; original_filename: string; file_size: number }[];
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
  onAddConfirm: (form?: FormInstance) => Promise<void>;
  onDialogClosed: (form?: FormInstance) => void;
  onRowPreview: (row: StagedEntry) => void;
  onEditFromPreview: () => void;
  onRemoveRow: (uid: string) => void;
  onClearAll: () => Promise<void>;
  rowClassName: (p: { row: unknown }) => string;
  onSubmit: () => Promise<void>;
}>();

// PR-2 2026-09-13：父级 form = reactive<FormState>(...)。vue/no-mutating-props
// 禁止 props.form.x = v。本地 reactive 副本 + watch 双向同步 + emit('update:form')。
const emit = defineEmits<(e: 'update:form', v: FormState) => void>();
// 走 as unknown as 两次断言绕开 TS "object literal" 报错（consistent-type-assertions 不触发，因为是 unknown 中转）
const localForm = reactive({} as unknown as FormState);
watch(
  () => props.form,
  (v) => {
    Object.assign(localForm, structuredClone(toRaw(v)));
  },
  { deep: true, immediate: true },
);
watch(
  localForm,
  (v) => {
    emit('update:form', { ...v });
  },
  { deep: true },
);

// 父组件 `v-bind="manual"` 摊开传入本组件需要的所有 props。
// 2026-08-25 fix：el-form 的 ref 必须用本组件本地 ref —— 之前 `ref="formRef"` 把
// 表单实例写到父组件传下来的 readonly prop 上静默失败，导致 manual 录入表单
// 校验永远不触发。formRefLocal 拥有 el-form 实例后，handleAddConfirm /
// handleDialogClosed 把它作为参数传给 composable 的 onAddConfirm / onDialogClosed。
const formRefLocal = ref<FormInstance>();

// 2026-08-27 T21：列顺序拖动 + 可见性。
// 「#」index 列 + 「操作」fixed 列不放进 defs（始终可见、不可拖）。
// 2026-08-27 修正：原生元素 children 不能传函数（Vue 3 会当 slots 处理 → 渲染为空），改为直接传值。
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
  // 2026-09-18 A3：图纸上传状态列。drawingClientRef 存在（hydrate 或本批新传）
  // → 标「已上传」绿 tag；hydrate 时 drawing='need_reselect'（snapshot 有
  // client_ref 但 session 没命中）→ 标「需重传」黄 tag。两种互斥。
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
      // hydrate 时 snapshot 有 client_ref 但 session 缺 → drawingClientRef
      // 字段保持 undefined（deserializeStaged 内只在 drawing='done' 才写）。
      // 这里用反向判定：drawingName 残留（hydrate 时从 drawingFilename 写入）
      // 但 drawingBinding 为 null → 标「需重传」。
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
const tableRef = ref();
onMounted(() => {
  drag.applyDrag(tableRef);
});

// 2026-09-17 M4：图纸上传 CosUploader ref。用于 handleUploaderChange trim +
// handleDialogClosed 时强制清队列。
const uploaderRef = ref<InstanceType<typeof CosUploader> | null>(null);

/**
 * 本地 @change wrapper：cosUploader.removeItem 不会清 el-upload 内部列表，
 * `:limit="1"` 会导致永远超限。我们绕开方案：:limit="0"（不限）+ :multiple="false"，
 * 选第 N 个文件后这里 trim：保留最新一条，把前 N-1 条从 cos-uploader 内部移出。
 *
 * 注意：每次 uploaderRef.value?.removeItem(...) 内部会 splice + emit('change')
 * 递归触发本 wrapper，所以要确保只在 items.length > 1 时才进入 trim 循环。
 * removeItem 已发 change 事件，items 引用在新一轮 change 回调中是已被修改的。
 */
async function handleUploaderChange(items: CosUploaderItem[]): Promise<void> {
  if (items.length > 1) {
    // 同步遍历：本次事件触发的 items 已被 cos-uploader 内部 splice 影响。
    // 我们用 items.length - 1 算 trim 上限（保留最后一项）。
    const trimCount = items.length - 1;
    for (let i = 0; i < trimCount; i += 1) {
      const it = items[i];
      if (it) {
        await uploaderRef.value?.removeItem(it.client_ref);
      }
    }
  }
  // 转 trim 后的最新列表（removeItem 已触发 change，本处 items 已是 trim 后状态）
  props.onDrawingItemsChange(items);
}

/** 把本地 formRef 实例传回 composable 的 onAddConfirm。 */
function handleAddConfirm(): Promise<void> {
  return props.onAddConfirm(formRefLocal.value);
}
/** @closed 触发：composable 需要 form 来 clearValidate()。
 *
 * 2026-09-17 M4：同步调 uploaderRef.clear() 让 cos-uploader 内部清空列表
 * （触发所有已 done 项的 cancel 回调，best-effort 清理 COS tmp 对象）。
 */
function handleDialogClosed(): void {
  void uploaderRef.value?.clear();
  props.onDialogClosed(formRefLocal.value);
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
