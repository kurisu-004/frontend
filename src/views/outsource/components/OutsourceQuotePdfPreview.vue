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
      <PdfViewer
        v-if="isPdf"
        :url="url"
      />
      <el-image
        v-else
        :src="url"
        :preview-src-list="[url]"
        fit="contain"
        class="drawing-image"
      />
    </div>
    <p v-else class="muted">无可预览内容</p>
  </el-dialog>
</template>

<script setup lang="ts">
import { useDialogSize } from '@/composables/useDialogSize'

defineProps<{
  modelValue: boolean
  url: string | null
  title: string
  isPdf: boolean
}>()

defineEmits<{
  (e: 'update:model-value', value: boolean): void
  (e: 'close'): void
}>()

const dialogSize = useDialogSize({ desktopWidth: 900 })
</script>

<style lang="scss" scoped>
.drawing-frame-wrap {
  width: 100%;
  height: 100%;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
}
.drawing-image {
  max-width: 100%;
  max-height: 70vh;
}
.muted {
  color: var(--text-secondary);
}
</style>