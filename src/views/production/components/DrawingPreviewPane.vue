<!--
  DrawingPreviewPane.vue
  工序制定页中栏：零件图纸 / 3D / CAD 三 Tab + 内嵌预览。
  2026-09-11 新增。
  2026-09-12 重构：
    - 删除 <el-card #header>（"零件名 + N 个文件" 标题），零件名改为 el-tabs 左侧文字
    - 删除图纸 Tab 上方 <div class="file-picker-row"> 文件切换按钮（多文件不再提供切换 UI）
    - 3D / CAD Tab 改为「功能未实现」占位（Tools icon + 提示文案）
    - drawings 计算属性只保留 PDF / 图片（其他类型不在图 tab 显示，避免 non-pdf-preview 兜底）
    - 选中 part 后默认选中第一张 PDF / 图片
  - 选 PDF → <PdfViewer :url="blobUrl">
  - 选图片 → <el-image :src="blobUrl">
  2026-09-20：3D Tab 接入 StepViewer，替换原"功能未实现"占位（PR step-viewer-integration）。
    - 切 part → 拉 models3d 列表 → 过滤 occt-wasm 支持的格式（STEP/STP/IGES/IGS/STL/BREP，
      OBJ/3MF 当前 occt-wasm 不支持）→ 取第一个 → api.get(/part-files/{id}/content, blob)
      → createObjectURL → StepViewer.src
    - onBeforeUnmount 统一 revoke blob URL，防止内存泄漏
    - StepViewer 组件本身负责 SceneManager / CubeGizmo dispose
  2026-09-29：单调用 + TanStack Query 重构
    - 删除 usePartFiles 三并发（fetchDrawings + fetch3DModels + fetchCadFiles），
      改 usePartFilesListQuery(part?.id) 拉 owner 全量，computed 按 kind 桶
    - 图纸 Tab 接入真实预签 URL（getPartFileDownloadUrl），不再走 fixture
    - 删 FIXTURE_FILES / MockPartFile / sample-drawing.pdf fixture 引用
-->
<template>
  <el-card shadow="never" class="preview-card">
    <div v-if="!part" class="preview-empty">
      <el-empty description="请先在左侧选择零件" :image-size="80" />
    </div>
    <el-tabs v-else v-model="activeTab" class="preview-tabs">
      <!-- 2026-09-12：零件名作为 el-tabs 左侧文字（替代原 card header），无 N 个文件 tag。 -->
      <template #prefix>
        <span class="preview-title">{{ part.drawing_no }} {{ part.name }}</span>
      </template>

      <!-- 图纸 Tab：PDF / 图片内嵌预览 -->
      <el-tab-pane label="图纸" name="drawings">
        <div v-if="previewUrlLoading" class="preview-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>正在获取预览链接...</span>
        </div>
        <div v-else-if="previewUrlError" class="preview-error">
          <el-empty :description="previewUrlError" :image-size="60" />
        </div>
        <div v-else-if="!selectedFile" class="tab-empty">
          <el-empty description="该零件暂无图纸" :image-size="60" />
        </div>
        <div v-else class="file-preview">
          <PdfViewer
            v-if="isPdf(selectedFile.file_type)"
            :key="selectedFile.id"
            :url="selectedPreviewUrl ?? ''"
          />
          <el-image
            v-else-if="isImage(selectedFile.file_type)"
            :src="selectedPreviewUrl ?? ''"
            :preview-src-list="selectedPreviewUrl ? [selectedPreviewUrl] : []"
            fit="contain"
            class="image-preview"
          />
        </div>
      </el-tab-pane>

      <!-- 3D Tab：接入 StepViewer（2026-09-20 PR step-viewer-integration） -->
      <el-tab-pane label="3D 模型" name="models3d">
        <div v-if="activeTab === 'models3d'" class="models3d-container">
          <StepViewer
            v-if="stepBlobUrl && stepFormat"
            :src="stepBlobUrl"
            :format="stepFormat"
            src-type="blob-url"
            height="100%"
            @error="onStepError"
            @loaded="onStepLoaded"
          />
          <div v-else-if="models3dLoading" class="models3d-loading">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>加载 3D 模型中...</span>
          </div>
          <div v-else class="models3d-empty">
            <el-empty description="该零件暂无 3D 模型" :image-size="60" />
          </div>
        </div>
      </el-tab-pane>

      <!-- CAD Tab：功能未实现占位 -->
      <el-tab-pane label="CAD 源文件" name="cad">
        <div class="placeholder-block">
          <el-icon :size="40" color="#909399"><Tools /></el-icon>
          <p class="placeholder-text">CAD 源文件预览功能未实现</p>
          <p class="placeholder-hint">后续版本将支持 DWG / DXF 等格式内嵌查看</p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Tools } from '@element-plus/icons-vue';
import PdfViewer from '@/components/PdfViewer.vue';
import StepViewer from '@/components/cad-viewer/StepViewer.vue';
import type { PartListItem } from '@/types/parts';
import type { PartFileItem } from '@/types/part_file';
// 2026-09-29 单调用：usePartFilesListQuery 替代 usePartFiles 三并发
// （fetchDrawings + fetch3DModels + fetchCadFiles）。reactive params 自动驱动
// useQuery 重取；切 part → ownerKey 变化 → 自动 refetch。
import { usePartFilesListQuery } from '@/composables/queries/usePartFilesListQuery';
import { fetchPartFileContent, getPartFileDownloadUrl } from '@/api/parts/file';
import { fileTypeToOcctFormat, isOcctSupported } from '@/utils/stepViewerFile';

const props = defineProps<{
  part: PartListItem | null;
}>();

const activeTab = ref<'drawings' | 'models3d' | 'cad'>('drawings');

// 2026-09-29：usePartFilesListQuery 接受 MaybeRefOrGetter<string | null | undefined>。
// props.part 可能为 null（未选零件）→ enabled=false + 二次守卫返回空，零网络请求。
const partFilesQuery = usePartFilesListQuery(() => props.part?.id ?? null);
const files = computed<PartFileItem[]>(() => partFilesQuery.data.value?.items ?? []);
const drawings = computed(() =>
  files.value.filter(
    (f) => f.kind === 'DRAWING' && (isPdf(f.file_type) || isImage(f.file_type)),
  ),
);
const models3d = computed(() => files.value.filter((f) => f.kind === '3D_MODEL'));
// 2026-09-29：cadFiles 不在 DrawingPreviewPane 内消费（CAD Tab 占位），保留
// PartDetail.vue 派生即可，本组件不重复导出。

// 2026-09-29：selectedFile 改 reactive computed，避免跨 part 残留旧数据。
// 切 part → files 重算 → drawings 重算 → selectedFile 自动重置。
const selectedFile = computed<PartFileItem | null>(() => drawings.value[0] ?? null);

// 2026-09-29：图纸 Tab 接预签 URL（getPartFileDownloadUrl 走 COS 临时签名）。
// selectedFile 变化 → 触发 loadPreviewUrl 拉新 part 的 URL；part 切走时
// selectedPreviewUrl 自动清空，避免跨 part 渲染旧 URL。
const selectedPreviewUrl = ref<string | null>(null);
const previewUrlLoading = ref(false);
const previewUrlError = ref<string | null>(null);

async function loadPreviewUrl(file: PartFileItem): Promise<void> {
  previewUrlLoading.value = true;
  previewUrlError.value = null;
  try {
    selectedPreviewUrl.value = await getPartFileDownloadUrl(file.id);
  } catch (e) {
    previewUrlError.value = (e as Error).message ?? '获取预览链接失败';
    selectedPreviewUrl.value = null;
  } finally {
    previewUrlLoading.value = false;
  }
}

watch(
  selectedFile,
  async (f) => {
    if (f) await loadPreviewUrl(f);
    else selectedPreviewUrl.value = null;
  },
  { immediate: true },
);

// 2026-09-20：3D Tab 状态。stepBlobUrl 由 models3d 数据就绪后 loadFirst3DModel
// 拉第一个 occt 支持的文件并 createObjectURL；切换 part / 卸载时 revoke 防内存泄漏。
const stepBlobUrl = ref<string | null>(null);
const stepFormat = ref<'step' | 'stl' | 'brep' | undefined>(undefined);
const models3dLoading = ref(false);

// 2026-09-29：3D Tab 数据流。
// 监听 models3d（computed from partFilesQuery.data）变化 → 拉新 part 的第一个
// occt-wasm 支持的 3D 文件 → 重新走 blob URL 路径。reactive models3d 自动驱动，
// 旧 part 的 stepBlobUrl 在 watch 入口 revoke（防止内存泄漏）。
watch(
  models3d,
  async (newModels) => {
    await loadFirst3DModel(newModels);
  },
  { immediate: true },
);

async function loadFirst3DModel(modelList: PartFileItem[]): Promise<void> {
  revokeStepBlob();
  const target = modelList.find((f) => isOcctSupported(f.file_type));
  if (!target) {
    // 无可预览 3D 模型 → models3d-empty 占位
    return;
  }
  models3dLoading.value = true;
  try {
    const blob = await fetchPartFileContent(target.id);
    stepBlobUrl.value = URL.createObjectURL(blob);
    stepFormat.value = fileTypeToOcctFormat(target.file_type) ?? undefined;
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载 3D 模型失败');
  } finally {
    models3dLoading.value = false;
  }
}

function revokeStepBlob(): void {
  if (stepBlobUrl.value) {
    URL.revokeObjectURL(stepBlobUrl.value);
    stepBlobUrl.value = null;
  }
  stepFormat.value = undefined;
}

function onStepError(msg: string): void {
  ElMessage.error(msg);
}

// 2026-09-20：预留调试钩子 —— loaded 时可读 stats 显示在右上角
function onStepLoaded(_info: { triangleCount: number; bbox: unknown; stats: unknown }): void {
  /* 当前无 UI 消费，保留入口供后续加统计卡片 */
}

onBeforeUnmount(() => {
  revokeStepBlob();
});

function isPdf(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}
function isImage(t: string): boolean {
  const up = t.toUpperCase();
  return ['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'WEBP'].includes(up);
}
</script>

<style lang="scss" scoped>
.preview-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    padding: 10px;
  }
}
.preview-title {
  font-weight: 600;
  font-size: 14px;
  margin-right: 12px;
  color: var(--el-text-color-regular);
}
.preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.preview-tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  :deep(.el-tabs__content) {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  // 2026-09-12 第四轮：el-tab-pane 改为 flex column，让内部 .file-preview 的 flex: 1 生效
  // （之前 display: block + height: 100% 时，file-preview 仍塌缩到内容高度）
  :deep(.el-tab-pane) {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
}
.file-preview {
  flex: 1;
  min-height: 0;
  overflow: hidden; // 2026-09-12 第四轮：file-preview 改为 flex column，让 PdfViewer 用 flex: 1 撑满
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: #fafbfc;
  padding: 8px;
}
.image-preview {
  max-width: 100%;
  max-height: 60vh;
  display: block;
  margin: 0 auto;
}
.tab-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
}
// 2026-09-29：图纸 Tab 加载 / 错误占位（接预签 URL 时）
.preview-loading {
  flex: 1;
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.preview-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.placeholder-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 80px 0;
  color: var(--el-text-color-secondary);
}
// 2026-09-20：3D Tab 容器 / loading / 空态
.models3d-container {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}
.models3d-loading {
  flex: 1;
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.models3d-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.placeholder-text {
  margin: 0;
  font-size: 14px;
  color: var(--el-text-color-regular);
}
.placeholder-hint {
  margin: 0;
  font-size: 12px;
}
</style>