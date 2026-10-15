<!--
  FileListCard.vue

  通用「文件列表 + 上传/删除/预览」卡片组件（2026-07-10 重写，2026-07-14 扩展）。
  2026-09-16 T3.5：场景 B 详情页补传改造。
  - apiUpload 不再限定必填；showUpload=true 但未注入时弹错误提示
  - 新增 apiGetPreviewUrl / apiGetDownloadUrl / apiDelete props，默认走
    `api/files/objects.ts` 的新函数（v2 实际路径 /files/objects/{id}/...；
    2026-10-13 随后端 files 域重组由 /part-files 硬切而来，旧路径 404 无 alias）
  - 文件内容预览不再在组件内硬编码 URL，统一走 `apiGetPreviewUrl` props（未注入时
    回落 `api/files/objects.ts` 的实现）

  用 kind 字段区分文件类型：
  - DRAWING           零件 / 子件 图纸
                        (PDF + 9 种图片：PNG/JPG/JPEG/GIF/BMP/TIF/TIFF/WEBP/HEIC)
                        图片与 PDF 同槽（单文件覆盖语义），打印背面要打条码
  - 3D_MODEL          零件 3D 模型
                        (STEP/STP/IGES/IGS/STL/OBJ/3MF)
  - G_CODE            零件 CNC G 代码（NC / TAP / CNC / MPF / NGC）
  - SETUP_SHEET       零件 CNC 设定单（PDF）
  - ASSEMBLY_MASTER   装配体总装图（PDF）
  - CAD_2D            零件 CAD 源文件（DWG / DXF）——2026-07-14 新增

  Props：
  - files:               PartFileItem[]
  - ownerType:           'assembly' | 'part'
  - ownerId:             string (雪花 ID 字符串)
  - defaultPage?:        number  默认 1
  - showUpload?:         boolean 默认 false
  - showDelete?:         boolean 默认 false
  - showPrint?:          boolean 默认 false（仅对 ownerType='part' 生效）
  - kind?:               PartFileKind 默认 'DRAWING'（决定 ACCEPT 与 title）
  - title?:              string   默认按 kind 显示
  - accept?:             string   默认按 kind 决定
  - emptyText?:          string   默认按 kind 显示
  - uploadLabel?:        string   默认 '上传' / '替换'（按 files.length 自动）
  - apiUpload?:          (id, file) => Promise<PartFileItem>   自定义上传 endpoint
  - apiGetPreviewUrl?:   (fileId) => Promise<string> | string   预览 URL（默认走 v2 /files/objects/{id}/content）
  - apiGetDownloadUrl?:  (fileId) => Promise<string> | string   下载 URL（默认走 v2 /files/objects/{id}/url）
  - apiDelete?:          (fileId) => Promise<void>              删除（默认走 v2 /files/objects/{id}/delete）

  2026-10-13 图纸预览切 CI 转图直链：
  - PDF 的**首选**渲染路径变成 `GET /files/objects/{id}/preview` → `<ImagePager>`；
    `/content` blob + PdfViewer 降级为「查看原始 PDF」逃生口 + 转图不可用时的自动兜底。
  - 图片类文件（PNG/JPG…）**不参与转图**，仍是 blob → el-image；3D 模型走 StepViewer。
  - 降级原因渲染成弹窗内一行提示（`.degrade-hint`）—— 静默换渲染路径会让 CI 故障无人察觉。
  → 预览弹窗的 el-dialog 挂 `pdf-preview-dialog` + `img-preview-dialog` 两个 class：
    两个预览组件的 flex 高度链同款，高度契约规则在 styles/index.scss 里逐条并列。
-->
<template>
  <el-card shadow="never" class="files-card">
    <!--
      2026-09-17 review 第 2 轮修复：bareMode=true 时整块 header 不渲染
      （PartFilesTabsCard 用：「body 部分就直接是图纸、3D 模型等文件，
      不要再套一层 card」）。内部 el-upload 仍要挂载（独立 <el-upload> 在
      模板下方），保证父级 footer 调 triggerUpload() 能拿到 input[type=file]
      并触发 .click()。
    -->
    <template v-if="!bareMode" #header>
      <div class="card-header">
        <span class="card-title">
          {{ titleText }}
          <el-tag v-if="files.length > 0" type="info" size="small" effect="plain">
            {{ files.length }} 个
          </el-tag>
        </span>
        <div class="header-actions">
          <el-button
            v-if="showPrint && ownerType === 'part' && !hideHeaderActions"
            type="success"
            plain
            :loading="printing"
            @click="onPrint"
          >
            <el-icon><Printer /></el-icon>
            <span>打印图纸（含条形码）</span>
          </el-button>
          <!--
            2026-09-17 review 第 2 轮修复：v-if 拆开。
            旧版 `v-if="showUpload && !hideHeaderActions"` 让 hideHeaderActions=true
            时整个 <el-upload> 被卸载 → uploadRef 永远是 undefined → 外层 footer
            点「上传图纸」按钮走 triggerUpload() 弹「上传控件未挂载」。
            现在 <el-upload> 由 showUpload 单独控制，内部 button 由 hideHeaderActions
            决定：uploadRef 始终可用，hideHeaderActions 只是把按钮文字藏起来。
          -->
          <el-upload
            v-if="showUpload"
            ref="uploadRef"
            :show-file-list="false"
            :auto-upload="false"
            :on-change="onPick"
            :accept="ACCEPT"
          >
            <el-button v-if="!hideHeaderActions" type="primary" plain :loading="uploading">
              <el-icon><Upload /></el-icon>
              <span>{{ uploadLabelText }}</span>
            </el-button>
          </el-upload>
        </div>
      </div>
    </template>

    <!--
      bareMode 下独立挂一个 display:none 的 <el-upload>，复用 uploadRef ref 名。
      Vue 3 v-if 互斥渲染，同名 ref 在 v-if 切换时自动 rebind，triggerUpload()
      始终能调到 input[type=file].click()。与上方 header 内的 el-upload 不会
      同时挂载（v-if 互斥）。
    -->
    <el-upload
      v-if="showUpload && bareMode"
      ref="uploadRef"
      :show-file-list="false"
      :auto-upload="false"
      :on-change="onPick"
      :accept="ACCEPT"
      style="display: none"
    />

    <div v-if="files.length === 0" class="empty-tip">
      <el-icon :size="32" color="#c0c4cc"><DocumentRemove /></el-icon>
      <p>{{ emptyTextText }}</p>
    </div>

    <div v-else class="file-grid">
      <div
        v-for="f in files"
        :key="f.id"
        :class="['file-item', { 'is-active': previewFile?.id === f.id }]"
        @click="onPreview(f)"
      >
        <el-icon :size="28" :color="iconColor(f.file_type)">
          <component :is="iconOf(f.file_type)" />
        </el-icon>
        <div class="file-meta">
          <div class="file-name" :title="f.original_filename">
            {{ f.original_filename }}
          </div>
          <div class="file-sub">
            <el-tag size="small" effect="plain">{{ f.file_type }}</el-tag>
            <span>{{ formatSize(f.file_size) }}</span>
          </div>
        </div>
        <el-button
          v-if="showDelete"
          link
          type="danger"
          size="small"
          class="del-btn"
          @click.stop="onDelete(f)"
        >
          <el-icon><Delete /></el-icon>
        </el-button>
      </div>
    </div>

    <!-- 预览弹窗（全屏）：PDF 有两条路（CI 转图直链 / 原始 PDF 兜底）；图片走 el-image；
         3D 模型走 StepViewer；其它走下载提示 -->
    <el-dialog
      v-model="previewVisible"
      class="pdf-preview-dialog img-preview-dialog"
      :title="previewTitle"
      fullscreen
      :close-on-click-modal="false"
      destroy-on-close
      @closed="onPreviewClosed"
    >
      <!-- 图片模式：CI 转好的逐页图片直链（默认路径，不下载整份 PDF）。 -->
      <div v-if="showImageMode" class="pdf-image-mode">
        <ImagePager :key="`img-${previewFile?.id}`" :pages="preview.pages.value" />
        <el-button class="original-btn" plain @click="showOriginalPdf = true">
          <el-icon><Document /></el-icon>
          <span>查看原始 PDF</span>
        </el-button>
      </div>
      <!-- 原始 PDF：用户点「查看原始 PDF」，或转图降级（端点不支持 / CI 失败 / 超时）。 -->
      <div v-else-if="isPdfType(previewFile)" class="pdf-original-mode">
        <div v-if="preview.degradedReason.value" class="degrade-hint">
          {{ preview.degradedReason.value }}
        </div>
        <!-- 还没 blob 的两种情形文案必须分开：转图还在等（没打算要 blob，此刻一个
             /content 请求都没发过）与「已决定看原始 PDF、正在拉 blob」。混成一句
             「加载原始 PDF…」会让仍在转图的 PDF 显示成「在拉原始 PDF」。 -->
        <div v-if="!previewBlobUrl" class="preview-loading">
          <el-icon :size="32" class="is-loading"><Loading /></el-icon>
          <span>{{ wantsOriginalPdf ? '加载原始 PDF…' : '图纸转图中…' }}</span>
        </div>
        <PdfViewer
          v-else
          :key="`pdf-${previewFile?.id}`"
          :url="previewBlobUrl"
          :page="defaultPage"
        />
      </div>
      <div v-else-if="previewFile && isImage(previewFile.file_type)" class="image-preview-wrap">
        <!-- 2026-07-14：HEIC 不被浏览器支持 → 走下载；其它图片走 el-image 全屏预览。
             2026-10-13：图片类文件不参与 CI 转图，仍是 blob → el-image。 -->
        <el-image
          v-if="!isHeic(previewFile.file_type)"
          :src="previewBlobUrl"
          :preview-src-list="[previewBlobUrl]"
          :initial-index="0"
          fit="contain"
          style="max-width: 100%; max-height: calc(100vh - 80px)"
        />
        <div v-else class="non-pdf-preview">
          <el-icon :size="48" :color="iconColor(previewFile.file_type)">
            <component :is="iconOf(previewFile.file_type)" />
          </el-icon>
          <p class="non-pdf-name">{{ previewFile.original_filename }}</p>
          <p class="non-pdf-hint">HEIC 格式浏览器不直接支持预览，请下载后查看。</p>
          <el-button type="primary" @click="downloadCurrent">
            <el-icon><Download /></el-icon>
            <span>下载文件</span>
          </el-button>
        </div>
      </div>
      <!-- 2026-09-20 PR step-viewer-integration：3D 模型内嵌预览。
           occt-wasm 当前支持 STEP/STP/IGES/IGS/STL/BREP，OBJ/3MF 不支持
           → 仍走下面 non-pdf-preview 下载兜底 -->
      <StepViewer
        v-else-if="
          previewFile && isOcctSupported(previewFile.file_type) && previewBlobUrl && stepFormat
        "
        :src="previewBlobUrl"
        :format="stepFormat"
        src-type="blob-url"
        :height="stepViewerHeight"
        error-prefix="3D 模型加载失败"
        @error="onStepError"
      />
      <div v-else class="non-pdf-preview">
        <el-icon :size="48" :color="iconColor(previewFile?.file_type || '')">
          <component :is="iconOf(previewFile?.file_type || '')" />
        </el-icon>
        <p class="non-pdf-name">{{ previewFile?.original_filename }}</p>
        <p class="non-pdf-hint">
          {{ previewFile?.file_type }} 文件不支持浏览器内嵌预览，请下载后查看。
        </p>
        <el-button type="primary" @click="downloadCurrent">
          <el-icon><Download /></el-icon>
          <span>下载文件</span>
        </el-button>
      </div>
    </el-dialog>

    <!-- 打印用隐藏 iframe -->
    <iframe
      ref="printIframeRef"
      style="
        position: fixed;
        right: 0;
        bottom: 0;
        width: 1px;
        height: 1px;
        border: 0;
        opacity: 0;
        pointer-events: none;
      "
      title="打印预览"
    />
  </el-card>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, ElUpload, type UploadInstance } from 'element-plus';
import {
  Delete,
  Document,
  DocumentRemove,
  Download,
  Loading,
  Picture,
  Files,
  Printer,
  Upload,
} from '@element-plus/icons-vue';
import type { UploadFile } from 'element-plus';
import PdfViewer from './PdfViewer.vue';
import ImagePager from './ImagePager.vue';
// 2026-09-20 PR step-viewer-integration：3D 模型内嵌预览组件 + 文件类型判定
//
import { fileTypeToOcctFormat, isOcctSupported } from '@/utils/stepViewerFile';
import { deletePartFile, fetchPartFileContent, getPartFileDownloadUrl } from '@/api/files/objects';
import { usePreviewPolling } from '@/composables/usePreviewPolling';
import { printPartDrawing } from '@/api/parts';
import { useIframePrint } from '@/utils/iframePrint';
import type { PartFileItem, PartFileKind } from '@/types/part_file';

const props = withDefaults(defineProps<Props>(), {
  defaultPage: 1,
  showUpload: false,
  showDelete: false,
  showPrint: false,
  hideHeaderActions: false,
  // 2026-09-17 review 第 2 轮新增：bareMode=true 时整个 header 不渲染。
  // bareMode 优先级：true 时整个 header 不渲染（无论 hideHeaderActions）；
  // hideHeaderActions=true 时只隐藏 header 内的按钮，header 标题与计数
  // tag 仍显示。bareMode 下独立挂一个 hidden el-upload 保证 triggerUpload()
  // 仍可调 input。
  bareMode: false,
  kind: 'DRAWING',
  title: '',
  accept: '',
  emptyText: '',
});

const emit = defineEmits<{
  uploaded: [PartFileItem];
  deleted: [string];
  refresh: [];
}>();

// 2026-10-21 改异步组件：StepViewer 静态 import 会把 three.js（约 495KB）+ occt-wasm 的
// emscripten 胶水（约 108KB）拉进**每一个渲染了本卡片的页面**的静态闭包 —— 实测
// 零件详情 / 装配件详情 / 工序设计 / 大屏四个页面各白带约 600KB，而 3D 预览是低频动作。
// 改成 defineAsyncComponent 后这三块只在用户真的点开一个 STEP/IGES 文件时才下载。
//
// 为什么零感知：模板里 StepViewer 挂在一个 `el-dialog destroy-on-close` 里、且被
// `v-else-if` 门控（见上方 preview 块），即它本来就要等用户点开预览弹窗 + 选到 3D 文件
// 才挂载；异步组件多出来的那一跳就是这段既有等待里的一次额外 chunk 请求，首屏不受影响。
// ⚠️ 本组件没有 defineExpose，父组件不持有它的 template ref ⇒ 异步化不影响任何命令式调用。
// 位置在 defineProps / defineEmits 之后是 eslint 的 `vue/define-macros-order` 要求
// （宏调用必须是 <script setup> 的前几条语句），不是随意摆的。
const StepViewer = defineAsyncComponent(() => import('./cad-viewer/StepViewer.vue'));

// ----- ACCEPT 与 title 按 kind 自动派生 -----
// 2026-07-14：DRAWING 加 9 种图片（PNG/JPG/.../HEIC，与 PDF 同槽）；
// 3D_MODEL 加 IGES/STL/OBJ/3MF；新增 CAD_2D (DWG/DXF)
const ACCEPT_BY_KIND: Record<PartFileKind, string> = {
  DRAWING: '.pdf,.png,.jpg,.jpeg,.gif,.bmp,.tif,.tiff,.webp,.heic',
  '3D_MODEL': '.step,.stp,.iges,.igs,.stl,.obj,.3mf',
  G_CODE: '.nc,.tap,.cnc,.mpf,.ngc',
  SETUP_SHEET: '.pdf',
  ASSEMBLY_MASTER: '.pdf',
  CAD_2D: '.dwg,.dxf',
};

const TITLE_BY_KIND: Record<PartFileKind, string> = {
  DRAWING: '图纸',
  '3D_MODEL': '3D 模型',
  G_CODE: 'G 代码',
  SETUP_SHEET: 'CNC 设定单',
  ASSEMBLY_MASTER: '总装图',
  CAD_2D: 'CAD 源文件',
};

const EMPTY_TEXT_BY_KIND: Record<PartFileKind, string> = {
  DRAWING: '暂无图纸',
  '3D_MODEL': '暂无 3D 模型',
  G_CODE: '暂无 G 代码',
  SETUP_SHEET: '暂无 CNC 设定单',
  ASSEMBLY_MASTER: '暂无总装图',
  CAD_2D: '暂无 CAD 源文件',
};

const UPLOAD_LABEL_BY_KIND: Record<PartFileKind, string> = {
  DRAWING: '图纸',
  '3D_MODEL': '3D 模型',
  G_CODE: 'G 代码',
  SETUP_SHEET: '设定单',
  ASSEMBLY_MASTER: '总装图',
  CAD_2D: 'CAD 源文件',
};

interface Props {
  files: PartFileItem[];
  ownerType: 'assembly' | 'part';
  ownerId: string;
  defaultPage?: number;
  showUpload?: boolean;
  showDelete?: boolean;
  showPrint?: boolean;
  /**
   * 2026-09-17 UI 调整：是否隐藏内层 header 的「打印 / 上传」按钮。
   * PartFilesTabsCard footer 已统一收纳这两类入口，传 true 让 header 只剩
   * 文件数 tag，避免重复按钮。
   */
  hideHeaderActions?: boolean;
  /**
   * 2026-09-17 review 第 2 轮新增：是否完全去掉内层 header 渲染。
   * bareMode=true 时整个 `<template #header>` 块 v-if 不渲染，body 直接
   * 是文件列表；用于 PartFilesTabsCard 这种「外层已包 el-card + header，
   * 内层不要再嵌一层」的嵌入场景。
   * bareMode 下仍需挂载 <el-upload>（display:none）以保证 triggerUpload()
   * 能调底层 input.click()。
   * 优先级：bareMode=true 覆盖 hideHeaderActions（header 整块消失，
   * hideHeaderActions 退化为无意义）；hideHeaderActions=true 时只藏按钮，
   * header 标题与计数 tag 仍显示。
   */
  bareMode?: boolean;
  kind?: PartFileKind;
  title?: string;
  accept?: string;
  emptyText?: string;
  /**
   * 自定义上传函数（不同 kind / 场景走不同 endpoint）。2026-09-16 T3.5：
   * PartDetail 三处挂载走 `usePartFileUpload({ ownerPartId, kind })`。
   * showUpload=true 时未注入会弹错（避免误把旧 multipart 路径暴露出去）。
   */
  apiUpload?: (ownerId: string, file: File) => Promise<PartFileItem>;
  /**
   * 预览 URL（相对路径 `/files/objects/{id}/content`）。默认走 `fetchPartFileContent`
   * 拿 blob；可注入换签名 URL 链路（如私有桶）。
   */
  apiGetPreviewUrl?: (fileId: string) => Promise<string> | string;
  /** 下载 URL（`GET /files/objects/{id}/url` 返回 download_url）。 */
  apiGetDownloadUrl?: (fileId: string) => Promise<string> | string;
  /**
   * 自定义删除函数。默认走 `deletePartFile(fileId, version)`（v2 实际路径 +
   * OCC version 必传）。
   */
  apiDelete?: (fileId: string) => Promise<void>;
}
const ACCEPT = computed<string>(() => props.accept || ACCEPT_BY_KIND[props.kind]);
const titleText = computed<string>(() => props.title || TITLE_BY_KIND[props.kind]);
const emptyTextText = computed<string>(() => props.emptyText || EMPTY_TEXT_BY_KIND[props.kind]);
const uploadLabelText = computed<string>(() => {
  const base = UPLOAD_LABEL_BY_KIND[props.kind];
  return `${files.value.length > 0 ? '替换' : '上传'}${base}`;
});

const uploading = ref(false);
const previewVisible = ref(false);
const previewFile = ref<PartFileItem | null>(null);
const previewBlobUrl = ref<string>('');
const files = computed<PartFileItem[]>(() => props.files);
// 2026-10-13：用户在图片模式下点「查看原始 PDF」。PDF 模式少矢量缩放与文字选中，
// 看细节时必须能退回原始 PDF —— 它与「转图降级自动兜底」合并成同一条 blob 路径。
const showOriginalPdf = ref(false);

/**
 * PDF 图纸的 CI 转图轮询（2026-10-13）。
 *   - fileId：只有 PDF 才有转图；图片 / 3D / G 代码传空串 ⇒ 零请求。
 *   - enabled：预览弹窗关着时不轮询（否则关掉后还在后台转图占队列）。
 */
const preview = usePreviewPolling({
  fileId: () =>
    previewFile.value && isPdf(previewFile.value.file_type) ? previewFile.value.id : '',
  enabled: () => previewVisible.value,
});

/**
 * 当前该显示哪条路（2026-10-13）。
 *
 * ⚠️ `showImageMode` 必须同时看 `!wantsOriginalPdf`，不能只看 `preview.ready`：
 * 转图 ready 之后 `ready` 就一直是 true，只用它做分支条件的话，「查看原始 PDF」按钮
 * 会变成**空操作** —— 点击确实触发了 blob 拉取，但模板仍停在图片模式分支上，用户
 * 看不到任何变化，逃生口形同虚设。
 */
const wantsOriginalPdf = computed<boolean>(() => showOriginalPdf.value || preview.degraded.value);
const showImageMode = computed<boolean>(
  () => isPdfType(previewFile.value) && preview.ready.value && !wantsOriginalPdf.value,
);

const previewTitle = computed<string>(() => `预览 — ${previewFile.value?.original_filename ?? ''}`);

/** 当前选中的是不是一份 PDF（决定走「转图 / 原始 PDF」两条路还是其它分支）。 */
function isPdfType(f: PartFileItem | null): boolean {
  return f !== null && isPdf(f.file_type);
}

// 2026-09-20 PR step-viewer-integration：StepViewer fullscreen 高度。
// el-dialog fullscreen 时 body padding ~16px + header ~56px → 大致留 calc(100vh - 80px)
// 让 3D canvas 撑满。StepViewer 内部 .step-viewer-host 用 v-bind(hostHeight) 直接生效。
const stepViewerHeight = computed<string>(() => 'calc(100vh - 80px)');

// 2026-09-20：把 previewFile.file_type 映射成 occt-wasm 期望的 format（用于 StepViewer
// props.format —— blob URL 场景下无法自动探测）。
const stepFormat = computed<'step' | 'stl' | 'brep' | undefined>(() => {
  if (!previewFile.value) return undefined;
  return fileTypeToOcctFormat(previewFile.value.file_type) ?? undefined;
});

function onStepError(msg: string): void {
  ElMessage.error(msg);
}

// 2026-09-16：file_type 为 undefined/null/'' 时所有 toUpperCase 工具函数直接炸，
// 入口加空守卫避免在 reactivity 重渲染期炸 TypeError
function isPdf(t: string): boolean {
  if (!t) return false;
  return t.toUpperCase() === 'PDF';
}
// 2026-07-14：DRAWING 扩 9 种图片格式
const IMAGE_TYPES = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'TIF', 'TIFF', 'WEBP']);
function isImage(t: string): boolean {
  if (!t) return false;
  return IMAGE_TYPES.has(t.toUpperCase());
}
function isHeic(t: string): boolean {
  if (!t) return false;
  return t.toUpperCase() === 'HEIC';
}
function iconOf(t: string) {
  if (!t) return Files; // 兜底通用文件图标
  const up = t.toUpperCase();
  if (up === 'PDF') return Picture;
  if (IMAGE_TYPES.has(up)) return Picture;
  return Files;
}
function iconColor(t: string): string {
  if (!t) return '#909399'; // 兜底灰色
  const up = t.toUpperCase();
  if (up === 'PDF') return '#e15c5c';
  if (IMAGE_TYPES.has(up)) return '#67c23a'; // 图片：绿色
  if (up === 'STEP' || up === 'STP' || up === 'IGES' || up === 'IGS') return '#3a7bd5';
  if (up === 'STL' || up === 'OBJ' || up === '3MF') return '#3a7bd5';
  if (up === 'DWG' || up === 'DXF') return '#ff9800';
  return '#909399';
}
// 2026-09-16：v2 file_size 为 string（i64 雪花序列化器），入参兼容 string | number
function formatSize(v: string | number): string {
  const n = Number(v);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// 2026-09-17 UI 调整：父级（PartFilesTabsCard）footer 「上传 / 打印」按钮通过
// ref 调本方法触发文件选择；走 el-upload 内部 input[type=file].click() 复用
// 现有 onPick 路径，避免在两个地方维护上传签名。
// 2026-09-21 对齐 TS 严格：模板 ref 收紧为 EP UploadInstance；null 初值（uploadRef?.$el 访问走 ? 链）
const uploadRef = ref<UploadInstance | null>(null);
function triggerUpload(): void {
  const root = uploadRef.value?.$el;
  if (!root) {
    ElMessage.error('上传控件未挂载，请刷新页面后重试');
    return;
  }
  const input = root.querySelector('input[type=file]');
  if (input) input.click();
  else ElMessage.error('未找到文件选择控件');
}

async function onPick(uploadFile: UploadFile): Promise<void> {
  if (!uploadFile.raw) return;
  if (!props.apiUpload) {
    ElMessage.error('FileListCard 未配置 apiUpload，无法上传');
    return;
  }
  uploading.value = true;
  try {
    const result = await props.apiUpload(props.ownerId, uploadFile.raw);
    ElMessage.success(`已上传：${result.original_filename}`);
    emit('uploaded', result);
    emit('refresh');
  } catch (e) {
    ElMessage.error((e as Error).message ?? '上传失败');
  } finally {
    uploading.value = false;
  }
}

async function onPreview(f: PartFileItem): Promise<void> {
  previewFile.value = f;
  previewVisible.value = true;
  showOriginalPdf.value = false;
  // PDF 不在这里拉 blob —— 先走转图；用户点「查看原始 PDF」或转图降级时再拉
  // （见下方 watch）。提前拉会让「图片模式省带宽」这件事当场作废。
  if (isPdf(f.file_type)) return;
  try {
    // 2026-09-16 T3.5：v2 实际路径走 /files/objects/{id}/content；
    // 优先级 props.apiGetPreviewUrl > 默认 fetchPartFileContent。
    const blob = props.apiGetPreviewUrl
      ? await fetchPreviewBlob(f.id, props.apiGetPreviewUrl)
      : await fetchPartFileContent(f.id);
    // 迟到守卫：期间用户可能已经关掉弹窗或换文件（图片 / 3D 这条路径同样要判，
    // 否则关窗后到达的 blob 会顶掉 `onPreviewClosed` 已经清空的值，而它再没人 revoke）。
    if (!previewVisible.value) return;
    if (previewFile.value?.id !== f.id) return;
    if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
    previewBlobUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '加载文件失败');
  }
}

/**
 * PDF 的原始 PDF 路径有两条触发：用户点「查看原始 PDF」，或转图轮询降级。
 * 二者合并成一条 watch —— 降级那一刻页面上的表现与用户主动切换完全一致，
 * 不给降级单开一条代码路径，免得两条路径哪天改出行为差。
 */
watch(
  [() => previewFile.value, wantsOriginalPdf],
  async ([f, wantOriginal]) => {
    if (!f || !isPdf(f.file_type)) return;
    if (!wantOriginal) return;
    try {
      const blob = props.apiGetPreviewUrl
        ? await fetchPreviewBlob(f.id, props.apiGetPreviewUrl)
        : await fetchPartFileContent(f.id);
      // 迟到守卫：期间用户可能已经关掉弹窗或换文件。
      // ⚠️ 必须**同时**判「文件还是同一个」与「弹窗还开着」：本组件关窗时不清
      // `previewFile`（列表还要靠它标高亮），只比 id 的话恒成立 —— 关窗后到达的
      // blob 会被写进 `previewBlobUrl`，而 `onPreviewClosed` 已经 revoke 过手上那一个
      // ⇒ 没人再 revoke 它，一次泄漏。
      if (!previewVisible.value) return;
      if (previewFile.value?.id !== f.id) return;
      if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
      previewBlobUrl.value = URL.createObjectURL(blob);
    } catch (e) {
      ElMessage.error((e as Error).message ?? '加载原始 PDF 失败');
    }
  },
  { immediate: true },
);

/**
 * 把 caller 注入的 apiGetPreviewUrl 返回值（URL 字符串）走 `api` 实例 GET 拉 blob。
 *
 * caller 必传 URL 字符串（类型契约 `(fileId) => Promise<string> | string`），
 * 不支持直接返回 blob —— 直接返回 blob 的 caller 应该在调用前自己拉好，再传 URL。
 * 这里只走 URL 拉 blob 一条路径，保持类型契约简单。
 */
async function fetchPreviewBlob(
  fileId: string,
  apiGetPreviewUrl: (id: string) => Promise<string> | string,
): Promise<Blob> {
  const url = await apiGetPreviewUrl(fileId);
  // URL 字符串 → axios 直接 GET（带 api 实例鉴权拦截器 + baseURL 拼接）
  const { api } = await import('@/api/http');
  const resp = await api.get<Blob>(url, { responseType: 'blob' });
  return resp.data;
}

function onPreviewClosed(): void {
  if (previewBlobUrl.value) {
    URL.revokeObjectURL(previewBlobUrl.value);
    previewBlobUrl.value = '';
  }
  showOriginalPdf.value = false;
  preview.stop();
}

// 2026-10-22 补：组件卸载时的**兜底**释放。`@closed` 只救得了「用户正常关窗」，用户
// 直接把宿主页的标签页关掉时那个事件永远不来 ⇒ object URL 悬空、那份 PDF / 图纸的
// 字节留在内存里（关掉整页也救不了它）。与另几个预览承载点同款，登记表见
// `keepAliveContract.spec.ts` 的「blob URL 必须有卸载兜底」一组。
// ⚠️ 这条与 keep-alive 无关：页面被缓存时 `onBeforeUnmount` 根本不触发，但那时弹窗也
// 还开着、URL 仍被本组件持有 ⇒ 仍是可达的，不构成泄漏。
onBeforeUnmount(() => {
  if (previewBlobUrl.value) {
    URL.revokeObjectURL(previewBlobUrl.value);
    previewBlobUrl.value = '';
  }
  preview.stop();
});

async function downloadCurrent(): Promise<void> {
  if (!previewFile.value) return;
  try {
    // 2026-09-16 T3.5：默认走 v2 /files/objects/{id}/url，签名由 props 覆盖
    const url = props.apiGetDownloadUrl
      ? await props.apiGetDownloadUrl(previewFile.value.id)
      : await getPartFileDownloadUrl(previewFile.value.id);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '下载失败');
  }
}

async function onDelete(f: PartFileItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除「${f.original_filename}」？删除后文件仍可从 COS 重新下载，但前端不再列出。`,
      '删除文件',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    if (props.apiDelete) {
      await props.apiDelete(f.id);
    } else {
      // 2026-09-16 T3.5：v2 软删强制 OCC body { version }，传行内乐观锁版本号
      await deletePartFile(f.id, f.version);
    }
    ElMessage.success('已删除');
    emit('deleted', f.id);
    emit('refresh');
  } catch (e) {
    ElMessage.error((e as Error).message ?? '删除失败');
  }
}

// ============================================================
// 单件图纸打印：blob URL + 隐藏 iframe 交给 src/utils/iframePrint.ts
// ============================================================
// 2026-10-22：原实现是本仓这套「隐藏 iframe 打印」的**源头**（零件一览的批量打印
// 是照它抄的），两处原本是逐字同款代码、且都漏了同一件事：`iframe.onload` 永不解绑，
// 而 blob URL 只在 `onBeforeUnmount` 里 revoke。本组件的 iframe 在 el-dialog **之外**
// 内联于卡片，随宿主页（零件详情 / 装配件详情，路由名都等于文件名 ⇒ 两页都在
// keep-alive 缓存名单里）一起被 `move()` 进游离容器 ⇒ 切页回来时 iframe 重新加载
// `src` ⇒ 打印窗口自己又弹一次。根因与四道闸的判据见 iframePrint.ts 文件头。
const printing = ref(false);
const printIframeRef = ref<HTMLIFrameElement | null>(null);
const { printBlob } = useIframePrint(printIframeRef);

async function onPrint(): Promise<void> {
  if (props.ownerType !== 'part') return;
  printing.value = true;
  try {
    const blob = await printPartDrawing(props.ownerId);
    // 「iframe 未挂载」的报错由 printBlob 自己发，失败时返回 false，无需调用方分支。
    printBlob(blob);
  } catch (e) {
    ElMessage.error((e as Error).message ?? '生成打印 PDF 失败');
  } finally {
    setTimeout(() => {
      printing.value = false;
    }, 800);
  }
}

// 2026-09-17 UI 调整：暴露 print / triggerUpload 给父级（PartFilesTabsCard）
// footer 按钮调用，把「打印图纸 / 上传」入口收敛到外层 footer。
// 同时把 uploading / printing 两个 loading ref 也暴露出去 —— 父级 footer
// 按钮要展示与内层一致的 loading 状态，避免点击后无反馈。
// getSelectedFileId 留接口位：FileListCard 当前不维护选中态（PartFilesTabsCard
// 持有 selectedFileId），先返回 null 保持 API 对称。
defineExpose({
  print: onPrint,
  triggerUpload,
  uploading,
  printing,
  getSelectedFileId: () => null as string | null,
});
</script>

<style lang="scss" scoped>
.files-card {
  :deep(.el-card__body) {
    padding: 16px 20px;
  }
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-title {
  font-size: 16px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.empty-tip {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: var(--text-secondary);
  gap: 8px;
  p {
    margin: 0;
    font-size: 13px;
  }
}
.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.file-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  position: relative;

  &:hover {
    border-color: var(--primary-color);
    box-shadow: 0 2px 8px rgba(30, 77, 139, 0.08);
  }
  &.is-active {
    border-color: var(--primary-color);
    background: var(--primary-bg);
  }
}
.file-meta {
  flex: 1;
  min-width: 0;
}
.file-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.del-btn {
  flex-shrink: 0;
}
.non-pdf-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px;
}
.image-preview-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 80px);
  padding: 24px;
  background: #1e1e1e;
}
.non-pdf-name {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}
.non-pdf-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
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
.preview-loading {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 15px;
}
</style>
