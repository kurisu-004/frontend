<!--
  FileList.vue —— CosUploader 的文件列表（2026-09-28 迁移 / 拆分）

  2026-09-28 新增：原 CosUploader.vue 拆出文件列表展示。本组件不持状态、
  不与 useCosUploader 耦合，纯 props in / events out：
  - props.items: CosUploaderItem[] —— 由父组件 useCosUploader.items 提供；
  - props.retryingRefs?: Record<string, boolean> —— 重试按钮 loading 标志；
  - emit('retry', clientRef) / emit('remove', clientRef) —— 让父组件走
    useCosUploader.retryItem / removeItem。

  空态：items 为空时显示占位（emptyText prop + icon）。

  字节数 → 人类可读字符串（formatSize）放本组件，因为只有列表展示用到。
-->

<template>
  <ul v-if="items.length > 0" class="cos-uploader__list">
    <li v-for="it in items" :key="it.client_ref" class="cos-uploader__row">
      <el-icon class="cos-uploader__icon"><document /></el-icon>
      <div class="cos-uploader__meta">
        <div class="cos-uploader__name" :title="it.file.name">
          {{ it.file.name }}
        </div>
        <div class="cos-uploader__sub">
          <span class="cos-uploader__size">{{ formatSize(it.file.size) }}</span>
          <el-tag v-if="it.status === 'hashing'" size="small" type="info" effect="plain"
            >hash 中…</el-tag
          >
          <el-tag v-else-if="it.status === 'uploading'" size="small" effect="plain"
            >上传中</el-tag
          >
          <el-tag v-else-if="it.status === 'done'" size="small" type="success" effect="plain"
            >✓ 已上传</el-tag
          >
          <el-tag v-else-if="it.status === 'error'" size="small" type="danger" effect="plain"
            >失败</el-tag
          >
          <el-tag v-else size="small" effect="plain">待上传</el-tag>
        </div>
        <el-progress
          v-if="it.status === 'hashing' || it.status === 'uploading'"
          :percentage="it.progress"
          :stroke-width="4"
          :show-text="false"
          class="cos-uploader__progress"
        />
        <span
          v-else-if="it.status === 'error'"
          class="cos-uploader__error-msg"
          :title="it.error"
          >{{ it.error }}</span
        >
      </div>
      <div class="cos-uploader__actions">
        <el-button
          v-if="it.status === 'error'"
          link
          type="primary"
          size="small"
          :loading="!!retryingRefs?.[it.client_ref]"
          @click="emit('retry', it.client_ref)"
          >重试</el-button
        >
        <el-button link type="danger" size="small" @click="emit('remove', it.client_ref)"
          >移除</el-button
        >
      </div>
    </li>
  </ul>
  <div v-else class="cos-uploader__empty">
    <el-icon :size="28" color="#c0c4cc"><document-remove /></el-icon>
    <span>{{ emptyText }}</span>
  </div>
</template>

<script setup lang="ts">
import { Document, DocumentRemove } from '@element-plus/icons-vue';
import type { CosUploaderItem } from './types';

interface Props {
  items: CosUploaderItem[];
  /** 重试按钮 loading 标志；key = client_ref，value = boolean。 */
  retryingRefs?: Record<string, boolean>;
  /** 列表为空时的占位文字。 */
  emptyText?: string;
}

withDefaults(defineProps<Props>(), {
  retryingRefs: () => ({}),
  emptyText: '暂无待上传文件',
});

const emit = defineEmits<{
  retry: [clientRef: string];
  remove: [clientRef: string];
}>();

/** 字节数 → 人类可读字符串（B / KB / MB / GB）。 */
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
</script>

<style lang="scss" scoped>
.cos-uploader__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: hidden;
}
.cos-uploader__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  min-height: 60px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    border-bottom: none;
  }
}
.cos-uploader__icon {
  color: var(--el-color-primary);
  font-size: 20px;
}
.cos-uploader__meta {
  min-width: 0;
}
.cos-uploader__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cos-uploader__sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cos-uploader__progress {
  margin-top: 4px;
}
.cos-uploader__error-msg {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cos-uploader__actions {
  display: flex;
  gap: 4px;
}
.cos-uploader__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>