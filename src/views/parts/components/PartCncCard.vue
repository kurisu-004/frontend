<!--
  PartCncCard.vue

  CNC 文件卡（PartDetail 第 7 张卡）：
  - 配对列表：G 代码 + 设定单（来自 cncSetupGroups 计算值）
  - 配对上传对话框（partId + gcodeList + setupFile → emit pair-upload）
  - 下发到 CNC 货架对话框（partId + shelfId + processId → emit release）
  - 配对上传 / 下发对话框的 UI 状态（可见性、form refs）由本组件局部维护
  - 下载 / 删除 / formatBytes 由父组件（usePartCncGroups）通过 props 传入

  2026-08-25 frontend-overall-refactor：从 PartDetail.vue 抽出。
-->
<template>
  <el-card shadow="never" class="cnc-card" v-loading="cncLoading">
    <template #header>
      <div class="card-header">
        <span class="card-title">
          <el-icon><Cpu /></el-icon>
          <span>CNC 文件</span>
        </span>
      </div>
    </template>

    <!-- 配对列表：G 代码（左列）+ 设定单（右列），两两对应 -->
    <div v-if="cncSetupGroups.length > 0" class="cnc-group-list">
      <div class="cnc-group-header">
        <span class="cnc-group-header-col">G 代码</span>
        <span class="cnc-group-header-col">CNC 设定单</span>
      </div>
      <div
        v-for="(group, gIdx) in cncSetupGroups"
        :key="group.setup?.id ?? `__unpaired_${gIdx}`"
        class="cnc-group-row"
      >
        <div class="cnc-gcode-col">
          <template v-if="group.gcodes.length > 0">
            <div v-for="g in group.gcodes" :key="g.id" class="cnc-sub-row">
              <el-tag size="small" type="info">{{ g.file_type }}</el-tag>
              <span class="cnc-name">{{ g.original_filename }}</span>
              <span class="cnc-size">{{ formatBytes(g.file_size) }}</span>
              <span class="cnc-time">{{ formatDateTime(g.created_at) }}</span>
              <el-button link type="primary" size="small" @click="onDownloadCnc(g)">下载</el-button>
              <el-button
                v-if="canManageCncFiles"
                link type="danger" size="small"
                @click="onDeleteCnc(g.id)"
              >删除</el-button>
            </div>
          </template>
          <span v-else class="cnc-empty">—</span>
        </div>
        <div class="cnc-setup-col">
          <template v-if="group.setup">
            <div class="cnc-sub-row">
              <el-tag size="small" type="success">PDF</el-tag>
              <span class="cnc-name">{{ group.setup.original_filename }}</span>
              <span class="cnc-size">{{ formatBytes(group.setup.file_size) }}</span>
              <span class="cnc-time">{{ formatDateTime(group.setup.created_at) }}</span>
              <el-button link type="primary" size="small" @click="onDownloadCnc(group.setup)">下载</el-button>
              <el-button
                v-if="canManageSetupSheet"
                link type="danger" size="small"
                @click="onDeleteCnc(group.setup.id)"
              >删除</el-button>
            </div>
          </template>
          <span v-else class="cnc-empty">无设定单</span>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无 CNC 程序" :image-size="80" />

    <div v-if="canManageCncFiles || canManageSetupSheet" class="cnc-upload">
      <el-button
        v-if="canManageCncFiles && canManageSetupSheet"
        type="primary"
        @click="openPairUpload"
      >
        <el-icon><Upload /></el-icon><span>配对上载 (G代码 + 设定单)</span>
      </el-button>
      <el-button
        v-if="canManageCncFiles && partStatus === 'PROGRAMMING'"
        type="success"
        :loading="releaseSubmitting"
        @click="openRelease"
      >
        下发到 CNC 货架
      </el-button>
    </div>

    <!-- 配对上传对话框 -->
    <el-dialog v-model="pairUploadVisible" title="配对上载 G 代码 + CNC 设定单" width="500px" @close="onPairUploadClose">
      <el-form label-width="100px">
        <el-form-item label="G 代码文件" :for="''">
          <el-upload
            :auto-upload="false"
            :show-file-list="true"
            multiple
            name="gcode_files"
            accept=".nc,.tap,.cnc,.mpf,.ngc"
            :file-list="pairGcodeFiles"
            :on-change="onPairGcodeChange"
            :on-remove="onPairGcodeRemove"
          >
            <el-button plain>选择 G 代码（可多个）</el-button>
          </el-upload>
        </el-form-item>
        <el-form-item label="CNC 设定单" :for="''">
          <el-upload
            :auto-upload="false"
            :show-file-list="true"
            :limit="1"
            name="cnc_setup"
            accept=".pdf"
            :on-change="onPairSetupChange"
            :on-remove="() => { pairSetupFile = null }"
          >
            <el-button plain>选择设定单 (.pdf)</el-button>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pairUploadVisible = false" :disabled="pairUploading">取消</el-button>
        <el-button
          type="primary"
          :loading="pairUploading"
          :disabled="pairGcodeFiles.length === 0 || !pairSetupFile"
          @click="onPairUploadConfirm"
        >确认上传</el-button>
      </template>
    </el-dialog>

    <!-- 下发到 CNC 货架对话框 -->
    <el-dialog
      v-model="releaseVisible"
      title="下发到 CNC 货架"
      :width="releaseDlg.width"
      :top="releaseDlg.top"
      :fullscreen="releaseDlg.fullscreen"
      @closed="onReleaseClosed"
    >
      <el-form label-width="96px">
        <el-form-item label="下一道工序" required>
          <el-select
            v-model="releaseNextProcessId"
            placeholder="请先选择下一道工序"
            style="width: 100%"
            filterable
            clearable
          >
            <el-option
              v-for="p in releaseFilteredProcesses"
              :key="p.id"
              :label="`${p.code} / ${p.name}`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标货架" required>
          <el-select
            v-model="releaseShelfId"
            placeholder="先选工序；货架候选按映射过滤"
            style="width: 100%"
            filterable
            clearable
            :disabled="!releaseNextProcessId"
          >
            <el-option
              v-for="s in releaseFilteredShelves"
              :key="s.id"
              :label="s.name"
              :value="s.id"
            />
            <template #empty>
              <span class="muted">
                {{
                  releaseNextProcessId
                    ? '当前工序未映射到任何生产货架，请先在「货架管理 → 工序映射」配置'
                    : '请先选择下一道工序'
                }}
              </span>
            </template>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="releaseVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="releaseSubmitting"
          :disabled="!releaseShelfId || !releaseNextProcessId"
          @click="onReleaseConfirm"
        >确认下发</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { type UploadFile } from 'element-plus'
import { Cpu, Upload } from '@element-plus/icons-vue'
import { formatDateTime } from '@/utils/date'
import { useDialogSize } from '@/composables/useDialogSize'
import { useShelfProcessFilter } from '@/composables/useShelfProcessFilter'
import type { PartFileItem } from '@/types/part_file'
import type { Process } from '@/types/process'
import type { Shelf } from '@/types/shelf'
import type { OrderStatus } from '@/types/parts'
import type { CncSetupGroup } from '../composables/usePartCncGroups'

const props = defineProps<{
  partId: string
  partStatus: OrderStatus
  cncSetupGroups: CncSetupGroup[]
  cncLoading: boolean
  canManageCncFiles: boolean
  canManageSetupSheet: boolean
  /** 货架 ↔ 工序 共享缓存（shell 加载，PartCncCard 与 failInsp/receive 共用） */
  productionShelves: Shelf[]
  processes: Process[]
  formatBytes: (n: number) => string
  // 2026-08-25 T10p5：上传文件 staging 助手，由 usePartCncGroups 注入；
  // 失败扩展名时统一 ElMessage.warning 提示（修复前内联实现丢提示的回归）。
  fileList: (
    current: UploadFile[],
    file: UploadFile,
    accept: string,
    matchExt?: boolean,
  ) => UploadFile[]
  onDownloadCnc: (p: PartFileItem) => void
  onDeleteCnc: (id: string) => void
}>()

const emit = defineEmits<{
  (e: 'fetch'): void
  // 2026-08-25 T10p5：dialog 关闭延迟到 API 成功之后（避免 API 失败但 dialog 已关）。
  // shell 调 resolve(ok)：成功才关 dialog + reset submitting。
  (e: 'pair-upload', payload: { gcodes: File[]; setup: File; resolve: (ok: boolean) => void }): void
  (e: 'release', payload: { shelfId: string; processId: string; resolve: (ok: boolean) => void }): void
  (e: 'release-success'): void
}>()

// ============ 配对上传对话框（局部 UI 状态）============
const pairUploadVisible = ref(false)
const pairGcodeFiles = ref<UploadFile[]>([])
const pairSetupFile = ref<File | null>(null)
const pairUploading = ref(false)

function onPairGcodeChange(file: UploadFile, _uploadFiles: UploadFile[]): void {
  // 2026-08-25 T10p5：走 usePartCncGroups.fileList，失败扩展名时统一 ElMessage.warning 提示。
  pairGcodeFiles.value = props.fileList(
    pairGcodeFiles.value,
    file,
    '.nc,.tap,.cnc,.mpf,.ngc',
    true,
  )
}
function onPairGcodeRemove(file: UploadFile): void {
  pairGcodeFiles.value = pairGcodeFiles.value.filter((f) => f.uid !== file.uid)
}
function onPairSetupChange(file: UploadFile): void {
  pairSetupFile.value = file.raw ?? null
}
function onPairUploadClose(): void {
  pairGcodeFiles.value = []
  pairSetupFile.value = null
}

function openPairUpload() {
  pairGcodeFiles.value = []
  pairSetupFile.value = null
  pairUploadVisible.value = true
}

function onPairUploadConfirm(): void {
  const raws: File[] = []
  for (const f of pairGcodeFiles.value) {
    if (f.raw) raws.push(f.raw)
  }
  if (raws.length === 0 || !pairSetupFile.value) return
  pairUploading.value = true
  // shell 调 resolve(ok)：成功才关 dialog + 清空 files + reset submitting。
  emit('pair-upload', {
    gcodes: raws,
    setup: pairSetupFile.value,
    resolve: (ok: boolean) => {
      pairUploading.value = false
      if (ok) {
        pairUploadVisible.value = false
        onPairUploadClose()
      }
    },
  })
}

// ============ 下发到 CNC 货架对话框（局部 UI 状态）============
const releaseDlg = useDialogSize({ desktopWidth: 440 })
const releaseVisible = ref(false)
const releaseShelfId = ref<string | null>(null)
const releaseNextProcessId = ref<string | null>(null)
const releaseSubmitting = ref(false)

const {
  filteredShelves: releaseFilteredShelves,
  filteredProcesses: releaseFilteredProcesses,
  load: loadReleaseMap,
} = useShelfProcessFilter(
  computed(() => props.productionShelves),
  computed(() => props.processes),
  releaseShelfId,
  releaseNextProcessId,
)

async function openRelease() {
  releaseShelfId.value = null
  releaseNextProcessId.value = null
  try {
    await loadReleaseMap()
  } catch { /* filteredXxx 走兜底全量 */ }
  releaseVisible.value = true
}

function onReleaseClosed(): void {
  releaseShelfId.value = null
  releaseNextProcessId.value = null
}

function onReleaseConfirm(): void {
  if (!releaseShelfId.value || !releaseNextProcessId.value) return
  releaseSubmitting.value = true
  // shell 调 resolve(ok)：成功才关 dialog + reset submitting。
  emit('release', {
    shelfId: releaseShelfId.value,
    processId: releaseNextProcessId.value,
    resolve: (ok: boolean) => {
      releaseSubmitting.value = false
      if (ok) releaseVisible.value = false
    },
  })
}

onMounted(() => emit('fetch'))
watch(() => props.partId, () => emit('fetch'))
</script>

<style lang="scss" scoped>
.cnc-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
  .cnc-group-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cnc-group-header {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 8px;
    padding: 4px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .cnc-group-header-col {
    text-align: left;
  }
  .cnc-group-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    align-items: stretch;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 4px;
    font-size: 13px;
  }
  .cnc-gcode-col,
  .cnc-setup-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .cnc-sub-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .cnc-empty {
    color: var(--text-secondary);
    font-size: 13px;
  }
  .cnc-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cnc-size,
  .cnc-time {
    color: var(--text-secondary);
    font-size: 12px;
  }
  .cnc-upload {
    margin-top: 12px;
    display: flex;
    gap: 8px;
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
}
</style>
