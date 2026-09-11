<!--
  DrawingPreviewPane.vue
  工序制定页中栏：零件图纸 / 3D / CAD 三 Tab + 内嵌预览。
  2026-09-11 新增。
  - 选 PDF → <PdfViewer :url="blobUrl">
  - 选图片 → <el-image :src="blobUrl">
  - 其它类型（STEP/DWG）→ 走下载提示（不内嵌）
  - 图片用 mock blobUrl = 'about:blank'，PDF 同样 mock；阶段二切 api.get('/files/{id}/content', blob)
-->
<template>
  <el-card shadow="never" class="preview-card">
    <template #header>
      <div class="preview-header">
        <span class="preview-title">
          {{ part ? `${part.drawing_no} ${part.name}` : '零件图纸' }}
        </span>
        <el-tag v-if="part" size="small" type="info" effect="plain">
          {{ totalFiles }} 个文件
        </el-tag>
      </div>
    </template>

    <div v-if="!part" class="preview-empty">
      <el-empty description="请先在左侧选择零件" :image-size="80" />
    </div>
    <el-tabs v-else v-model="activeTab" class="preview-tabs">
      <!-- 图纸 Tab：图片走 el-image，PDF 走 PdfViewer，其它走下载 -->
      <el-tab-pane label="图纸" name="drawings">
        <div v-if="drawings.length === 0" class="tab-empty">
          <el-empty description="该零件暂无图纸" :image-size="60" />
        </div>
        <div v-else class="file-picker-row">
          <el-button
            v-for="f in drawings"
            :key="f.id"
            :type="selectedFile?.id === f.id ? 'primary' : 'default'"
            :plain="selectedFile?.id !== f.id"
            size="small"
            @click="onSelectFile(f)"
          >
            <el-icon><Picture /></el-icon>
            <span>{{ f.original_filename }}</span>
          </el-button>
        </div>
        <div v-if="selectedFile" class="file-preview">
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
          <div v-else class="non-pdf-preview">
            <el-icon :size="40" color="#909399"><Files /></el-icon>
            <p class="non-pdf-name">{{ selectedFile.original_filename }}</p>
            <p class="non-pdf-hint">
              {{ selectedFile.file_type }} 文件不支持浏览器内嵌预览
            </p>
          </div>
        </div>
      </el-tab-pane>

      <!-- 3D Tab：仅列出文件名，不内嵌 -->
      <el-tab-pane label="3D 模型" name="models3d">
        <div v-if="models3d.length === 0" class="tab-empty">
          <el-empty description="该零件暂无 3D 模型" :image-size="60" />
        </div>
        <ul v-else class="file-list">
          <li v-for="f in models3d" :key="f.id">
            <el-icon><Files /></el-icon>
            <span>{{ f.original_filename }}</span>
            <el-tag size="small" effect="plain">{{ f.file_type }}</el-tag>
          </li>
        </ul>
      </el-tab-pane>

      <!-- CAD Tab：仅列出文件名，不内嵌 -->
      <el-tab-pane label="CAD 源文件" name="cad">
        <div v-if="cadFiles.length === 0" class="tab-empty">
          <el-empty description="该零件暂无 CAD 源文件" :image-size="60" />
        </div>
        <ul v-else class="file-list">
          <li v-for="f in cadFiles" :key="f.id">
            <el-icon><Files /></el-icon>
            <span>{{ f.original_filename }}</span>
            <el-tag size="small" effect="plain">{{ f.file_type }}</el-tag>
          </li>
        </ul>
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Files, Picture } from '@element-plus/icons-vue'
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
const drawings = computed(() => mockFiles.value.filter((f) => ['PDF', 'PNG', 'JPG', 'JPEG'].includes(f.file_type)))
const models3d = computed(() => mockFiles.value.filter((f) => ['STEP', 'STP', 'IGES', 'IGS', 'STL', 'OBJ', '3MF'].includes(f.file_type)))
const cadFiles = computed(() => mockFiles.value.filter((f) => ['DWG', 'DXF'].includes(f.file_type)))
const totalFiles = computed(() => mockFiles.value.length)

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

function onSelectFile(f: MockPartFile): void {
  selectedFile.value = f
}

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
  }
}
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.preview-title {
  font-weight: 600;
  font-size: 14px;
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
.file-picker-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
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
.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: #fff;
  }
}
.non-pdf-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 60px 0;
  color: var(--text-secondary);
}
.non-pdf-name {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
}
.non-pdf-hint {
  margin: 0;
  font-size: 12px;
}
</style>
