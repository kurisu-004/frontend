<!--
  MailRecipientsSection.vue — 收件人（TO）与抄送（CC）

  2026-10-13 新建。**纯组件，零 store / 零 api 依赖**。

  两个 `el-select` 都是 `multiple` + `filterable` + `allow-create`：
    - `multiple` → 多个收件人；
    - `filterable` → 已填的地址多时能筛；
    - `allow-create` → **后端没有「联系人目录」端点**，收件人只能现填。`allow-create`
      让用户直接敲一个不在候选里的新地址（EP 会把它作为标签收下）。没有候选列表，
      所以不传 `el-option`（EP 对 `allow-create` 的空候选天然支持手输）。

  校验不在本组件：邮箱格式与「至少一个 TO」由 `mailDigestSchema.ts::makeMailDigestFormSchema`
  统一管（保存 / 预览 / 立即发送三个动作共用一份，见 store 的 `validateForm`），
  本组件只负责把 store 算好的字段红字显示出来。
-->
<template>
  <div class="mail-recipients">
    <div :class="['field-row', rowClass('recipients')]">
      <span class="field-label">收件人（TO）</span>
      <el-select
        :model-value="modelValue.recipients"
        class="recipient-select"
        multiple
        filterable
        allow-create
        default-first-option
        clearable
        :multiple-limit="20"
        placeholder="输入邮箱后回车，可填多个"
        aria-label="收件人"
        @update:model-value="patch({ recipients: toStringArray($event) })"
      />
      <span class="field-hint">至少 1 个</span>
      <span v-if="errors?.recipients" class="field-error">{{ errors.recipients }}</span>
    </div>

    <div :class="['field-row', rowClass('cc_recipients')]">
      <span class="field-label">抄送（CC）</span>
      <el-select
        :model-value="modelValue.cc_recipients"
        class="recipient-select"
        multiple
        filterable
        allow-create
        default-first-option
        clearable
        :multiple-limit="20"
        placeholder="可留空"
        aria-label="抄送"
        @update:model-value="patch({ cc_recipients: toStringArray($event) })"
      />
      <span v-if="errors?.cc_recipients" class="field-error">{{ errors.cc_recipients }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// views/mail/digest/components/MailRecipientsSection.vue
//
// 2026-10-13 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁是 emit。

import type {
  MailDigestFormField,
  MailDigestFormFieldErrors,
  MailDigestFormModel,
} from '../mailDigestSchema';

const props = defineProps<{
  modelValue: MailDigestFormModel;
  errors?: MailDigestFormFieldErrors;
  focusField?: MailDigestFormField | null;
}>();

// emits 用**函数类型**而不是 `{ (e, v): void }` 的类型字面量（仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红；两者语义等价，Vue 3.3+ 均支持）。
const emit = defineEmits<(e: 'update:modelValue', value: MailDigestFormModel) => void>();

function patch(patchValue: Partial<MailDigestFormModel>): void {
  emit('update:modelValue', { ...props.modelValue, ...patchValue });
}

/** el-select multiple 的 modelValue 是数组；EP 允许 clearable 把它清成 `[]`
 *  （而非 null），这里仍做一次归一，避免 `null` 顺着 patch 写进表单态。 */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => String(item));
}

function rowClass(field: MailDigestFormField): Record<string, boolean> {
  return {
    'is-error': !!props.errors?.[field],
    'is-focus': props.focusField === field,
  };
}
</script>

<style lang="scss" scoped>
.mail-recipients {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
}

.field-row.is-error {
  border-color: var(--el-color-danger-light-7);
}

.field-row.is-focus {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}

.field-label {
  width: 96px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.recipient-select {
  flex: 1;
  min-width: 320px;
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
