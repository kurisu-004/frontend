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
      OBJ/3MF 当前 occt-wasm 不支持）→ 取第一个 → api.get(/files/objects/{id}/content, blob)
      → createObjectURL → StepViewer.src
    - onBeforeUnmount 统一 revoke blob URL，防止内存泄漏
    - StepViewer 组件本身负责 SceneManager / CubeGizmo dispose
  2026-09-29：单调用 + TanStack Query 重构
    - 删除 usePartFiles 三并发（fetchDrawings + fetch3DModels + fetchCadFiles），
      改 usePartFilesListQuery(part?.id) 拉 owner 全量，computed 按 kind 桶
    - 图纸 Tab 接入 fetchPartFileContent + URL.createObjectURL,完全镜像 3D Tab 范本
    - 删 FIXTURE_FILES / MockPartFile / sample-drawing.pdf fixture 引用
  2026-09-29 第二轮：图纸 Tab 从预签 URL 切到 /content 后端代理 blob
    - 消除 CORS 风险 + 预签 URL TTL 焦虑（FileListCard 下载流仍保留 /url）
    - 后端 Cache-Control: private, max-age=1200 让浏览器接管 20 min 重复预览
  2026-09-29 第三轮：图纸 / 3D Tab 按需懒加载 + 同文件短路
    - 选 part / 切 tab 时只拉当前 active tab 对应的 blob（图纸默认 active，
      3D 仅在切到 models3d 时才拉，3D blob 此前与图纸并发拖慢图纸加载）
    - loadPreviewUrl / loadFirst3DModel 内部 currentFileId 短路，tab 来回切换
      同文件不重复 fetch
    - 切到非 active tab 时 revoke 已有 blob URL，释放内存
  2026-10-13：图纸 Tab 的 PDF 走**两条**预览路径
    - 图片模式（默认）：`usePreviewPolling` 打 `GET /files/objects/{id}/preview`，
      等后端 CI 转出逐页图片直链 → `<ImagePager>`。浏览器不再下载整份 PDF。
    - 原始 PDF：`/content` blob + PdfViewer。两条触发 —— 用户点「查看原始 PDF」
      （图片模式少矢量缩放与文字选中，看细节要能退回）或轮询降级（端点不支持 /
      CI 失败 / 超时）自动兜底。降级原因以一行提示渲染在预览区顶部，不静默换路径。
    - 图片类文件不参与转图，仍走 blob → el-image（与 3D Tab 的 blob 生命周期同形）。
    - 本组件的宿主是 `.file-preview`（自带 flex 高度链），不是 el-dialog ⇒
      **不需要** .pdf-preview-dialog / .img-preview-dialog 那一套高度契约 class。
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

      <!-- 图纸 Tab：PDF 走转图直链 / 原始 PDF 两条路，图片走 el-image -->
      <el-tab-pane label="图纸" name="drawings">
        <div v-if="previewUrlLoading" class="preview-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ drawingsBusyHint }}</span>
        </div>
        <div v-else-if="previewUrlError" class="preview-error">
          <el-empty :description="previewUrlError" :image-size="60" />
        </div>
        <div v-else-if="!selectedFile" class="tab-empty">
          <el-empty description="该零件暂无图纸" :image-size="60" />
        </div>
        <div v-else class="file-preview">
          <!-- 图片模式：CI 转好的逐页直链（PDF 专属，图片类文件不参与转图）。 -->
          <div v-if="showImageMode" class="pdf-image-mode">
            <ImagePager :key="selectedFile.id" :pages="preview.pages.value" />
            <el-button class="original-btn" plain @click="showOriginalPdf = true">
              <el-icon><Document /></el-icon>
              <span>查看原始 PDF</span>
            </el-button>
          </div>
          <!-- 原始 PDF：用户点「查看原始 PDF」，或转图降级。降级原因显式渲染成一行提示。 -->
          <div v-else-if="isPdfSelected" class="pdf-original-mode">
            <div v-if="preview.degradedReason.value" class="degrade-hint">
              {{ preview.degradedReason.value }}
            </div>
            <PdfViewer
              v-if="selectedPreviewBlob"
              :key="`original-${selectedFile.id}`"
              :url="selectedPreviewBlob"
            />
            <!-- 还没 blob 的两种情形文案必须分开：转图还在等（没打算要 blob）与
                 「已决定看原始 PDF、正在拉 blob」。混成一句「加载原始 PDF…」会让仍在
                 转图的 PDF 显示成「在拉原始 PDF」，而此刻压根没发过 /content 请求。 -->
            <div v-else class="preview-loading">
              <el-icon class="is-loading"><Loading /></el-icon>
              <span>{{ wantsOriginalPdf ? '加载原始 PDF…' : '图纸转图中…' }}</span>
            </div>
          </div>
          <el-image
            v-else-if="isImage(selectedFile.file_type)"
            :src="selectedPreviewBlob ?? ''"
            :preview-src-list="selectedPreviewBlob ? [selectedPreviewBlob] : []"
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
import { Document, Loading, Tools } from '@element-plus/icons-vue';
import PdfViewer from '@/components/PdfViewer.vue';
import ImagePager from '@/components/ImagePager.vue';
import StepViewer from '@/components/cad-viewer/StepViewer.vue';
import type { ProcessDesignPartSchema } from '@/composables/queries/schemas';
import type { PartFileItem } from '@/types/part_file';
// 2026-09-29 单调用：usePartFilesListQuery 替代 usePartFiles 三并发
// （fetchDrawings + fetch3DModels + fetchCadFiles）。reactive params 自动驱动
// useQuery 重取；切 part → ownerKey 变化 → 自动 refetch。
import { usePartFilesListQuery } from '@/composables/queries/usePartFilesListQuery';
import { fetchPartFileContent } from '@/api/files/objects';
// 2026-10-13：图纸预览的 CI 转图轮询（首选路径），/content blob 降级为原始 PDF。
import { usePreviewPolling } from '@/composables/usePreviewPolling';
import { fileTypeToOcctFormat, isOcctSupported } from '@/utils/stepViewerFile';

const props = defineProps<{
  // 2026-10-05：随「制定工序」页数据源切到 prod 域 /prod/process-design/parts，
  // prop 类型由 PartListItem（20 余字段）换成本页窄行类型（7 字段）。
  // 本组件只读 id / drawing_no / name 三个字段。
  part: ProcessDesignPartSchema | null;
}>();

const activeTab = ref<'drawings' | 'models3d' | 'cad'>('drawings');

// 2026-09-29：usePartFilesListQuery 接受 MaybeRefOrGetter<string | null | undefined>。
// props.part 可能为 null（未选零件）→ enabled=false + 二次守卫返回空，零网络请求。
const partFilesQuery = usePartFilesListQuery(() => props.part?.id ?? null);
const files = computed<PartFileItem[]>(() => partFilesQuery.data.value?.items ?? []);
const drawings = computed(() =>
  files.value.filter((f) => f.kind === 'DRAWING' && (isPdf(f.file_type) || isImage(f.file_type))),
);
const models3d = computed(() => files.value.filter((f) => f.kind === '3D_MODEL'));
// 2026-09-29：cadFiles 不在 DrawingPreviewPane 内消费（CAD Tab 占位），保留
// PartDetail.vue 派生即可，本组件不重复导出。

// 2026-09-29：selectedFile 改 reactive computed，避免跨 part 残留旧数据。
// 切 part → files 重算 → drawings 重算 → selectedFile 自动重置。
const selectedFile = computed<PartFileItem | null>(() => drawings.value[0] ?? null);

// 2026-09-29 第二轮：图纸 Tab 接 fetchPartFileContent + URL.createObjectURL
//（后端代理 blob,与 3D Tab 范本对称）。selectedFile 变化 → 触发 loadPreviewUrl
// 拉新 part 的 blob URL；part 切走时 revokePreviewBlob 防内存泄漏。
// 2026-10-13：**PDF 不再默认走 blob**。首选是 `preview`（CI 转图直链 → ImagePager），
// blob 只在两条情况下拉：用户点「查看原始 PDF」，或转图降级（端点不支持 / CI 失败 /
// 超时）自动兜底。图片类文件不在此列（不参与转图，blob + el-image 是唯一形态）。
const selectedPreviewBlob = ref<string | null>(null);
const previewUrlLoading = ref(false);
const previewUrlError = ref<string | null>(null);
// 2026-09-29 第三轮：跟踪当前 blob URL 对应的 file.id；
// tab 来回切换且同文件时 loadPreviewUrl/loadFirst3DModel 短路不重复拉
const currentPreviewFileId = ref<string | null>(null);
const current3DFileId = ref<string | null>(null);
// 2026-10-13：用户在图片模式下点「查看原始 PDF」。
const showOriginalPdf = ref(false);

// 当前选中的是不是一份 PDF（决定走「转图 / 原始 PDF」两条路还是 el-image）。
const isPdfSelected = computed<boolean>(
  () => selectedFile.value !== null && isPdf(selectedFile.value.file_type),
);

/**
 * PDF 图纸的 CI 转图轮询（2026-10-13）。
 *   - fileId：只有 PDF 才有转图；图片类传空串 ⇒ 零请求。
 *   - enabled：图纸 Tab 未激活时不轮询（切走还在后台转图会白占后端队列）。
 */
const preview = usePreviewPolling({
  fileId: () => (isPdfSelected.value && selectedFile.value ? selectedFile.value.id : ''),
  enabled: () => activeTab.value === 'drawings',
});

/**
 * 当前该显示哪条路（2026-10-13）。
 *
 * `wantsOriginalPdf` = 用户点了「查看原始 PDF」**或**转图已降级，两条触发合并成一个
 * 信号喂给下面的 blob watch —— 降级那一刻的表现与用户主动切换完全一致。
 *
 * ⚠️ `showImageMode` 必须同时看 `!wantsOriginalPdf`，不能只看 `preview.ready`：
 * 转图 ready 之后 `ready` 就一直是 true，只用它做分支条件的话，「查看原始 PDF」按钮
 * 会变成**空操作** —— 点击确实触发了 blob 拉取，但模板仍停在图片模式分支上，用户
 * 看不到任何变化，逃生口形同虚设。
 */
const wantsOriginalPdf = computed<boolean>(() => showOriginalPdf.value || preview.degraded.value);
const showImageMode = computed<boolean>(
  () => isPdfSelected.value && preview.ready.value && !wantsOriginalPdf.value,
);

/** 转图等待期的文案。与「文件列表加载中」区分开，让用户知道是在等 CI 而不是卡了。 */
const drawingsBusyHint = computed<string>(() =>
  preview.loading.value ? '图纸转图中…' : '正在加载预览...',
);

async function loadPreviewUrl(file: PartFileItem): Promise<void> {
  // 2026-10-13：PDF 走转图优先，不在这里拉 blob；图片类文件仍是 blob（与 3D Tab 同形）。
  if (isPdf(file.file_type)) return;
  // 2026-09-29 改造：图纸 Tab 从预签 URL 切到 /content 后端代理 blob,
  // 复用 3D Tab 的 URL.createObjectURL 模式 + revoke 防内存泄漏。
  // 后端 Cache-Control: private, max-age=1200 让浏览器 HTTP 缓存接管
  // 20 min 内重复预览,与 usePartFilesListQuery staleTime 对称。
  // 2026-09-29 第三轮：同文件短路 —— tab 来回切换时不重复 fetch，
  // 后端 20min Cache-Control 内的 HTTP 缓存命中由浏览器接管，本地不再多发请求。
  if (currentPreviewFileId.value === file.id) return;
  revokePreviewBlob();
  previewUrlLoading.value = true;
  previewUrlError.value = null;
  try {
    const blob = await fetchPartFileContent(file.id);
    // 迟到守卫：期间可能已切走图纸 Tab 或换了零件。切 Tab 不改 `selectedFile`，
    // 只比文件 id 的话这道守卫恒成立 —— 而那一支会 `revokePreviewBlob()`，此后再落
    // 进来的 blob 就是悬空的。
    if (activeTab.value !== 'drawings') return;
    if (selectedFile.value?.id !== file.id) return;
    selectedPreviewBlob.value = URL.createObjectURL(blob);
    currentPreviewFileId.value = file.id;
  } catch (e) {
    previewUrlError.value = (e as Error).message ?? '获取预览内容失败';
  } finally {
    previewUrlLoading.value = false;
  }
}

/**
 * PDF 的原始 PDF 路径有两条触发：用户点「查看原始 PDF」，或转图轮询降级。
 * 二者合并成一条 watch —— 降级那一刻的表现与用户主动切换完全一致，不给降级
 * 单开一条代码路径，免得两条路径哪天改出行为差。
 */
watch(
  [isPdfSelected, () => selectedFile.value, wantsOriginalPdf],
  async ([isPdfSel, file, wantOriginal]) => {
    if (!isPdfSel || !file) return;
    if (!wantOriginal) return;
    if (currentPreviewFileId.value === file.id) return; // 同文件短路（tab 来回切换）
    revokePreviewBlob();
    previewUrlLoading.value = true;
    previewUrlError.value = null;
    try {
      const blob = await fetchPartFileContent(file.id);
      // 迟到守卫：期间用户可能已切走图纸 Tab（那一支会 `revokePreviewBlob()`，此后再
      // 落进来的 blob 就是悬空的）或换了零件 ⇒ 迟到的 blob 直接丢弃。
      // ⚠️ 必须**同时**判「文件还是同一个」与「图纸 Tab 仍激活」：切 Tab 不改
      // `selectedFile`，只比文件的话这道守卫恒成立。
      if (activeTab.value !== 'drawings') return;
      if (selectedFile.value?.id !== file.id) return;
      selectedPreviewBlob.value = URL.createObjectURL(blob);
      currentPreviewFileId.value = file.id;
    } catch (e) {
      previewUrlError.value = (e as Error).message ?? '加载原始 PDF 失败';
    } finally {
      previewUrlLoading.value = false;
    }
  },
  { immediate: true },
);

// 2026-09-29 第三轮：图纸 Tab 按需懒加载。
// 切 part → selectedFile 变 → 重新拉；切 tab → activeTab 非 drawings → 释放；
// 切回 drawings 且同文件 → loadPreviewUrl 短路不重复拉。
// 2026-10-13：切走图纸 Tab 时转图轮询也一并停 —— `usePreviewPolling` 的 `enabled`
// 已按 activeTab 接线（切走即中断在途请求），这里不再重复调 `preview.stop()`。
watch(
  [selectedFile, activeTab],
  async ([f, tab]) => {
    if (tab === 'drawings') {
      showOriginalPdf.value = false;
      if (f) await loadPreviewUrl(f);
      else revokePreviewBlob();
    } else {
      revokePreviewBlob();
    }
  },
  { immediate: true },
);

// 2026-09-20：3D Tab 状态。stepBlobUrl 由 models3d 数据就绪后 loadFirst3DModel
// 拉第一个 occt 支持的文件并 createObjectURL；切换 part / 卸载时 revoke 防内存泄漏。
const stepBlobUrl = ref<string | null>(null);
const stepFormat = ref<'step' | 'stl' | 'brep' | undefined>(undefined);
const models3dLoading = ref(false);

// 2026-09-29 第三轮：3D Tab 按需懒加载。
// 旧实现 watch(models3d, …, { immediate: true })：默认 activeTab=drawings 时也立刻拉 3D blob，
// 拖慢图纸加载。改为多源：仅 activeTab=models3d 时才拉，否则 revoke。
watch(
  [models3d, activeTab],
  async ([newModels, tab]) => {
    if (tab === 'models3d') {
      await loadFirst3DModel(newModels);
    } else {
      revokeStepBlob();
    }
  },
  { immediate: true },
);

/**
 * 拉第一个 occt 支持的 3D 模型并 createObjectURL。
 *
 * ⚠️ **已知漏点：在途 blob 没有迟到守卫**（连文件 id 都没比）。切走 3D Tab 或换零件时
 * 外层 watch 会 `revokeStepBlob()`，此后若在途请求才回来，`stepBlobUrl` 会被重新挂上
 * 一份没人 revoke 的 blob（换 tab 反复几次即每次漏一份 3D 模型）。
 * 图纸预览链路上的同类写入点都带「宿主是否仍开着 + 文件是否还是同一个」两道判据
 * （`PreviewCarriers.spec.ts` 守着），这里没有 —— 修的时候照那个形态补齐即可。
 * 3D Tab 与图纸预览链路正交，未与那条链路一起改。
 */
async function loadFirst3DModel(modelList: PartFileItem[]): Promise<void> {
  // 2026-09-29 第三轮：先找 target 再 revoke —— 避免「当前已是同文件」时仍多走一次
  // revoke+重建 blob URL 的抖动；并支持同文件 tab 来回切换短路。
  const target = modelList.find((f) => isOcctSupported(f.file_type));
  if (!target) {
    // 无可预览 3D 模型 → models3d-empty 占位
    revokeStepBlob();
    return;
  }
  if (current3DFileId.value === target.id) return; // 2026-09-29 第三轮：同文件短路
  revokeStepBlob();
  models3dLoading.value = true;
  try {
    const blob = await fetchPartFileContent(target.id);
    stepBlobUrl.value = URL.createObjectURL(blob);
    stepFormat.value = fileTypeToOcctFormat(target.file_type) ?? undefined;
    current3DFileId.value = target.id;
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
  // 2026-09-29 第三轮：清同文件短路标记，保证下一次同文件重新走 loadFirst3DModel 时
  // 不会因为 current3DFileId 还指向已 revoke 的文件而误判。
  current3DFileId.value = null;
}

// 2026-09-29 新增：图纸 Tab blob 释放。语义与 revokeStepBlob 一致，
// 旧 selectedPreviewBlob（blob URL 字符串）必须 URL.revokeObjectURL 否则内存泄漏。
function revokePreviewBlob(): void {
  if (selectedPreviewBlob.value) {
    URL.revokeObjectURL(selectedPreviewBlob.value);
    selectedPreviewBlob.value = null;
  }
  // 2026-09-29 第三轮：清同文件短路标记。
  currentPreviewFileId.value = null;
}

function onStepError(msg: string): void {
  ElMessage.error(msg);
}

// 2026-09-20：预留调试钩子 —— loaded 时可读 stats 显示在右上角
function onStepLoaded(_info: { triangleCount: number; bbox: unknown; stats: unknown }): void {
  /* 当前无 UI 消费，保留入口供后续加统计卡片 */
}

onBeforeUnmount(() => {
  revokePreviewBlob();
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
/* 2026-10-13：PDF 预览拆成「图片模式 / 原始 PDF 模式」两个容器。本组件的宿主是
   .file-preview（自带 flex 高度链），故这两个容器只需 `flex: 1` 填满它。 */
.pdf-image-mode,
.pdf-original-mode {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
// 2026-09-29：图纸 Tab 加载 / 错误占位（接 fetchPartFileContent blob 时）
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
