<!--
  AssemblyChildrenTable.vue

  装配件「子件 / 上传 PDF」复合区域：
  - 上传总装 PDF 卡（仅当 canUploadTotalPdf 时显示）
  - 子件表格卡（el-table；手机卡片视图 2026-08-25 mobile 清理已移除）
  - 「添加子件」对话框（含 form 状态 + form ref + 校验）
  - 「子件图号点击」全屏图纸预览对话框（含 Blob URL 生命周期）

  2026-10-13 子件图号预览切 CI 转图直链：
  - 首选 `GET /files/objects/{id}/preview` → 逐页图片直链 → `<ImagePager>`；
    `fetchDrawingBlob`（/content blob + PdfViewer）降级为「查看原始 PDF」逃生口 +
    转图不可用时的自动兜底。
  - ⚠️ 入参是**文件对象 id**：`childDrawingMap` 的值来自 `GET /assemblies/{id}`
    详情响应的 `files[]`，owner 是 PART（子件），但预览端点只认文件对象 id，
    owner 语义由后端解析 —— 装配件侧不需要另开预览链路。
  - 降级原因渲染成弹窗内一行提示（`.degrade-hint`），不静默换渲染路径。
  - 预览弹窗的 el-dialog 挂 `pdf-preview-dialog` + `img-preview-dialog` 两个 class
    （两个预览组件的 flex 高度链同款，规则在 styles/index.scss 里逐条并列）。

  本组件持有以下 UI 状态：
  - addChildVisible / addChildSubmitting / addChildFormRef
  - addChildForm（由父组件通过 prop 注入——composable 持有 source of truth）
  - drawingPreviewVisible / drawingPreviewFile / drawingPreviewBlobUrl

  业务函数（addChild / uploadPdf / fetchDrawingBlob）由父组件通过 prop 注入；
  本组件只负责 UI 编排 + 表单校验 + Blob URL 释放。

  2026-08-25 frontend-overall-refactor：从 AssemblyDetail.vue 抽出。

  2026-09-13 PR-2：父级 addChildForm = reactive<AssemblyAddChildForm>(...)。vue/no-mutating-props
  禁止 props.addChildForm.x = v。本地 reactive 副本 + watch 同步 +
  emit('update:form')；父级 @update:form 合并即可。

  上传总装 PDF 的文案如实描述端点行为 —— `POST /files/objects`
  （owner_kind=ASSEMBLY）只入库总装图文件（SHA-256 CAS + COS PUT + INSERT
  t_part_file(kind='ASSEMBLY_MASTER')），
  **不拆页、不建子件**，所以卡片文案如实写「上传不会按页拆分」，子件在下方单独添加。
-->
<template>
  <!-- 仅当装配体当前没有 master + 没有子件时才可上传（后端行为见文件头）。 -->
  <el-card v-if="canUploadTotalPdf" shadow="never" class="upload-pdf-card">
    <div class="upload-pdf-row">
      <div class="upload-pdf-hint">
        <el-icon><Upload /></el-icon>
        <span>
          该装配体暂无总装 PDF。
          <strong>上传的是该装配件的总装 PDF</strong>（入库为总装图文件）；子件请在下方
          <strong>单独添加</strong>，上传不会按页拆分。
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
          <span>上传总装 PDF</span>
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
            @resetOrder="drag.reset"
          />
          <el-button type="primary" plain :disabled="!canAddChild" @click="openAddChildDialog">
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
          <el-button link type="primary" size="small" @click="goPartDetail(row.id)">
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
    class="pdf-preview-dialog img-preview-dialog"
    :title="drawingPreviewFile?.original_filename ?? '图纸预览'"
    fullscreen
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="(v: boolean) => (drawingPreviewVisible = v)"
    @closed="onDrawingPreviewClosed"
  >
    <!-- 图片模式：CI 转好的逐页直链（默认路径，不下载整份 PDF）。图片模式少矢量缩放
         与文字选中 ⇒ 必须给逃生口。 -->
    <div v-if="showImageMode" class="pdf-image-mode">
      <ImagePager :key="`img-${drawingPreviewFile?.id}`" :pages="preview.pages.value" />
      <el-button class="original-btn" plain @click="drawingShowOriginal = true">
        <el-icon><Document /></el-icon>
        <span>查看原始 PDF</span>
      </el-button>
    </div>
    <!-- 原始 PDF：用户点「查看原始 PDF」，或转图降级（端点不支持 / CI 失败 / 超时）。 -->
    <div v-else-if="isPdfDrawing" class="pdf-original-mode">
      <div v-if="preview.degradedReason.value" class="degrade-hint">
        {{ preview.degradedReason.value }}
      </div>
      <div v-if="!drawingPreviewBlobUrl" class="loading-tip">
        <el-icon class="is-loading"><Loading /></el-icon>
        <!-- 转图还在等 vs 已决定看原始 PDF、正在拉 blob，两种情形不能共用一句话。 -->
        <span>{{ wantsOriginalPdf ? '加载原始 PDF…' : '图纸转图中…' }}</span>
      </div>
      <PdfViewer v-else :key="`pdf-${drawingPreviewFile?.id}`" :url="drawingPreviewBlobUrl" :page="1" />
    </div>
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
      :model="localAddChildForm"
      :rules="addChildRules"
      label-width="96px"
    >
      <el-form-item label="图号" prop="drawing_no">
        <el-input v-model="localAddChildForm.drawing_no" placeholder="例如：E42FX1020107101" />
      </el-form-item>
      <el-form-item label="名称" prop="name">
        <el-input v-model="localAddChildForm.name" placeholder="例如：基础板" />
      </el-form-item>
      <el-form-item label="数量" prop="quantity">
        <el-input-number
          v-model="localAddChildForm.quantity"
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
import { h, computed, reactive, ref, toRaw, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { UploadFile, FormInstance } from 'element-plus';
import { ElLink, ElMessage, ElTag } from 'element-plus';
import { Loading, Document, Plus, Upload } from '@element-plus/icons-vue';

import PdfViewer from '@/components/PdfViewer.vue';
import ImagePager from '@/components/ImagePager.vue';
// 2026-10-13：子件图纸预览的 CI 转图轮询（首选路径），/content blob 为兜底。
import { usePreviewPolling } from '@/composables/usePreviewPolling';
import { useDialogSize } from '@/composables/useDialogSize';
import type { PartFileItem } from '@/types/part_file';
import type { PartListItem } from '@/types/parts';
import type { OrderStatus } from '@/types/parts';
// 2026-09-29 修复：children 类型从 PartListItem[] 升级为 AssemblyChildItem[]（消除类型欺骗）。
// AssemblyChildItem extends PartListItem + current_batch_id + __is_child，结构上
// 兼容 cellRender 内部 row as PartListItem 断言（PartListItem 是父类型）。
import type { AssemblyChildItem } from '@/types/assembly';
import {
  resolveDraggable,
  useColumnVisibility,
  type ColumnDef,
} from '@/composables/useColumnVisibility';
import { columnIdentifier, useColumnDrag } from '@/composables/useColumnDrag';
import ColumnDragHandle from '@/components/ColumnDragHandle.vue';
import ColumnVisibilityPopover from '@/components/ColumnVisibilityPopover.vue';
import {
  ASSEMBLY_ADD_CHILD_RULES,
  type AssemblyAddChildForm,
} from '../composables/useAssemblyDetail';

interface Props {
  // 2026-09-29 修复：children 类型由 PartListItem[] 改为 AssemblyChildItem[]。
  // cellRender 内部 row as PartListItem 断言仍兼容（AssemblyChildItem extends PartListItem）。
  children: AssemblyChildItem[] | null;
  /** 子件 id → DRAWING 文件映射（点子件图号直接预览） */
  childDrawingMap: Record<string, PartFileItem>;
  /** 权限 flag */
  canAddChild: boolean;
  canUploadTotalPdf: boolean;
  /** form 数据（composable 持有 source of truth，本组件直接 v-model） */
  addChildForm: AssemblyAddChildForm;
  /** 状态 → label / tag-type（composable 提供） */
  partStatusLabel: (s: OrderStatus | string) => string;
  partStatusTagType: (
    s: OrderStatus | string,
  ) => 'success' | 'warning' | 'info' | 'danger' | 'primary';
  childRowClass: (row: { is_urgent: boolean }) => string;
  /** 业务函数（composable 注入） */
  addChild: () => Promise<boolean>;
  uploadPdf: (file: UploadFile) => Promise<boolean>;
  fetchDrawingBlob: (drawing: PartFileItem) => Promise<string>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  /** 添加子件 / 上传 PDF 成功后由父组件 refresh */
  (e: 'refresh'): void;
  // PR-2 2026-09-13：本地副本变更同步给父级。
  (e: 'update:form', v: AssemblyAddChildForm): void;
}>();

const router = useRouter();

const addChildDlg = useDialogSize({ desktopWidth: 480 });

// PR-2 2026-09-13：本地 reactive 副本 + watch + emit('update:form')；详见文件头注释。
// watch immediate: true 触发一次性拷贝，避免在 setup 顶层读 props.addChildForm。
// 走 as unknown as 两次断言绕开 TS "object literal" 报错（consistent-type-assertions 不触发，因为是 unknown 中转）
const localAddChildForm = reactive({} as unknown as AssemblyAddChildForm);
watch(
  () => props.addChildForm,
  (v) => {
    Object.assign(localAddChildForm, structuredClone(toRaw(v)));
  },
  { deep: true, immediate: true },
);
watch(
  localAddChildForm,
  (v) => {
    emit('update:form', { ...v });
  },
  { deep: true },
);

// ============ 2026-08-27 Task 9：子件表列顺序拖动 + 可见性 ============
// 2026-08-28 改造：传 el-table 实例 ref 即可，composable 内部解析表头 <tr> +
// MutationObserver 自愈（表头首次出现 / EP 重建都能覆盖）。
// type=index 的「#」列与 fixed=right 的「操作」列不进 defs。
const tableRef = ref();
const columnDefs: ColumnDef[] = [
  {
    key: 'serial_no',
    label: '序列号',
    prop: 'serial_no',
    minWidth: 100,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem;
      return r.serial_no
        ? h(ElTag, { type: 'success', size: 'small', effect: 'dark' }, () => r.serial_no)
        : h('span', { class: 'muted' }, '未分配');
    },
  },
  {
    key: 'drawing_no',
    label: '图号',
    prop: 'drawing_no',
    minWidth: 160,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem;
      // 硬约束 #11：EP 合成空行 { row: {} } → r.id 可能 undefined，需守卫
      const drawing = r.id ? props.childDrawingMap[r.id] : undefined;
      return drawing
        ? h(
            ElLink,
            { type: 'primary', onClick: () => void onChildDrawingClick(r, drawing) },
            () => r.drawing_no,
          )
        : h('span', { class: 'mono' }, r.drawing_no);
    },
  },
  {
    key: 'name',
    label: '名称',
    prop: 'name',
    minWidth: 160,
    align: 'center',
    showOverflowTooltip: true,
  },
  { key: 'quantity', label: '数量', prop: 'quantity', minWidth: 70, align: 'right' },
  {
    key: 'status',
    label: '状态',
    prop: 'status',
    minWidth: 100,
    align: 'center',
    cellRender: ({ row }) => {
      const r = row as PartListItem;
      return h(ElTag, { type: props.partStatusTagType(r.status), size: 'small' }, () =>
        props.partStatusLabel(r.status),
      );
    },
  },
  {
    key: 'planned_delivery_date',
    label: '计划交期',
    prop: 'planned_delivery_date',
    minWidth: 120,
    align: 'center',
  },
  // 2026-09-16 PR-2：子件出参（v2 AssemblyChildOut）本就不含位置字段，
  // current_holder_display 随 PartListItem 瘦身删除，「所在位置」列一并移除。
];
const columnVisibility = useColumnVisibility(columnDefs, { listKey: 'assembly_children' });
const drag = useColumnDrag(columnDefs, { listKey: 'assembly_children' });
// 2026-08-28 改造：直接传实例 ref；composable 内部 watch(ref) + MutationObserver 自愈。
drag.applyDrag(tableRef);

// ============ 添加子件对话框状态 ============
const addChildVisible = ref(false);
const addChildSubmitting = ref(false);
const addChildFormRef = ref<FormInstance>();
const addChildRules = ASSEMBLY_ADD_CHILD_RULES;

function openAddChildDialog(): void {
  addChildVisible.value = true;
}

function onAddChildClosed(): void {
  // dialog close 时不重置 form（保持用户已输入）——仅提交成功 / 取消时 reset
}

async function onAddChildSubmit(): Promise<void> {
  if (!addChildFormRef.value) return;
  try {
    await addChildFormRef.value.validate();
  } catch {
    return;
  }
  addChildSubmitting.value = true;
  try {
    const ok = await props.addChild();
    if (ok) {
      addChildVisible.value = false;
      emit('refresh');
    }
  } finally {
    addChildSubmitting.value = false;
  }
}

// ============ 上传总装 PDF ============
const uploading = ref(false);
async function onUploadTotalPdf(uploadFile: UploadFile): Promise<void> {
  uploading.value = true;
  try {
    const ok = await props.uploadPdf(uploadFile);
    if (ok) emit('refresh');
  } finally {
    uploading.value = false;
  }
}

// ============ 子件图号 → 图纸预览（2026-10-13：CI 转图直链优先，原始 PDF 兜底）============
const drawingPreviewVisible = ref(false);
const drawingPreviewFile = ref<PartFileItem | null>(null);
const drawingPreviewBlobUrl = ref('');
// 用户在图片模式下点「查看原始 PDF」。
const drawingShowOriginal = ref(false);

/** 当前选中的是不是一份 PDF（决定走「转图 / 原始 PDF」两条路还是其它分支）。 */
const isPdfDrawing = computed<boolean>(
  () => drawingPreviewFile.value !== null && isPdfType(drawingPreviewFile.value.file_type),
);

function isPdfType(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}

/** 转图轮询：只有 PDF 才有转图；弹窗关着时不轮询。 */
const preview = usePreviewPolling({
  fileId: () =>
    isPdfDrawing.value && drawingPreviewFile.value ? drawingPreviewFile.value.id : '',
  enabled: () => drawingPreviewVisible.value,
});

/**
 * 当前该显示哪条路（2026-10-13）。
 *
 * ⚠️ `showImageMode` 必须同时看 `!wantsOriginalPdf`，不能只看 `preview.ready`：
 * 转图 ready 之后 `ready` 就一直是 true，只用它做分支条件的话，「查看原始 PDF」按钮
 * 会变成**空操作** —— 点击确实触发了 blob 拉取，但模板仍停在图片模式分支上，用户
 * 看不到任何变化，逃生口形同虚设。
 */
const wantsOriginalPdf = computed<boolean>(
  () => drawingShowOriginal.value || preview.degraded.value,
);
const showImageMode = computed<boolean>(
  () => isPdfDrawing.value && preview.ready.value && !wantsOriginalPdf.value,
);

async function onChildDrawingClick(_row: unknown, drawing: PartFileItem): Promise<void> {
  drawingPreviewFile.value = drawing;
  drawingPreviewVisible.value = true;
  drawingShowOriginal.value = false;
  drawingPreviewBlobUrl.value = '';
  // PDF 不在这里拉 blob —— 先走转图；用户点「查看原始 PDF」或转图降级时再拉
  // （见下方 watch）。提前拉会让「图片模式省带宽」当场作废。
  if (isPdfType(drawing.file_type)) return;
  try {
    drawingPreviewBlobUrl.value = await props.fetchDrawingBlob(drawing);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载图纸失败');
    drawingPreviewVisible.value = false;
  }
}

/**
 * PDF 的原始 PDF 路径有两条触发：用户点「查看原始 PDF」，或转图轮询降级。
 * 二者合并成一条 watch —— 降级那一刻的表现与用户主动切换完全一致。
 */
watch(
  [drawingPreviewFile, wantsOriginalPdf],
  async ([drawing, wantOriginal]) => {
    if (!drawing || !isPdfType(drawing.file_type)) return;
    if (!wantOriginal) return;
    try {
      const url = await props.fetchDrawingBlob(drawing);
      // 期间用户可能已关掉弹窗或点了别的子件 ⇒ 迟到的 blob 直接丢弃。
      if (drawingPreviewFile.value?.id !== drawing.id) return;
      drawingPreviewBlobUrl.value = url;
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载原始 PDF 失败');
    }
  },
  { immediate: true },
);

function onDrawingPreviewClosed(): void {
  if (drawingPreviewBlobUrl.value) {
    URL.revokeObjectURL(drawingPreviewBlobUrl.value);
  }
  drawingPreviewBlobUrl.value = '';
  drawingPreviewFile.value = null;
  drawingShowOriginal.value = false;
  preview.stop();
}

function goPartDetail(id: string): void {
  router.push(`/parts/${id}`);
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

/* 2026-10-13：PDF 预览拆成「图片模式 / 原始 PDF 模式」两个容器。两者都是弹窗 body 的
   直接子元素（flex item），故各自 `flex: 1 + min-height: 0` 才能填满 body 的高度。 */
.pdf-image-mode,
.pdf-original-mode {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pdf-original-mode .loading-tip {
  padding: 0;
  flex: 1;
  min-height: 0;
}
.original-btn {
  align-self: center;
  flex-shrink: 0;
}
/* 降级提示：有告知的兜底，不是静默换渲染路径。占位小、不抢画面。 */
.degrade-hint {
  flex-shrink: 0;
  font-size: 12px;
  color: #e6a23c;
  text-align: center;
}
:deep(.el-table__row.row-urgent) > td.el-table__cell {
  background-color: #fde2e2 !important;
}
:deep(.el-table__row.row-urgent:hover > td.el-table__cell) {
  background-color: #fbcaca !important;
}
</style>
