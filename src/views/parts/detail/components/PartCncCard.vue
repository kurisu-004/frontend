<!--
  PartCncCard.vue

  CNC 文件卡（PartDetail 第 7 张卡）：
  - 配对列表：G 代码 + 设定单（来自 cncSetupGroups 计算值）
  - 配对上传对话框（partId + gcodeList + setupFile → emit pair-upload）
  - 配对上传对话框的 UI 状态（可见性、form refs）由本组件局部维护
  - 2026-10-10：「下发到 CNC 货架」按钮与对话框整块删除（用户决定：下发功能已被
    扫码台的工人放回 / 送检接管），随之删除 `release` / `releaseSuccess` 两个 emit
    与 `productionShelves` prop —— 它们都只服务于那个对话框。
  - 下载 / 删除 / formatBytes 由父组件（usePartCncGroups）通过 props 传入

  2026-08-25 frontend-overall-refactor：从 PartDetail.vue 抽出。
-->
<template>
  <el-card v-loading="cncLoading" shadow="never" class="cnc-card">
    <!--
      2026-09-17 review 第 2 轮新增：bareMode=true 时整个 header 整块不渲染
      （PartFilesTabsCard 用：「body 部分就直接是图纸、3D 模型等文件，
      不要再套一层 card」）。
    -->
    <template v-if="!bareMode" #header>
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
                link
                type="danger"
                size="small"
                @click="onDeleteCnc(g.id, g.version)"
                >删除</el-button
              >
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
              <el-button link type="primary" size="small" @click="onDownloadCnc(group.setup)"
                >下载</el-button
              >
              <el-button
                v-if="canManageSetupSheet"
                link
                type="danger"
                size="small"
                @click="onDeleteCnc(group.setup.id, group.setup.version)"
                >删除</el-button
              >
            </div>
          </template>
          <span v-else class="cnc-empty">无设定单</span>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无 CNC 程序" :image-size="80" />

    <div v-if="(canManageCncFiles || canManageSetupSheet) && !hideHeaderActions" class="cnc-upload">
      <el-button
        v-if="canManageCncFiles && canManageSetupSheet"
        type="primary"
        @click="openPairUpload"
      >
        <el-icon><Upload /></el-icon><span>配对上载 (G代码 + 设定单)</span>
      </el-button>
    </div>

    <!-- 配对上传对话框 -->
    <el-dialog
      v-model="pairUploadVisible"
      title="配对上载 G 代码 + CNC 设定单"
      width="500px"
      @close="onPairUploadClose"
    >
      <el-form label-width="100px">
        <el-form-item label="G 代码文件" for="">
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
        <el-form-item label="CNC 设定单" for="">
          <el-upload
            :auto-upload="false"
            :show-file-list="true"
            :limit="1"
            name="cnc_setup"
            accept=".pdf"
            :on-change="onPairSetupChange"
            :on-remove="
              () => {
                pairSetupFile = null;
              }
            "
          >
            <el-button plain>选择设定单 (.pdf)</el-button>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="pairUploading" @click="pairUploadVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="pairUploading"
          :disabled="pairGcodeFiles.length === 0 || !pairSetupFile"
          @click="onPairUploadConfirm"
          >确认上传</el-button
        >
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { UploadFile } from 'element-plus';
import { Cpu, Upload } from '@element-plus/icons-vue';
import { formatDateTime } from '@/utils/date';
import type { PartFileItem } from '@/types/part_file';
import type { CncSetupGroup } from '../composables/usePartCncGroups';

const props = withDefaults(
  defineProps<{
    partId: string;
    cncSetupGroups: CncSetupGroup[];
    cncLoading: boolean;
    canManageCncFiles: boolean;
    canManageSetupSheet: boolean;
    // 2026-09-16：v2 file_size 为 string（i64 雪花序列化器），formatBytes 入参兼容 string | number
    formatBytes: (v: string | number) => string;
    // 2026-08-25 T10p5：上传文件 staging 助手，由 usePartCncGroups 注入；
    // 失败扩展名时统一 ElMessage.warning 提示（修复前内联实现丢提示的回归）。
    fileList: (
      current: UploadFile[],
      file: UploadFile,
      accept: string,
      matchExt?: boolean,
    ) => UploadFile[];
    onDownloadCnc: (p: PartFileItem) => void;
    // 2026-09-16：v2 软删强制 OCC body { version }，删除需携带行内版本号
    onDeleteCnc: (id: string, version: number) => void;
    /**
     * 2026-09-17 UI 调整：是否隐藏内层「配对上载」按钮。
     * PartFilesTabsCard footer 已统一收纳这两类入口，传 true 让 body 只剩
     * 配对列表 + dialog，避免重复按钮。
     */
    hideHeaderActions?: boolean;
    /**
     * 2026-09-17 review 第 2 轮新增：是否完全去掉内层 header 渲染。
     * bareMode=true 时整个 `<template #header>` 块 v-if 不渲染（不再显示
     * 「CNC 文件」标题），用于 PartFilesTabsCard 这种「外层已包 el-card +
     * header，内层不要再嵌一层」的场景。hideHeaderActions 控制内层按钮是
     * 否显示（bareMode 下也保留隐藏语义以避免 button 散落在 body）。
     */
    bareMode?: boolean;
  }>(),
  { hideHeaderActions: false, bareMode: false },
);

const emit = defineEmits<{
  fetch: [];
  // 2026-08-25 T10p5：dialog 关闭延迟到 API 成功之后（避免 API 失败但 dialog 已关）。
  // shell 调 resolve(ok)：成功才关 dialog + reset submitting。
  pairUpload: [payload: { gcodes: File[]; setup: File; resolve: (ok: boolean) => void }];
}>();

// ============ 配对上传对话框（局部 UI 状态）============
const pairUploadVisible = ref(false);
const pairGcodeFiles = ref<UploadFile[]>([]);
const pairSetupFile = ref<File | null>(null);
const pairUploading = ref(false);

function onPairGcodeChange(file: UploadFile, _uploadFiles: UploadFile[]): void {
  // 2026-08-25 T10p5：走 usePartCncGroups.fileList，失败扩展名时统一 ElMessage.warning 提示。
  pairGcodeFiles.value = props.fileList(
    pairGcodeFiles.value,
    file,
    '.nc,.tap,.cnc,.mpf,.ngc',
    true,
  );
}
function onPairGcodeRemove(file: UploadFile): void {
  pairGcodeFiles.value = pairGcodeFiles.value.filter((f) => f.uid !== file.uid);
}
function onPairSetupChange(file: UploadFile): void {
  pairSetupFile.value = file.raw ?? null;
}
function onPairUploadClose(): void {
  pairGcodeFiles.value = [];
  pairSetupFile.value = null;
}

function openPairUpload() {
  pairGcodeFiles.value = [];
  pairSetupFile.value = null;
  pairUploadVisible.value = true;
}

function onPairUploadConfirm(): void {
  const raws: File[] = [];
  for (const f of pairGcodeFiles.value) {
    if (f.raw) raws.push(f.raw);
  }
  if (raws.length === 0 || !pairSetupFile.value) return;
  pairUploading.value = true;
  // shell 调 resolve(ok)：成功才关 dialog + 清空 files + reset submitting。
  emit('pairUpload', {
    gcodes: raws,
    setup: pairSetupFile.value,
    resolve: (ok: boolean) => {
      pairUploading.value = false;
      if (ok) {
        pairUploadVisible.value = false;
        onPairUploadClose();
      }
    },
  });
}

onMounted(() => emit('fetch'));
watch(
  () => props.partId,
  () => emit('fetch'),
);

// 2026-09-17 UI 调整：暴露配对上传对话框打开方法给父级 PartFilesTabsCard footer
// 按钮调用，把 CNC 操作的入口收敛到外层 footer。内部仍保留按钮（PartCncCard 当前
// 唯一调用方就是 PartFilesTabsCard，但保留内部按钮以防未来抽到独立路由）。
defineExpose({
  openPairUpload,
});
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
</style>
