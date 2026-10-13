<!--
  MailAccountDialog.vue — 新增 / 编辑邮箱账号弹窗（**纯组件**，不首调 store）

  2026-10-16 新建。形态照 `views/mail/digest/components/` 的同款取舍：表单模型从
  props 进、提交结果从 emit 出，校验在 store 里（`useMailAccountsStore::submit`）——
  这样单测不必拖 pinia + vue-query 三件套就能验一个渲染分支，壳
  （`MailAccountsTab.vue`）是唯一的接线点。

  三处刻意设计：

  1. **授权码不回显**：编辑态 `secret` 恒为空串，placeholder 写「留空表示不修改」
     （后端 `POST /accounts/{id}` 的显式契约：空串 = 保留原密文，不是清空）。
     输入框 `type="password"` + `show-password` + `autocomplete="new-password"` ——
     `autocomplete` 不给，浏览器会拿登录名/密码自动填进这个框，用户没留意就把**自己
     的登录密码**当成授权码提交了（明文进库、且永远看不到）。
  2. **预设下拉 + 只读描述行**：下拉选项取 `/mail/meta` 的 `presets[]`（展示 `label`），
     选中后下方那条只读行展示 `host:port:tls_mode`。**这三值由后端下发**（前端的
     `mailAccountPresetSchema` 只守枚举取值域，没有「163 是什么端口」这种常量）——
     前端另存一份就是第二个真源，后端改端口 / 加一家服务商时它不会报错、只会静默显示
     旧值。
  3. **不做「回显掩码」**：列表与弹窗里都没有任何由授权码派生的展示（连长度都没有）。
     「已配置」是这类信息唯一诚实的表达方式。
-->
<template>
  <el-dialog :model-value="modelValue" :title="title" width="520px" @update:model-value="onCancel">
    <el-form label-width="96px" @submit.prevent>
      <el-form-item label="名称" :error="errors.name" required>
        <el-input
          :model-value="form.name"
          placeholder="给这条邮箱起个名字，如「采购部邮箱」"
          maxlength="64"
          show-word-limit
          @update:model-value="patch({ name: String($event ?? '') })"
        />
      </el-form-item>

      <el-form-item label="预设" :error="errors.preset" required>
        <el-select
          :model-value="form.preset"
          class="preset-select"
          placeholder="选择邮箱服务商"
          @update:model-value="onPresetChange"
        >
          <el-option
            v-for="opt in presetOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <!-- 只读描述行：三值全部取自 `/mail/meta` 的下发值，前端不推导也不缓存。 -->
        <div v-if="presetDetail" class="preset-detail">
          {{ presetDetail.host }}:{{ presetDetail.port }} · {{ presetDetail.tls_mode }}
        </div>
      </el-form-item>

      <el-form-item label="登录账号" :error="errors.account" required>
        <el-input
          :model-value="form.account"
          placeholder="163 填邮箱地址本身，QQ 填 QQ 号"
          maxlength="128"
          @update:model-value="patch({ account: String($event ?? '') })"
        />
      </el-form-item>

      <el-form-item label="授权码" :error="errors.secret" :required="mode === 'create'">
        <el-input
          :model-value="form.secret"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="secretPlaceholder"
          maxlength="128"
          @update:model-value="patch({ secret: String($event ?? '') })"
        />
        <div class="field-hint">加密保存，保存后不再显示，也无法查看</div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button type="primary" :loading="loading" @click="onConfirm">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/mail/accounts/MailAccountDialog.vue
//
// 2026-10-16 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁与提交都是 emit。

import { computed } from 'vue';
import type {
  MailAccountFormFieldErrors,
  MailAccountFormModel,
  MailAccountPresetData,
  MailPresetOptionData,
} from './mailAccountSchema';

const props = defineProps<{
  modelValue: boolean;
  mode: 'create' | 'edit';
  form: MailAccountFormModel;
  errors: MailAccountFormFieldErrors;
  presetOptions: readonly MailPresetOptionData[];
  presetDetail: MailPresetOptionData | null;
  loading: boolean;
}>();

// emits 用**函数类型**（交叉）而不是 `{ (e, v): void }` 的类型字面量：仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红（Vue 3.3+ 两者语义等价）。
// 两条签名写成交叉而不是四条同形的联合：`update:modelValue` 带一个 payload、其余三个
// 不带，拆成四条会被 lint 的 `unified-signatures` 判「可以合并」。
const emit = defineEmits<
  ((e: 'update:modelValue', value: boolean) => void) &
    ((e: 'confirm' | 'cancel' | 'patch', value?: Partial<MailAccountFormModel>) => void)
>();

const title = computed(() => (props.mode === 'create' ? '新增邮箱' : '编辑邮箱'));

/** 编辑态 placeholder 写明「留空 = 不改」—— 这是后端显式契约，必须让用户看得见。 */
const secretPlaceholder = computed(() =>
  props.mode === 'create' ? '邮箱服务商提供的授权码' : '留空表示不修改',
);

/** el-select 可能给出 `''` / `undefined` / null，统一归一成 `''`（= 未选）；
 *  zod 的枚举校验会当场把它标红，逼用户显式选一次（前端刻意不设业务默认值）。 */
function onPresetChange(value: unknown): void {
  emit('patch', { preset: (value ?? '') as MailAccountPresetData });
}

function patch(value: Partial<MailAccountFormModel>): void {
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
.preset-select {
  width: 100%;
}

.preset-detail {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
