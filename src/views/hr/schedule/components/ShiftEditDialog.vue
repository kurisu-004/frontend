<!--
  ShiftEditDialog.vue — 班次新增 / 编辑弹窗（**纯组件**，不首调 store）

  2026-10-19 新建。形态照 `views/wecom/webhooks/WeComWebhookDialog.vue`：表单模型从 props 进、
  提交结果从 emit 出，校验与写端点都在 `composables/useScheduleStore.ts` —— 这样单测不必拖
  pinia + vue-query 三件套就能验一个渲染分支，壳（`HrScheduleCalendar.vue`）是唯一接线点。

  ⚠️ **编辑态必带 `version`（OCC 锚）**：store 从**正在编辑那一行**上取。缺 `version` 后端返
  的是 axum 的 **HTTP 422 纯文本**（不是业务信封）—— 连业务码都拿不到，前端只能给一句
  「保存失败」，排查时毫无线索。

  ⚠️ **只读态下五个输入全闸**：将来加「只读查看」入口时不必再逐个补 `:disabled` ——
  当前弹窗只由 `canEdit` 闸住的按钮打开，所以这条在现状下不可达，它是**为入口放开后的
  那一支**预埋的（漏了也不会今天出事，只会在那天变成「只读用户改得动表单」）。

  ⚠️ **表单里的 `null` 只是内部态，不是 wire 语义**：`color` / `remark` 的 `null` 表示
  「这一栏留空」，发往改档端点之前由 store 的 `submitShift` 归一 —— **值没动就不发这个键，
  动了就发 `String(v ?? '')`（清空发空串）**。因为后端 `Option<String>` + `#[serde(default)]`
  **分不清 `null` 与键缺失**，两者都是「这次不改」（口径见 `docs/api/hr.md` §5.4）；发
  `null` 只会让「清空颜色」静默失败而后端仍返 200。

  ⚠️ **保存按钮在跨度超 24:00 时禁用**（V6 的即时反馈）：这条不该靠提交后吃 21908 才发现。
  判据与时间轴顶部那个红色数字同源（`utils/absTime.ts::spanOf`），不在模板里重算。
-->
<template>
  <el-dialog :model-value="modelValue" :title="title" width="760px" @update:model-value="onCancel">
    <el-form label-width="88px" @submit.prevent>
      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="编码" :error="errors.code" required>
            <el-input
              :model-value="form.code"
              placeholder="如 DAY / NIGHT（同一部署内唯一）"
              :maxlength="HR_SHIFT_CODE_MAX"
              :disabled="!canEdit"
              show-word-limit
              @update:model-value="patch({ code: String($event ?? '') })"
            />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="名称" :error="errors.name" required>
            <el-input
              :model-value="form.name"
              placeholder="如 白班"
              :maxlength="HR_SHIFT_NAME_MAX"
              :disabled="!canEdit"
              show-word-limit
              @update:model-value="patch({ name: String($event ?? '') })"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="颜色" :error="errors.color">
            <el-color-picker
              :model-value="form.color"
              :disabled="!canEdit"
              @update:model-value="patch({ color: ($event as string | null) ?? null })"
            />
            <span class="field-hint">留空则用页面默认色；月历里这一格的色带取它</span>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="排序权重" :error="errors.sort_order">
            <el-input-number
              :model-value="form.sort_order"
              :min="0"
              :max="9999"
              :step="1"
              :disabled="!canEdit"
              @update:model-value="patch({ sort_order: Number($event ?? 0) })"
            />
            <span class="field-hint">越小越靠前（班次栏按它排序）</span>
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item label="时段" :error="errors.segments" required>
        <ShiftTimeAxis
          :model-value="form.segments"
          :color="form.color"
          :readonly="!canEdit"
          @update:model-value="patch({ segments: $event })"
        />
      </el-form-item>

      <el-form-item label="备注" :error="errors.remark">
        <el-input
          :model-value="form.remark ?? ''"
          type="textarea"
          :rows="2"
          placeholder="如「含 1 小时午休」"
          :maxlength="HR_SHIFT_REMARK_MAX"
          :disabled="!canEdit"
          show-word-limit
          @update:model-value="patch({ remark: String($event ?? '') || null })"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button type="primary" :loading="loading" :disabled="!canSave" @click="onConfirm">
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/hr/schedule/components/ShiftEditDialog.vue
//
// 2026-10-19 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁与提交都是 emit。

import { computed } from 'vue';
import ShiftTimeAxis from './ShiftTimeAxis.vue';
import {
  HR_SHIFT_CODE_MAX,
  HR_SHIFT_NAME_MAX,
  HR_SHIFT_REMARK_MAX,
  type ShiftFormFieldErrors,
  type ShiftFormModel,
} from '../hrScheduleSchema';
import { MINUTES_PER_DAY, spanOf } from '../utils/absTime';

const props = defineProps<{
  modelValue: boolean;
  mode: 'create' | 'edit';
  form: ShiftFormModel;
  errors: ShiftFormFieldErrors;
  loading: boolean;
  /** 有没有排班管理权限（false = 时间轴只读、不可保存）。 */
  canEdit: boolean;
}>();

// emits 用**函数类型**（交叉）而不是类型字面量：仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红。
const emit = defineEmits<
  ((e: 'update:modelValue', value: boolean) => void) &
    ((e: 'confirm') => void) &
    ((e: 'cancel') => void) &
    ((e: 'patch', value: Partial<ShiftFormModel>) => void)
>();

const title = computed(() => (props.mode === 'create' ? '新建班次' : '编辑班次'));

/** 跨度超 24:00（V6 / 后端 21908）：保存禁用 + 时间轴顶部同步转红。 */
const spanOver = computed(() => spanOf(props.form.segments) > MINUTES_PER_DAY);
const canSave = computed(() => props.canEdit && !spanOver.value);

function patch(value: Partial<ShiftFormModel>): void {
  emit('patch', value);
}

function onCancel(): void {
  emit('cancel');
}

function onConfirm(): void {
  emit('confirm');
}
</script>

<style lang="scss" scoped>
.field-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
