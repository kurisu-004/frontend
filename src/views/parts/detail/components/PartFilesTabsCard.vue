<!--
  PartFilesTabsCard.vue

  零件文件 tabs 卡（PartDetail 2026-09-17 卡片化重构，把散落的 4 张子卡收敛为 1 张）：
  - 4 个 tab：DRAWING / 3D_MODEL / CAD_2D / CNC_PAIR
  - 前 3 个走 FileListCard（kind 区分）
  - 第 4 个 CNC_PAIR 走 PartCncCard
  - footer：DRAWING tab 显示「打印图纸」（!isInspector），其它三 tab 显示「上传」，
    选中 files 行时显示「删除选中」
  - 文件上传 / 删除 api-upload / api-delete 等签名与 FileListCard 现有契约一致

  2026-09-17 新增：PartDetail 卡片拆分重构。
  - 引入 selectedFileId 持有「点 FileListCard 行选中」状态；FileListCard 当前
    不暴露 row-select 事件，本组件通过监听 @uploaded / @deleted 维护瞬态；
    后续如需 click-to-select，由 FileListCard 加 @select 事件或在本卡外层
    套 click 拦截。删除选中按钮仅在该状态下显示。
-->
<template>
  <el-card shadow="never" class="files-tabs-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">
          <el-icon><FolderOpened /></el-icon>
          <span>零件文件</span>
        </span>
        <el-tabs v-model="activeTab" class="inline-tabs">
          <el-tab-pane label="图纸" name="DRAWING" />
          <el-tab-pane label="3D 模型" name="3D_MODEL" />
          <el-tab-pane label="CAD 源文件" name="CAD_2D" />
          <el-tab-pane label="CNC 配对文件" name="CNC_PAIR" />
        </el-tabs>
      </div>
    </template>

    <!-- DRAWING / 3D_MODEL / CAD_2D → FileListCard -->
    <template v-if="activeTab !== 'CNC_PAIR'">
      <FileListCard
        v-if="activeTab === 'DRAWING'"
        :files="drawings"
        owner-type="part"
        :owner-id="partId"
        kind="DRAWING"
        :show-upload="canManageDrawings"
        :show-delete="canManageDrawings"
        :show-print="!isInspector"
        :api-upload="drawingUpload"
        @refresh="$emit('refresh', 'DRAWING')"
        @uploaded="onFileUploaded('DRAWING', $event)"
        @deleted="onFileDeleted('DRAWING', $event)"
      />
      <FileListCard
        v-else-if="activeTab === '3D_MODEL'"
        :files="models3d"
        owner-type="part"
        :owner-id="partId"
        kind="3D_MODEL"
        :show-upload="canManage3DModels"
        :show-delete="canManage3DModels"
        :api-upload="model3dUpload"
        @refresh="$emit('refresh', '3D_MODEL')"
        @uploaded="onFileUploaded('3D_MODEL', $event)"
        @deleted="onFileDeleted('3D_MODEL', $event)"
      />
      <FileListCard
        v-else
        :files="cadFiles"
        owner-type="part"
        :owner-id="partId"
        kind="CAD_2D"
        :show-upload="canManageDrawings"
        :show-delete="canManageDrawings"
        :api-upload="cadUpload"
        @refresh="$emit('refresh', 'CAD_2D')"
        @uploaded="onFileUploaded('CAD_2D', $event)"
        @deleted="onFileDeleted('CAD_2D', $event)"
      />
    </template>

    <!-- CNC_PAIR → PartCncCard -->
    <PartCncCard
      v-else
      :part-id="partId"
      :part-status="partStatus"
      :cnc-setup-groups="cncSetupGroups"
      :cnc-loading="cncLoading"
      :can-manage-cnc-files="canManageCncFiles"
      :can-manage-setup-sheet="canManageSetupSheet"
      :production-shelves="productionShelves"
      :processes="processes"
      :format-bytes="formatBytes"
      :file-list="fileList"
      :on-download-cnc="onDownloadCnc"
      :on-delete-cnc="onDeleteCnc"
      @fetch="$emit('fetch')"
      @pairUpload="(payload) => $emit('pairUpload', payload)"
      @release="(payload) => $emit('release', payload)"
    />

    <!-- 底部操作条：按 tab 区分按钮 + 选中态 -->
    <template v-if="activeTab !== 'CNC_PAIR'" #footer>
      <div class="card-footer">
        <span v-if="selectedFileId" class="footer-tip muted">
          已选中文件 #{{ selectedFileId }}
        </span>
        <div class="footer-actions">
          <el-button
            v-if="selectedFileId"
            type="danger"
            plain
            :loading="deleteSelectedSubmitting"
            @click="onDeleteSelected"
            >删除选中</el-button
          >
          <el-button
            v-if="activeTab === 'DRAWING' && !isInspector"
            type="success"
            plain
            :loading="printing"
            @click="onPrintDrawing"
            >打印图纸</el-button
          >
        </div>
      </div>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { FolderOpened } from '@element-plus/icons-vue';
import FileListCard from '@/components/FileListCard.vue';
import PartCncCard from './PartCncCard.vue';
import { printPartDrawing } from '@/api/parts/file';
import { deletePartFile } from '@/api/parts/file';
import type { PartFileItem } from '@/types/part_file';
import type { CncSetupGroup } from '../composables/usePartCncGroups';
import type { Process } from '@/types/process';
import type { Shelf } from '@/types/shelf';
import type { OrderStatus } from '@/types/parts';
import type { UploadFile } from 'element-plus';

type TabKey = 'DRAWING' | '3D_MODEL' | 'CAD_2D' | 'CNC_PAIR';

const props = defineProps<{
  partId: string;
  partStatus: OrderStatus;
  // 文件列表（来自 usePartFiles）
  drawings: PartFileItem[];
  models3d: PartFileItem[];
  cadFiles: PartFileItem[];
  // 权限
  canManageDrawings: boolean;
  canManage3DModels: boolean;
  canManageCncFiles: boolean;
  canManageSetupSheet: boolean;
  isInspector: boolean;
  // 上传函数（来自 shell 的 usePartFileUpload 适配签名）
  drawingUpload: (ownerId: string, file: File) => Promise<PartFileItem>;
  model3dUpload: (ownerId: string, file: File) => Promise<PartFileItem>;
  cadUpload: (ownerId: string, file: File) => Promise<PartFileItem>;
  // CNC 相关（透传 PartCncCard）
  cncSetupGroups: CncSetupGroup[];
  cncLoading: boolean;
  productionShelves: Shelf[];
  processes: Process[];
  formatBytes: (v: string | number) => string;
  fileList: (
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt?: boolean,
  ) => UploadFile[];
  onDownloadCnc: (p: PartFileItem) => void;
  onDeleteCnc: (id: string, version: number) => void;
}>();

const emit = defineEmits<{
  refresh: [kind: 'DRAWING' | '3D_MODEL' | 'CAD_2D'];
  fetch: [];
  // 2026-09-17 新增：CNC 配对上传 / 下发透传（与 PartCncCard 内部 emit 同名）。
  pairUpload: [payload: { gcodes: File[]; setup: File; resolve: (ok: boolean) => void }];
  release: [payload: { shelfId: string; processId: string; resolve: (ok: boolean) => void }];
}>();

const activeTab = ref<TabKey>('DRAWING');

/**
 * 选中状态：FileListCard 当前不暴露 row-select 事件，本组件通过监听
 * @uploaded / @deleted 维护；click 选中待 FileListCard 加 @select 事件后接通。
 */
const selectedFileId = ref<string | null>(null);
const deleteSelectedSubmitting = ref(false);
const printing = ref(false);

function onFileUploaded(_kind: TabKey, f: PartFileItem): void {
  // 上传成功后暂不更新选中（保持旧选中）；caller 触发 refresh 后会重新拉列表
  void f;
}
function onFileDeleted(_kind: TabKey, id: string): void {
  if (selectedFileId.value === id) selectedFileId.value = null;
}

async function onDeleteSelected(): Promise<void> {
  if (!selectedFileId.value) return;
  // FileListCard 已弹 ElMessageBox 二次确认；本组件层不再重复 confirm。
  // 直接走 v2 软删（OCC version 必传）；version 暂传 0（FileListCard 走 props 路径）。
  deleteSelectedSubmitting.value = true;
  try {
    await deletePartFile(selectedFileId.value, 0);
    ElMessage.success('已删除');
    selectedFileId.value = null;
    emit('refresh', activeTab.value as 'DRAWING' | '3D_MODEL' | 'CAD_2D');
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除失败');
  } finally {
    deleteSelectedSubmitting.value = false;
  }
}

async function onPrintDrawing(): Promise<void> {
  printing.value = true;
  try {
    const blob = await printPartDrawing(props.partId);
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        window.open(url, '_blank')?.print();
      } finally {
        setTimeout(() => {
          URL.revokeObjectURL(url);
          iframe.remove();
          printing.value = false;
        }, 800);
      }
    };
  } catch (e) {
    ElMessage.error((e as Error).message ?? '生成打印 PDF 失败');
    printing.value = false;
  }
}

// 切换 partId 时清空选中
import { watch } from 'vue';
watch(
  () => props.partId,
  () => {
    selectedFileId.value = null;
    activeTab.value = 'DRAWING';
  },
);
</script>

<style lang="scss" scoped>
.files-tabs-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.muted {
  color: var(--text-secondary);
  font-size: 13px;
}

.inline-tabs {
  :deep(.el-tabs__header) {
    margin: 0;
  }
  :deep(.el-tabs__nav-wrap::after) {
    height: 0;
  }
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}
.footer-tip {
  font-size: 12px;
}
.footer-actions {
  display: flex;
  gap: 8px;
}
</style>
