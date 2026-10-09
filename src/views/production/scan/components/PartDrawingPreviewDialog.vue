<!--
  PartDrawingPreviewDialog.vue

  报工台列表行的**图纸预览弹窗**（唯一实现，2026-10-11 从 ScanPickParts /
  ScanReturnParts / ScanInspectParts 三页抽出）：三页此前连 `onPreview` 一起是逐字
  三份复制（取 DRAWING 文件列表 → 取 `files[0]` → PDF/图片走 blob URL → 自增
  `previewToken` 防竞态 → 关闭时 revoke），抽出来之后「预览一个零件」只有这一处实现。

  弹窗形态是**窗口**（不是全屏）：HMI 上工人要点着看图，窗口形态看得见页面其余部分，
  关掉也不用重新走一遍选件。窗口形态下的高度契约见 `src/styles/index.scss` 的
  `.pdf-preview-dialog.el-dialog:not(.is-fullscreen)` 规则与 `PdfViewer.vue` 文件头。

  四个分支（加载中 / PDF / 图片 / 非 PDF）+ `canDownload` 闸门 + `nonPdfHint` 文案 +
  `downloadPreview` 全在本组件内：它们是「预览一张图纸」这一件事的完整口径，拆开就会
  出现「有的页面有下载按钮、有的没有」。

  ⚠️ **`append-to-body`**：报工台三页的根是 `position: fixed; inset: 0` 的整屏容器，
  弹窗不脱离它就会被页面自己的堆叠上下文裁住。

  数据流全部是**单次拉取**（不开 query）：一次预览只请求一次文件列表 + 至多一次
  内容 blob，不参与列表的失效链；`previewToken` 是这条链上唯一的并发控制 —— 连续快速
  点两张卡时，前一次的响应回来必须被丢弃，否则会把 A 的文件挂到 B 的弹窗里。
-->

<template>
  <el-dialog
    v-model="visible"
    class="pdf-preview-dialog"
    :title="title"
    :width="dialogSize.width"
    :top="DIALOG_TOP"
    append-to-body
    :close-on-click-modal="false"
    destroy-on-close
    @closed="onClosed"
  >
    <div v-if="previewLoading" class="preview-loading">
      <el-icon :size="32" class="is-loading"><Loading /></el-icon>
      <span>加载图纸中…</span>
    </div>

    <PdfViewer v-else-if="previewFile && isPdf(previewFile.file_type)" :url="previewBlobUrl" />

    <div v-else-if="previewFile && isImage(previewFile.file_type)" class="image-preview-wrap">
      <el-image
        :src="previewBlobUrl"
        :preview-src-list="[previewBlobUrl]"
        :initial-index="0"
        fit="contain"
        class="image-preview-img"
      />
    </div>

    <div v-else class="non-pdf-preview">
      <el-icon :size="48" color="#909399"><Files /></el-icon>
      <p class="non-pdf-name">{{ previewFile?.original_filename || '该零件暂无图纸' }}</p>
      <p class="non-pdf-hint">{{ nonPdfHint }}</p>
      <el-button v-if="previewFile && canDownload" type="primary" @click="downloadPreview">
        <el-icon><Download /></el-icon><span>下载文件</span>
      </el-button>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Download, Files, Loading } from '@element-plus/icons-vue';
import { api } from '@/api/http';
import PdfViewer from '@/components/PdfViewer.vue';
import { getDownloadUrl, listPartFilesByOwner } from '@/api/assembly';
// 2026-10-11：「下载文件」按钮的角色闸门。后端把 part_file 的列表 / content 对
// SHELF_ACCOUNT 放开了（工控机预览图纸打的就是这两条），但 `/part-files/{id}/url`
// **刻意没放开**（COS 预签直链可外传）⇒ 不挂闸门就是「可见但必 403」。判据在
// utils/partsPermissions，与后端 require_any_role 白名单同集合。
import { usePermissions } from '@/composables/usePermissions';
import { canDownloadPartFile } from '@/utils/partsPermissions';
import type { PartFileItem } from '@/types/part_file';
import type { ScanPartRowSchema } from '@/views/production/scan/composables/scanSchema';
import { useDialogSize } from '@/composables/useDialogSize';

const props = defineProps<{
  /** 被预览的那一行列表行（图纸挂在 part 上，取 `row.id`）。 */
  part: ScanPartRowSchema | null;
  /** 弹窗标题（调用方拼「预览 — 序列号」）。 */
  title: string;
}>();

const visible = defineModel<boolean>({ required: true });

// 窗口形态的宽度走本仓既有范式 `useDialogSize`（只给 desktopWidth，EP 的 `.el-dialog`
// 没有水平 margin、宽度是固定的 1100px）：1100px 视口上贴满屏宽（两侧 0 边距），
// 1366px 及以上留 (视口 − 1100) / 2 的对称边距。想要真正窄屏可读就把这个数调小，
// 但别指望它自带边距。
const dialogSize = useDialogSize({ desktopWidth: 1100 });

/**
 * `top` 取 6vh 而不是 `useDialogSize` 的 15vh：窗口形态下 body 的高度是**写死**的
 * （全局规则 `.pdf-preview-dialog.el-dialog:not(.is-fullscreen) > .el-dialog__body`
 * 给 72vh），弹窗总高 ≈ 顶栏 54px + body 72vh + 上下 padding 约 30px
 * = 0.78 × 视口高 + 84px。要让它视觉居中，取 top = (视口高 − 总高) / 2 ≈ 0.11 × 视口高 −
 * 42px；这个式子在窄屏上会变负，改成固定 6vh：1080p 上留 65px / 下留 89px，
 * 800px 屏上留 48px / 下留 44px，两种尺寸都在可接受范围。
 * 15vh 是 body 高度由内容决定时的经验值，与本页写死高度的前提不同。
 */
const DIALOG_TOP = '6vh';

const previewLoading = ref(false);
const previewFile = ref<PartFileItem | null>(null);
const previewBlobUrl = ref<string>('');
// 防竞态：每次开预览自增，老请求响应直接丢弃
let previewToken = 0;

// 卡片上的预览按钮要转圈就得知道「本行正在加载」，而 loading 归本组件管 ⇒ 暴露出去，
// 由调用方与它自己记下的 `part` 一起算出「哪一行在转圈」。
defineExpose({ loading: computed(() => previewLoading.value) });

// --- 类型判定（图片集合与 `FileListCard.vue` 的 `IMAGE_TYPES` 同步） ---
function isPdf(t: string): boolean {
  return t.toUpperCase() === 'PDF';
}
const IMAGE_TYPES = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'BMP', 'TIF', 'TIFF', 'WEBP']);
function isImage(t: string): boolean {
  return IMAGE_TYPES.has(t.toUpperCase());
}

/** 打开即加载。换零件时 `part` 变而 `visible` 仍为 true 的路径也走这里。 */
watch(
  [visible, () => props.part],
  ([open]) => {
    if (open) void loadPreview();
  },
  { immediate: true },
);

async function loadPreview(): Promise<void> {
  const p = props.part;
  if (!p) {
    visible.value = false;
    return;
  }
  previewLoading.value = true;
  const myToken = ++previewToken;
  try {
    // 1. 取该零件的 DRAWING 文件列表（v2 /part-files?owner_id=...&kind=...，owner 多态）
    const files = (await listPartFilesByOwner(String(p.id), 'DRAWING')).items;
    if (myToken !== previewToken) return;
    if (!files.length) {
      ElMessage.warning('暂无图纸');
      visible.value = false;
      return;
    }
    const f = files[0];
    previewFile.value = f;
    // 2. PDF / 图片需要 blob URL；HEIC / STEP / DWG 等直接走下载按钮
    if (isPdf(f.file_type) || isImage(f.file_type)) {
      // v2 无 /files/* 路由，文件内容走 /part-files/{id}/content
      const resp = await api.get(`/part-files/${f.id}/content`, { responseType: 'blob' });
      if (myToken !== previewToken) return;
      if (previewBlobUrl.value) URL.revokeObjectURL(previewBlobUrl.value);
      previewBlobUrl.value = URL.createObjectURL(resp.data);
    }
  } catch (e) {
    if (myToken !== previewToken) return;
    ElMessage.error((e as Error).message ?? '加载图纸失败');
    visible.value = false;
  } finally {
    if (myToken === previewToken) previewLoading.value = false;
  }
}

function onClosed(): void {
  releaseBlobUrl();
  previewFile.value = null;
}

/** blob URL 不 revoke 就是一次泄漏：内容在内存里直到页面卸载，而预览是可反复开的。 */
function releaseBlobUrl(): void {
  if (previewBlobUrl.value) {
    URL.revokeObjectURL(previewBlobUrl.value);
    previewBlobUrl.value = '';
  }
}

onBeforeUnmount(releaseBlobUrl);

// 2026-10-11：下载入口闸门（判据见 utils/partsPermissions 与上面那段 import 注释）。
const { isManager, isClerk, isInspector, isCncProgrammer } = usePermissions();
const canDownload = computed<boolean>(() =>
  canDownloadPartFile({
    MANAGER: isManager.value,
    CLERK: isClerk.value,
    INSPECTOR: isInspector.value,
    CNC_PROGRAMMER: isCncProgrammer.value,
  }),
);

/**
 * 非 PDF 图纸那张卡片的提示文案，与「下载文件」按钮**共用 `canDownload` 闸门**：
 * 拿不到下载入口的角色不能读到一句「请下载后查看」—— 那是指向一个不在屏幕上的
 * 按钮的死胡同。改口成「请联系管理员」是把已知取舍如实讲出来，不是报错兜底。
 */
const nonPdfHint = computed<string>(() => {
  if (!previewFile.value) return '请上传图纸后再预览。';
  return canDownload.value
    ? `${previewFile.value.file_type} 文件不支持浏览器内嵌预览，请下载后查看。`
    : `${previewFile.value.file_type} 文件不支持浏览器内嵌预览，当前账号不支持下载，请联系管理员获取。`;
});

async function downloadPreview(): Promise<void> {
  if (!previewFile.value) return;
  // 与按钮的 v-if 同一道守卫：按钮是 DOM 闸门，函数体是行为闸门 —— 只藏按钮的话，
  // 任何一个仍能触达本函数的地方（控制台、后续新增的快捷键）都会变成「点了必 403」。
  if (!canDownload.value) return;
  try {
    const url = await getDownloadUrl(previewFile.value.id);
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
</script>

<style lang="scss" scoped>
.is-loading {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 2026-10-11：弹窗由全屏改窗口后，四个分支的高度一律跟随新 body（72vh，
   由全局规则 `.pdf-preview-dialog.el-dialog:not(.is-fullscreen)` 给定），
   不再各写一份 `calc(100vh - 80px)` / `60vh` —— 那种写法与 body 高度脱钩，
   改窗口大小时必有一处忘了改。三个分支都是 body 的直接子元素（flex item），
   `flex: 1 + min-height: 0` 才能填满并允许内部滚动。 */
.preview-loading {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #606266;
  font-size: 16px;
}
.image-preview-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 24px;
  background: #1e1e1e;
}
.image-preview-img {
  max-width: 100%;
  max-height: 100%;
}
.non-pdf-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  overflow-y: auto;
  padding: 32px;
}
.non-pdf-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.non-pdf-hint {
  margin: 0;
  color: #606266;
  font-size: 14px;
}
</style>
