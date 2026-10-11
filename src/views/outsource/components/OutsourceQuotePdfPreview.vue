<!--
  OutsourceQuotePdfPreview.vue — 图纸行内预览对话框（2026-08-25 T13 从 OutsourceQuoteList.vue 抽出）

  纯受控组件：可见性 / url / title / isPdf / loading 全由外部传入。
  - 内部用 el-dialog + PdfViewer / el-image 渲染
  - 不持有 blob URL（caller 持有 blob URL 并在关闭时 revoke）

  2026-10-13：PDF 走**两条**路径（props 三元化，见下）
    - `pages` 非空 ⇒ 图片模式（caller 从 `GET /files/objects/{id}/preview` 拿到 CI 转好的
      逐页图片直链）→ `<ImagePager>`，浏览器不下载整份 PDF；
    - 否则 ⇒ 原始 PDF 模式，`url`（blob）喂 PdfViewer。两条触发：caller 的转图降级
      自动兜底，或用户点「查看原始 PDF」（图片模式少矢量缩放与文字选中，看细节要能退回）。
  `degradeHint` 是 caller 给的降级原因文案，在两条路里都渲染 —— 静默换渲染路径会让
  CI 故障无人察觉。

  ⚠️ 转图等待期不是「无可预览内容」：`pages` 空 + `url` 空 + caller 的转图/拉 blob 在
  进行中（`busyHint`）时，文案必须是 caller 给的提示。落进 `v-else` 的「无可预览内容」
  会让工人以为这张报价没有图纸，而转图那一档最长要等 2 分钟（转图轮询的墙钟上限）。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    :width="dialogSize.width"
    :top="dialogSize.top"
    :close-on-click-modal="false"
    :destroy-on-close="true"
    append-to-body
    @update:model-value="(v: boolean) => $emit('update:model-value', v)"
    @close="$emit('close')"
  >
    <div v-if="degradeHint" class="degrade-hint">{{ degradeHint }}</div>
    <div v-if="pages.length" class="drawing-image-mode">
      <ImagePager :pages="pages" />
      <el-button class="original-btn" plain @click="$emit('viewOriginal')">
        <el-icon><Document /></el-icon>
        <span>查看原始 PDF</span>
      </el-button>
    </div>
    <div v-else-if="url" class="drawing-frame-wrap">
      <PdfViewer v-if="isPdf" :url="url" />
      <el-image v-else :src="url" :preview-src-list="[url]" fit="contain" class="drawing-image" />
    </div>
    <!-- 转图等待期 / 原始 PDF 拉取期：都还没有可渲染的东西，但那不是「没有可预览内容」。
         高度与上面两条分支同款（70vh），避免文案在画面中央跳一下。 -->
    <div v-else-if="busyHint" class="drawing-frame-wrap busy-frame">
      <span class="busy-hint">{{ busyHint }}</span>
    </div>
    <p v-else class="muted">无可预览内容</p>
  </el-dialog>
</template>

<script setup lang="ts">
import { Document } from '@element-plus/icons-vue';
import PdfViewer from '@/components/PdfViewer.vue';
import ImagePager from '@/components/ImagePager.vue';
import { useDialogSize } from '@/composables/useDialogSize';

withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 原始 PDF / 图片的 blob URL（图片模式下不传，由 caller 惰性拉）。 */
    url: string | null;
    title: string;
    isPdf: boolean;
    /** CI 转好的逐页图片直链；空数组 ⇒ 走原始 PDF 模式。 */
    pages?: string[];
    /** 转图降级原因（人类可读）；非空即渲染成一行提示。 */
    degradeHint?: string | null;
    /**
     * 「有东西在路上」的提示文案（如 `图纸转图中…` / `加载原始 PDF…`）；null ⇒ 真的
     * 没有可预览内容。**由 caller 给**而不是这里自己推：本组件是纯受控的，它不知道
     * caller 的轮询处于哪一档，把两个阶段的文案判据留在 caller 一处更好维护。
     */
    busyHint?: string | null;
  }>(),
  {
    // 缺省给空数组而不是 optional：模板里 `pages.length` 就不必到处判空，
    // 而「没传」与「传了空数组」在本组件的语义里是同一件事（走原始 PDF 模式）。
    pages: () => [],
    degradeHint: null,
    busyHint: null,
  },
);

defineEmits<{
  (e: 'update:model-value', value: boolean): void;
  /** `close`：弹窗关闭（caller 在此 revoke blob）。`viewOriginal`：图片模式下点
   *  「查看原始 PDF」⇒ caller 拉 blob 并切回原始 PDF 模式。 */
  (e: 'close' | 'viewOriginal'): void;
}>();

const dialogSize = useDialogSize({ desktopWidth: 900 });
</script>

<style lang="scss" scoped>
// 2026-10-03 修缺陷：预览画面全白。本弹窗非 fullscreen，父容器是 .el-dialog__body
// （display:block + height:auto），原来的 height:100% 落空 → PdfViewer 的 flex 高度链
// 塌成 0，canvas 被 .pdf-viewport 的 overflow:hidden 裁掉。
// 改法：自己给确定高度（弹窗 top 15vh + header/padding 后留出余量，取 70vh；
// min-height 兜底窄视口下不被压没），并转 column —— row 方向下 PdfViewer 的
// flex: 1 1 auto 撑的是宽度不是高度。
//
// column 方向下 align-items / justify-content 的轴与 row 时相反，这里按新语义取值：
//   - align-items 管交叉轴（水平）→ 必须 stretch。PdfViewer 自身没有显式宽度，只有被
//     stretch 才能拿到内容区整宽（900px 弹窗实测 868px）；写成 center 会退化成内容宽
//     （实测 518px），A4 图纸在 scale 1 下画布宽 595px，塞进去左右共被裁 77px
//     （Letter 更宽，裁得更多），不缩放看不到完整图幅。
//   - justify-content 管主轴（垂直）→ 保留 center。PdfViewer 撑满主轴不受影响，
//     图片分支则继续在 70vh 里垂直居中。
//   - 图片分支要的是「按自身尺寸水平居中」，不能跟着 stretch 一起变宽，用
//     .drawing-image 上的 align-self 单独豁免。
.drawing-frame-wrap {
  width: 100%;
  height: 70vh;
  min-height: 280px;
  overflow: hidden;
  background: #f5f7fa;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
}
.drawing-image {
  align-self: center;
  max-width: 100%;
  max-height: 70vh;
}
.muted {
  color: var(--text-secondary);
}

/* 2026-10-13：图片模式容器，与 .drawing-frame-wrap 同款（70vh + column），
   高度来源同样是自己给而不是靠 dialog body。 */
.drawing-image-mode {
  width: 100%;
  height: 70vh;
  min-height: 280px;
  overflow: hidden;
  background: #f5f7fa;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
/* 转图等待期容器：与上面两条分支同尺寸，只放一行文案（沿用 .drawing-frame-wrap 的
   column + center，ImagePager 那份的 justify-content 不适用这里）。 */
.busy-frame {
  align-items: center;
}
.busy-hint {
  color: var(--text-secondary);
  font-size: 14px;
}
.original-btn {
  align-self: center;
  flex-shrink: 0;
}
/* 降级提示：有告知的兜底，不是静默换渲染路径。占位小、不抢画面。 */
.degrade-hint {
  margin-bottom: 8px;
  font-size: 12px;
  color: #e6a23c;
  text-align: center;
}
</style>
