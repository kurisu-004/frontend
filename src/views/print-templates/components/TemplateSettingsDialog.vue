<!--
  模板设置对话框（2026-09-14 新增）：
  - 编辑模板名 / 纸张 / 方向 / 边距。custom 纸张下显示 width/height。
  - 用 v-model:open 控制显示，v-model:template 双向绑定修改后的模板。
  - 父组件负责把 dialog 关闭后是否回写；这里只负责 emit。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus';
import type { Orientation, PaperSize, PrintTemplate } from '@/views/print-templates/types';

const props = defineProps<{
  modelValue: boolean;
  template: PrintTemplate | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  'update:template': [t: PrintTemplate];
}>();

/** 内部草稿：dialog 打开时从 prop 深拷贝，保存时 emit 完整对象。 */
const draft = ref<PrintTemplate | null>(null);
const formRef = ref<FormInstance | null>(null);

watch(
  () => [props.modelValue, props.template] as const,
  ([open]) => {
    if (open && props.template) {
      draft.value = JSON.parse(JSON.stringify(props.template)) as PrintTemplate;
    }
  },
  { immediate: true },
);

const rules: FormRules<PrintTemplate> = {
  name: [{ required: true, message: '模板名不能为空', trigger: 'blur' }],
  customWidthMm: [
    {
      validator(_rule, value, cb): void {
        if (draft.value?.paper !== 'custom') return cb();
        if (!value || value <= 0) return cb(new Error('custom 纸张宽度必须 > 0'));
        cb();
      },
      trigger: 'change',
    },
  ],
  customHeightMm: [
    {
      validator(_rule, value, cb): void {
        if (draft.value?.paper !== 'custom') return cb();
        if (!value || value <= 0) return cb(new Error('custom 纸张高度必须 > 0'));
        cb();
      },
      trigger: 'change',
    },
  ],
};

const paperOptions: Array<{ value: PaperSize; label: string }> = [
  { value: 'A4', label: 'A4 (210×297mm)' },
  { value: 'A5', label: 'A5 (148×210mm)' },
  { value: 'B5', label: 'B5 (176×250mm)' },
  { value: 'custom', label: '自定义' },
];

const orientationOptions: Array<{ value: Orientation; label: string }> = [
  { value: 'portrait', label: '纵向' },
  { value: 'landscape', label: '横向' },
];

const showCustom = computed(() => draft.value?.paper === 'custom');

async function onSave(): Promise<void> {
  if (!draft.value) return;
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    ElMessage.error('请修正表单错误');
    return;
  }
  emit('update:template', JSON.parse(JSON.stringify(draft.value)) as PrintTemplate);
  emit('update:modelValue', false);
  ElMessage.success('已保存模板设置');
}

function onCancel(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="模板设置"
    width="540px"
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <el-form
      v-if="draft"
      ref="formRef"
      :model="draft"
      :rules="rules"
      label-position="top"
      label-width="auto"
    >
      <el-form-item label="模板名" prop="name">
        <el-input
          v-model="draft.name"
          placeholder="例如：送货单标准模板"
          maxlength="60"
          show-word-limit
        />
      </el-form-item>

      <el-form-item label="纸张" prop="paper">
        <el-select v-model="draft.paper" style="width: 220px">
          <el-option v-for="o in paperOptions" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
      </el-form-item>

      <el-form-item v-if="showCustom" label="自定义尺寸 (mm)" prop="customWidthMm">
        <el-space>
          <el-input-number
            v-model="draft.customWidthMm"
            :min="50"
            :max="1000"
            :step="1"
            controls-position="right"
          />
          <span style="line-height: 32px; color: var(--el-text-color-secondary)">×</span>
          <el-input-number
            v-model="draft.customHeightMm"
            :min="50"
            :max="1000"
            :step="1"
            controls-position="right"
          />
        </el-space>
      </el-form-item>

      <el-form-item label="方向" prop="orientation">
        <el-radio-group v-model="draft.orientation">
          <el-radio v-for="o in orientationOptions" :key="o.value" :value="o.value">{{
            o.label
          }}</el-radio>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="边距 (mm)">
        <div class="margin-grid">
          <div class="margin-cell">
            <span class="margin-label">上</span>
            <el-input-number
              v-model="draft.margin.top"
              :min="0"
              :max="50"
              :step="1"
              controls-position="right"
            />
          </div>
          <div class="margin-cell">
            <span class="margin-label">下</span>
            <el-input-number
              v-model="draft.margin.bottom"
              :min="0"
              :max="50"
              :step="1"
              controls-position="right"
            />
          </div>
          <div class="margin-cell">
            <span class="margin-label">左</span>
            <el-input-number
              v-model="draft.margin.left"
              :min="0"
              :max="50"
              :step="1"
              controls-position="right"
            />
          </div>
          <div class="margin-cell">
            <span class="margin-label">右</span>
            <el-input-number
              v-model="draft.margin.right"
              :min="0"
              :max="50"
              :step="1"
              controls-position="right"
            />
          </div>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button type="primary" :disabled="!draft" @click="onSave">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.margin-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  width: 100%;
}
.margin-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.margin-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
