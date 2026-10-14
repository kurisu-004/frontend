<!--
  MailContentSection.vue — 发送内容（节开关 + 天数 + 列白名单 + 标题模板）

  2026-10-13 新建。**纯组件，零 store / 零 api 依赖**。

  四组控件全部由 `GET /meta` 驱动，**不在前端硬编码**：
    - `columns` → 列白名单的候选（邮件表格有哪些列、后端认哪些 key，都以 meta 为准）；
    - `upcomingDaysRange` → 「含未来 N 天」的天数上下限（后端收窄时前端自动跟随）。

  两条交互约定：
    - 关掉「含未来 N 天」时 `upcoming_days` 输入项**禁用但不清值**：清值会让用户
      「关 → 开」之后发现天数丢了；留着它对后端无影响（该开关关着时天数不参与渲染）。
    - `subject_template` 留空 = 用后端默认标题（提交时转 `null`，见 store 的
      `buildRunPayload`），所以这里不做「必填」标红。
-->
<template>
  <div class="mail-content">
    <div class="field-row">
      <span class="field-label">包含逾期</span>
      <el-switch
        :model-value="modelValue.include_overdue"
        aria-label="包含逾期"
        @update:model-value="patch({ include_overdue: Boolean($event) })"
      />
      <span class="field-hint">交期早于今天且未交付的工单</span>
    </div>

    <div :class="['field-row', rowClass('upcoming_days')]">
      <span class="field-label">含未来 N 天</span>
      <el-switch
        :model-value="modelValue.include_upcoming"
        aria-label="含未来 N 天"
        @update:model-value="onIncludeUpcomingChange"
      />
      <el-input-number
        :model-value="modelValue.upcoming_days"
        class="days-input"
        :min="upcomingDaysRange.min"
        :max="upcomingDaysRange.max"
        :step="1"
        :precision="0"
        controls-position="right"
        :disabled="!modelValue.include_upcoming"
        :placeholder="`${upcomingDaysRange.min}..${upcomingDaysRange.max}`"
        @update:model-value="onUpcomingDaysChange"
      />
      <span class="field-hint">
        {{ upcomingDaysRange.min }}..{{ upcomingDaysRange.max }} 天内到期的工单
      </span>
      <span v-if="errors?.upcoming_days" class="field-error">{{ errors.upcoming_days }}</span>
    </div>

    <div :class="['field-row', 'field-row--block', rowClass('visible_columns')]">
      <span class="field-label">表格列</span>
      <div class="columns-body">
        <el-checkbox-group
          :model-value="modelValue.visible_columns"
          class="columns-group"
          aria-label="表格列白名单"
          @update:model-value="patch({ visible_columns: toStringArray($event) })"
        >
          <el-checkbox v-for="c in columns" :key="c.key" :value="c.key">
            {{ c.label }}
          </el-checkbox>
        </el-checkbox-group>
        <span v-if="columns.length === 0" class="field-hint">
          暂无列候选（`GET /cron/mail-digest/meta` 未返回或返回空列表）
        </span>
        <span v-if="errors?.visible_columns" class="field-error">
          {{ errors.visible_columns }}
        </span>
      </div>
    </div>

    <div :class="['field-row', rowClass('subject_template')]">
      <span class="field-label">标题模板</span>
      <el-input
        :model-value="modelValue.subject_template"
        class="subject-input"
        maxlength="200"
        placeholder="留空则用后端默认标题（如「交期汇总 2026-10-13」）"
        @update:model-value="patch({ subject_template: String($event ?? '') })"
      />
      <span v-if="errors?.subject_template" class="field-error">
        {{ errors.subject_template }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
// views/mail/digest/components/MailContentSection.vue
//
// 2026-10-13 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁是 emit。

import type {
  MailDigestColumnOptionData,
  MailDigestFormField,
  MailDigestFormFieldErrors,
  MailDigestFormModel,
} from '../mailDigestSchema';

const props = withDefaults(
  defineProps<{
    modelValue: MailDigestFormModel;
    /** 列白名单候选（`GET /meta` 的 `columns[]`）。 */
    columns: readonly MailDigestColumnOptionData[];
    /** 「未来 N 天」的取值范围（`GET /meta` 的 `upcoming_days_range`）。 */
    upcomingDaysRange: { min: number; max: number };
    errors?: MailDigestFormFieldErrors;
    focusField?: MailDigestFormField | null;
  }>(),
  {
    columns: () => [],
    upcomingDaysRange: () => ({ min: 1, max: 60 }),
  },
);

// emits 用**函数类型**而不是 `{ (e, v): void }` 的类型字面量（仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红；两者语义等价，Vue 3.3+ 均支持）。
const emit = defineEmits<(e: 'update:modelValue', value: MailDigestFormModel) => void>();

function patch(patchValue: Partial<MailDigestFormModel>): void {
  emit('update:modelValue', { ...props.modelValue, ...patchValue });
}

function onIncludeUpcomingChange(v: unknown): void {
  // 只切开关、不动天数：清值会让「关 → 开」之后用户发现天数没了（见文件头）。
  patch({ include_upcoming: Boolean(v) });
}

function onUpcomingDaysChange(v: unknown): void {
  // el-input-number 清空给出 undefined/null；原样传给表单态，由 schema 的
  // requiredInt（空值 → NaN）判错，不在这里兜成 0。
  // ⚠️ 2026-10-14（N-1）：报错文案里的范围取自 `upcomingDaysRange`（meta 驱动），
  // 与本组件 `:min/:max` 同一个来源 —— 范围只有一处真源，见 `makeMailDigestFormSchema`。
  patch({ upcoming_days: v === '' ? undefined : (v as number | undefined) });
}

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
.mail-content {
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

.field-row--block {
  align-items: flex-start;
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
  padding-top: 6px;
  font-size: 14px;
  color: var(--text-secondary);
}

.days-input {
  width: 140px;
}

.columns-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.columns-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.subject-input {
  width: 420px;
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.field-error {
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
