<!--
  OutsourceQuotePdfPreview.vue — 图纸行内预览对话框（2026-08-25 T13 从 OutsourceQuoteList.vue 抽出）

  纯受控组件：可见性 / url / title / isPdf / loading 全由外部传入。
  - 内部用 el-dialog + PdfViewer / el-image 渲染
  - 不持有 blob URL（caller 持有 blob URL 并在关闭时 revoke）
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
    <div v-if="url" class="drawing-frame-wrap">
      <PdfViewer v-if="isPdf" :url="url" />
      <el-image v-else :src="url" :preview-src-list="[url]" fit="contain" class="drawing-image" />
    </div>
    <p v-else class="muted">无可预览内容</p>
  </el-dialog>
</template>

<script setup lang="ts">
import { useDialogSize } from '@/composables/useDialogSize';

defineProps<{
  modelValue: boolean;
  url: string | null;
  title: string;
  isPdf: boolean;
}>();

defineEmits<{
  (e: 'update:model-value', value: boolean): void;
  (e: 'close'): void;
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
</style>
