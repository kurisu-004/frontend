<!--
  UploadStatusCellView.vue

  2026-09-16 T3.4 新增：单文件上传进度展示单元（PartBatchPdfTab 行内嵌入用）。

  Props:
    - cell: UploadStatusCell | undefined
      - undefined：本次提交不涉及该文件（或还没开始上传）
      - { status, progress, error }：上传运行时状态
    - label: 标签（'PDF' / '3D' / '主图' 等），用于 row 内区分
    - retryDisabled：「重试」按钮置灰（补传在途时由 caller 驱动；同一个 part + kind
      重复上传会撞后端唯一索引 21108，所以并发重试必须挡住）

  Emits:
    - retry：点击「重试」按钮触发（仅 cell.status === 'error' 时显示）

  状态映射：
    - 'uploading'：空进度条（multipart 无进度回调，progress 恒 0）+ 文字「上传中」
    - 'done'：✓ 绿色文字「上传完成」
    - 'error'：红色文字 + 「重试」按钮
    - 'pending'：灰色「待上传」（已排队、还没跑到该文件）
-->

<template>
  <div v-if="cell" class="upload-status-cell">
    <span class="upload-status-label">{{ label }}</span>
    <template v-if="cell.status === 'uploading'">
      <el-progress :percentage="cell.progress" :stroke-width="6" :show-text="false" />
      <span class="upload-status-text">上传中</span>
    </template>
    <template v-else-if="cell.status === 'done'">
      <el-icon class="upload-status-icon-done"><check /></el-icon>
      <span class="upload-status-text upload-status-text-done">上传完成</span>
    </template>
    <template v-else-if="cell.status === 'error'">
      <span class="upload-status-text upload-status-text-error" :title="cell.error">
        {{ cell.error || '上传失败' }}
      </span>
      <el-button link type="primary" size="small" :disabled="retryDisabled" @click="$emit('retry')"
        >重试</el-button
      >
    </template>
    <template v-else>
      <!-- 'pending'：已排队但还没跑到该文件 -->
      <span class="upload-status-text">待上传</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ElButton, ElProgress } from 'element-plus';
import { Check } from '@element-plus/icons-vue';

/** 与 usePartBatchPdf.UploadStatusCell 同形；这里重写一份以避免 cross-folder import。 */
export interface UploadStatusCell {
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

interface Props {
  cell: UploadStatusCell | undefined;
  label: string;
  /** 「重试」按钮置灰。默认 false（无并发约束的调用方）。 */
  retryDisabled?: boolean;
}

withDefaults(defineProps<Props>(), { retryDisabled: false });

defineEmits<{
  retry: [];
}>();
</script>

<style lang="scss" scoped>
.upload-status-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 12px;
}
.upload-status-label {
  font-weight: 600;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.upload-status-text {
  color: var(--el-text-color-regular);
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upload-status-text-done {
  color: var(--el-color-success);
}
.upload-status-text-error {
  color: var(--el-color-danger);
}
.upload-status-icon-done {
  color: var(--el-color-success);
  font-size: 14px;
}
:deep(.el-progress) {
  width: 100%;
  margin: 2px 0;
}
</style>
