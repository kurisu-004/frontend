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
  - 图片 / PDF 走 mock blobUrl = 'about:blank'；阶段二切 api.get('/files/{id}/content', blob)
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

      <!-- 图纸 Tab：PDF / 图片内嵌预览，无文件切换按钮 -->
      <el-tab-pane label="图纸" name="drawings">
        <div v-if="!selectedFile" class="tab-empty">
          <el-empty description="该零件暂无图纸" :image-size="60" />
        </div>
        <div v-else class="file-preview">
          <PdfViewer
            v-if="isPdf(selectedFile.file_type)"
            :url="selectedFile.preview_url"
            :key="selectedFile.id"
          />
          <el-image
            v-else-if="isImage(selectedFile.file_type)"
            :src="selectedFile.preview_url"
            :preview-src-list="[selectedFile.preview_url]"
            fit="contain"
            class="image-preview"
          />
        </div>
      </el-tab-pane>

      <!-- 3D Tab：功能未实现占位 -->
      <el-tab-pane label="3D 模型" name="models3d">
        <div class="placeholder-block">
          <el-icon :size="40" color="#909399"><Tools /></el-icon>
          <p class="placeholder-text">3D 模型预览功能未实现</p>
          <p class="placeholder-hint">后续版本将支持 STEP / IGES / STL 等格式内嵌查看</p>
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
import { computed, ref, watch } from 'vue'
import { Tools } from '@element-plus/icons-vue'
import PdfViewer from '@/components/PdfViewer.vue'
import type { PartListItem } from '@/types/parts'
import { usePartFiles } from '../../parts/composables/usePartFiles'
import { FIXTURE_FILES, type MockPartFile } from '../__fixtures__/partProcess.fixtures'

const props = defineProps<{
  part: PartListItem | null
}>()

const activeTab = ref<'drawings' | 'models3d' | 'cad'>('drawings')
const partIdRef = computed<string>(() => props.part?.id ?? '')
const partFiles = usePartFiles(partIdRef)
const { fetchDrawings, fetch3DModels, fetchCadFiles } = partFiles

// mock 文件列表（阶段二由 usePartFiles 接管）
const mockFiles = ref<MockPartFile[]>([])
// 2026-09-12：drawings 只保留可预览的 PDF / 图片（其他类型在 3D / CAD 占位 tab 表达，
// 不再走 non-pdf-preview 兜底）。
const drawings = computed(() =>
  mockFiles.value.filter((f) => isPdf(f.file_type) || isImage(f.file_type)),
)
const selectedFile = ref<MockPartFile | null>(null)

watch(
  () => props.part?.id,
  async (newId) => {
    selectedFile.value = null
    if (!newId) {
      mockFiles.value = []
      return
    }
    mockFiles.value = FIXTURE_FILES[newId] ?? []
    // 阶段二：替换为 usePartFiles 的 fetch*
    await Promise.all([fetchDrawings(), fetch3DModels(), fetchCadFiles()])
    // 默认选中第一张图纸
    const first = drawings.value[0]
    if (first) selectedFile.value = first
  },
  { immediate: true },
)

function isPdf(t: string): boolean {
  return t.toUpperCase() === 'PDF'
}
function isImage(t: string): boolean {
  const up = t.toUpperCase()
  return ['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'WEBP'].includes(up)
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
  :deep(.el-tab-pane) {
    height: 100%;
  }
}
.file-preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
.placeholder-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 80px 0;
  color: var(--el-text-color-secondary);
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
