<!--
  PartPreviewDialog.vue
  2026-09-30 新增：dashboard 通用图纸预览对话框，行点击统一入口
  （A4 横向预览 + 该工单所有批次 + 持有者）。

  形态：
    - el-dialog 居中 modal（useDialogSize desktopWidth: 960），append-to-body 脱离
      dashboard 的 overflow: hidden 上下文，避免被遮罩遮挡；
    - 顶部 header：序列号（mono 字体）+ 名称（截断省略）+ 状态 ElTag；
    - A4 横向预览区：aspect-ratio 297/210 ≈ 1.414，居中放 <PdfViewer> /
      <el-image> / <el-empty>（无图纸）/ loading / error 四态；
    - 批次列表区：el-table stripe，列批次（batch_label）/ 数量（quantity）/
      状态（ElTag）/ 持有者（current_holder_display）。

  Props / Events：
    - modelValue：boolean（v-model 双向绑定）；
    - part：PartPreviewTarget | null（父组件传入选中行；null = 未选）；
    - @update:modelValue：双向同步。

  入参类型用 `PartPreviewTarget`（types/dashboard.ts）而不是某个具体 VO：dashboard 上
  三条行点击路径的行类型各不相同（工人在手加工批次 / 交期面板行 / 下钻明细行），
  而本弹窗只读 4 个字段（序列号 / 名称 / 状态 + 按 id 拉图纸与批次两个独立请求）。
  收成最小公共结构，弹窗的契约就摆在这里。

  数据流：
    - 文件：usePartFilesListQuery(() => part?.id ?? null) → 过滤 kind='DRAWING' &&
      (isPdf/isImage) → selectedFile 取首张 → watch(loadPreviewUrl) 拉
      fetchPartFileContent(id) + URL.createObjectURL → 喂 <PdfViewer> / <el-image>；
      onBeforeUnmount URL.revokeObjectURL 释放 blob（防内存泄漏）。
    - 批次：usePartBatchesQuery(() => part?.id ?? null)（新增 composable，与
      usePartFilesListQuery 范式严格对齐）→ batches = data.items[]；
      error 走 watch(error, e => e && ElMessage.error(e.message)) 桥接
      桥接；loading 走 el-table v-loading。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :width="dlg.width"
    :top="dlg.top"
    :fullscreen="dlg.fullscreen"
    title=""
    :show-close="true"
    :append-to-body="true"
    :close-on-click-modal="true"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div v-if="!part" class="dialog-empty">
      <el-empty description="请选择工单" :image-size="60" />
    </div>

    <div v-else class="dialog-body">
      <!-- 顶部 header：序列号 + 名称 + 状态 -->
      <div class="dialog-header">
        <span class="hdr-serial">{{ part.serial_no ?? '—' }}</span>
        <span class="hdr-name" :title="part.name">{{ part.name }}</span>
        <el-tag :type="ORDER_STATUS_TAG_TYPE[part.status]" size="small" effect="plain">
          {{ ORDER_STATUS_LABEL[part.status] }}
        </el-tag>
      </div>

      <!-- A4 横向预览区（aspect-ratio: 297/210 ≈ 1.414） -->
      <div class="preview-frame">
        <PdfViewer
          v-if="selectedFile && isPdf(selectedFile.file_type)"
          :key="selectedFile.id"
          :url="previewBlob ?? ''"
        />
        <el-image
          v-else-if="selectedFile && isImage(selectedFile.file_type)"
          :src="previewBlob ?? ''"
          fit="contain"
        />
        <el-empty
          v-else-if="!filesLoading && !filesError && !selectedFile"
          description="该工单暂无图纸"
          :image-size="60"
        />
        <div v-else-if="filesLoading" class="preview-state">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>加载文件中…</span>
        </div>
        <div v-else-if="filesError" class="preview-state preview-state--error">
          <el-icon color="#f56c6c"><WarningFilled /></el-icon>
          <span>{{ filesError }}</span>
        </div>
      </div>

      <!-- 批次列表区 -->
      <div class="batches-section">
        <div class="batches-title">该工单批次（{{ batches.length }}）</div>
        <el-table
          v-loading="batchesLoading"
          :data="batches"
          stripe
          style="width: 100%"
          empty-text="该工单暂无批次"
        >
          <el-table-column prop="batch_label" label="批次" width="120" />
          <el-table-column prop="quantity" label="数量" width="80" align="right" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag
                :type="ORDER_STATUS_TAG_TYPE[row.status as OrderStatus]"
                size="small"
                effect="plain"
              >
                {{ ORDER_STATUS_LABEL[row.status as OrderStatus] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="持有者" min-width="200">
            <template #default="{ row }">{{ row.current_holder_display ?? '—' }}</template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
// 2026-09-30 新增：dashboard 通用图纸预览对话框，行点击统一入口
// （A4 横向预览 + 该工单所有批次 + 持有者）。
//
// 设计要点：
//   - 数据流：
//     1. props.part 切换 → usePartFilesListQuery(queryFn) reactive ownerPartId 跟随
//        变化；enabled 闸门 = !!part.id；part === null 时不发请求。
//     2. files = items.filter(f => f.kind === 'DRAWING' && (isPdf / isImage))，取
//        第一张做 selectedFile。
//     3. selectedFile 变化 → watch(loadPreviewUrl) 拉 fetchPartFileContent(id) blob
//        + URL.createObjectURL；同文件短路（currentPreviewFileId.value === file.id）。
//     4. onBeforeUnmount URL.revokeObjectURL 释放 blob（防内存泄漏，沿
//        DrawingPreviewPane.vue 范式）。
//   - 批次流同形：usePartBatchesQuery(() => part?.id ?? null)；batches = data.items。
//     error 走 watch + ElMessage.error 桥接；loading 走
//     el-table v-loading。
//   - 不写 retry：信任 main.ts 全局 queries.retry: 0。

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, WarningFilled } from '@element-plus/icons-vue';
import { usePartFilesListQuery } from '@/composables/queries/usePartFilesListQuery';
import { usePartBatchesQuery } from '@/composables/queries/usePartBatchesQuery';
import { qk } from '@/composables/queries/keys';
import { fetchPartFileContent } from '@/api/parts/file';
import PdfViewer from '@/components/PdfViewer.vue';
import { useDialogSize } from '@/composables/useDialogSize';
import { useDashboardInvalidation } from '@/views/dashboard/composables/useDashboardInvalidation';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG_TYPE,
  type OrderStatus,
} from '@/types/parts';
import type { PartPreviewTarget } from '@/types/dashboard';
import type { PartBatchSchema, PartFileSchema } from '@/composables/queries/schemas';

const props = defineProps<{
  modelValue: boolean;
  part: PartPreviewTarget | null;
}>();

const emit = defineEmits<(e: 'update:modelValue', v: boolean) => void>();

const dlg = useDialogSize({ desktopWidth: 960 });

// ============ 文件查询（lazy fetch 闸门） ============
const filesQuery = usePartFilesListQuery(() => props.part?.id ?? null);
const files = computed<PartFileSchema[]>(() => filesQuery.data.value?.items ?? []);
const filesLoading = computed(() => filesQuery.isFetching.value);
const filesError = computed<string | null>(() => {
  const e = filesQuery.error.value;
  return e ? e.message : null;
});

/** 过滤 kind='DRAWING' 的 PDF / 图片，取第一张作为 selectedFile。 */
const selectedFile = computed<PartFileSchema | null>(() => {
  const drawings = files.value.filter(
    (f) => f.kind === 'DRAWING' && (isPdf(f.file_type) || isImage(f.file_type)),
  );
  return drawings[0] ?? null;
});

// ============ PDF / 图片 blob URL ============
const previewBlob = ref<string | null>(null);
const previewLoading = ref(false);
const currentPreviewFileId = ref<string | null>(null);

async function loadPreviewUrl(file: PartFileSchema): Promise<void> {
  if (currentPreviewFileId.value === file.id) return; // 同文件短路
  revokePreviewBlob();
  previewLoading.value = true;
  try {
    const blob = await fetchPartFileContent(file.id);
    previewBlob.value = URL.createObjectURL(blob);
    currentPreviewFileId.value = file.id;
  } catch (e) {
    console.error('fetch preview error', e);
  } finally {
    previewLoading.value = false;
  }
}

function revokePreviewBlob(): void {
  if (previewBlob.value) {
    URL.revokeObjectURL(previewBlob.value);
    previewBlob.value = null;
  }
  currentPreviewFileId.value = null;
}

watch(
  () => selectedFile.value,
  async (f) => {
    if (f) await loadPreviewUrl(f);
    else revokePreviewBlob();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  revokePreviewBlob();
});

// ============ 批次查询（沿 usePartFilesListQuery 同范式） ============
// 2026-09-30 新增：usePartBatchesQuery 共享 composable，ownerPartId reactive，
// enabled 闸门 = !!part.id；part === null 时不发请求。
const batchesQuery = usePartBatchesQuery(() => props.part?.id ?? null);
const batches = computed<PartBatchSchema[]>(() => batchesQuery.data.value?.items ?? []);
const batchesLoading = computed(() => batchesQuery.isFetching.value);

// 错误桥接：useQuery 的 error 不在 setup 抛错，
// 走 watch + ElMessage.error 桥接。
watch(batchesQuery.error, (e) => {
  if (e) ElMessage.error(e.message ?? '批次加载失败');
});

// 2026-09-30 新增：dialog 打开期间如果其它终端 / 操作员
// 拆分或取消批次（PART_BATCH_SPLIT / PART_BATCH_CANCELLED 等），usePartBatchesQuery
// 的 staleTime 20min 内不会自动 refetch，dialog 批次列表会过时。挂
// useDashboardInvalidation 订阅 dashboard 同套 AFFECTS_DASHBOARD 事件集（含
// BATCH_TO_SHIP / BATCH_TO_INSPECTION / PART_BATCH_SPLIT / PART_BATCH_CANCELLED
// / PART_BATCH_WITH_PDFS_CREATED 等）→ debounce 500ms / maxWait 1500ms →
// invalidate part-batches 域。
// 传 qk.partBatchesPrefix（'part-batches'）做整域失效：覆盖 dialog 当前打开 part
// + part 切换后的新 part，跨 part 边界不漏失效。useDashboardInvalidation 签名是
// 静态 QueryKey / QueryKey[]（不支持 reactive 重挂），prefix 失效是当前最稳做法。
useDashboardInvalidation(qk.partBatchesPrefix);

// ============ helpers ============
function isPdf(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}
function isImage(t: string): boolean {
  const up = t.toUpperCase();
  return ['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'WEBP'].includes(up);
}
</script>

<style lang="scss" scoped>
.dialog-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 240px;
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.hdr-serial {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-weight: 600;
  font-size: 13px;
  background: var(--el-color-primary-light-9);
  color: var(--primary-color);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.dialog-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hdr-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* A4 横向预览区（aspect-ratio: 297/210 ≈ 1.414） */
.preview-frame {
  width: 100%;
  aspect-ratio: 297 / 210;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-frame > :deep(*) {
  max-width: 100%;
  max-height: 100%;
}
.preview-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}
.preview-state--error {
  color: var(--el-color-danger);
}

.batches-section {
  margin-top: 0;
}
.batches-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}
</style>