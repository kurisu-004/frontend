<!--
  UploadArea.vue —— CosUploader 的拖拽 / 点击上传区（2026-09-28 迁移 / 拆分）

  2026-09-28 新增：原 CosUploader.vue 拆分到 src/components/CosUploader/ 后，
  本组件是 el-upload drag 包装的纯展示壳。组件不持状态、不做校验（校验全
  走父组件的 planPick + emit('pick') 流程）；空态由 FileList 负责。

  设计要点：
  - el-upload :limit 不传（组件侧 planPick 自实现 limit，避开 el-upload
    内部列表泄漏 + limit 永久超限的 P0-1）；
  - :auto-upload="false" + action="#"：组件内自实现完整上传流程，不让
    el-upload 走自带的 action 上传；
  - :show-file-list="false"：文件列表由 FileList 渲染，避开 el-upload
    自带 UI 与本组件 BEM 命名 cos-uploader__* 冲突；
  - el-upload ref 通过 defineExpose 的 clearInternal() 暴露给父组件，
    父组件 onPick 时调用清空 el-upload 内部幽灵列表（P0-1 修复）；
  - on-change 透传：父组件持 onPick 处理函数 / microtask 合批 / planPick
    校验 / refetchGrant，本组件只负责把 el-upload 的 on-change 签名
    (uploadFile, uploadFiles) 透传给父组件。
-->

<template>
  <el-upload
    ref="uploadRef"
    action="#"
    drag
    :multiple="multiple"
    :auto-upload="false"
    :show-file-list="false"
    :accept="accept || undefined"
    :disabled="disabled"
    :on-change="onChange"
  >
    <el-icon class="el-icon--upload"><upload-filled /></el-icon>
    <div class="el-upload__text">拖拽文件到此处，或<em>点击选择</em></div>
    <template v-if="tip || maxSizeMB || accept" #tip>
      <div class="cos-uploader__tip">
        <span v-if="tip">{{ tip }}</span>
        <span v-if="maxSizeMB" class="cos-uploader__size-hint">
          （最大 {{ maxSizeMB }} MB / 文件）
        </span>
        <span v-if="accept" class="cos-uploader__accept-hint"> （仅接受 {{ accept }}） </span>
      </div>
    </template>
  </el-upload>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UploadFilled } from '@element-plus/icons-vue';
import type { UploadFile, UploadFiles, UploadInstance } from 'element-plus';

interface Props {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  tip?: string;
  /** 透传 maxSizeMB 仅用于 tip 文案展示；真实校验由父组件 planPick 完成。 */
  maxSizeMB?: number;
}

withDefaults(defineProps<Props>(), {
  accept: '',
  multiple: true,
  disabled: false,
  tip: '',
  maxSizeMB: undefined,
});

const emit = defineEmits<{
  pick: [uploadFile: UploadFile, uploadFiles: UploadFiles];
}>();

/**
 * 透传 el-upload 的 on-change：父组件 onPick 内部走 microtask 合批 / planPick
 * 校验 / refetchGrant。子组件只负责把签名 (UploadFile, UploadFiles) 原样转发。
 */
function onChange(uploadFile: UploadFile, uploadFiles: UploadFiles): void {
  emit('pick', uploadFile, uploadFiles);
}

const uploadRef = ref<UploadInstance | null>(null);

/**
 * 暴露给父组件：清空 el-upload 内部幽灵列表（P0-1 修复）。
 *
 * 父组件 onPick 拿到 raw 后立即调本方法，确保 el-upload 内部 uploadFiles
 * 不会因每次选择 push 一条而无限增长，导致 :limit 永久超限。
 * clearFiles 仅 filter 内部数组、不回调 onChange（EP 2.x use-handlers.mjs:17-23），
 * 不会触发本函数重入。不用 handleRemove 是因为它会顺带调 onRemove / abort /
 * revokeFileObjectURL 等无关副作用；clearFiles 仅 filter 内部数组，最干净。
 */
defineExpose({
  clearInternal: (): void => {
    void uploadRef.value?.clearFiles();
  },
});
</script>

<style lang="scss" scoped>
.cos-uploader__tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.cos-uploader__size-hint,
.cos-uploader__accept-hint {
  margin-left: 8px;
}
</style>