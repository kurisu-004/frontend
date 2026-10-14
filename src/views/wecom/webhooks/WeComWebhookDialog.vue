<!--
  WeComWebhookDialog.vue — 新增 / 编辑 Webhook 通道弹窗（**纯组件**，不首调 store）

  2026-10-17 新建。形态照 `views/mail/accounts/MailAccountDialog.vue`：表单模型从 props 进、
  提交结果从 emit 出，校验在 store 里（`useWeComWebhooksStore::submit`）—— 这样单测不必拖
  pinia + vue-query 三件套就能验一个渲染分支，壳（`WeComWebhooksTab.vue`）是唯一的接线点。

  三处刻意设计：

  1. **地址不回显**：编辑态 `webhook_url` 恒为空串，placeholder 写「留空表示不修改」（后端
     `POST /webhooks/{id}` 的显式契约：空串 = 保留原密文，不是清空）。编辑态在输入框上方多一
     行**只读**的「当前地址（掩码）」—— 那是 `url_masked`，**不是**完整地址（后端出参里根本
     没有完整地址这回事）。
     输入框 `type="password"` + `show-password` + `autocomplete="new-password"` ——
     `autocomplete` 不给，浏览器会拿登录名/密码自动填进这个框，用户没留意就把**自己的登录
     密码**当成地址提交了（明文进库、且永远看不到）。
  2. **不做「回显掩码后可编辑」**：掩码不是合法地址，把它塞回输入框会被 zod 的格式校验当场
     标红，还会让人以为「地址就是这一串」。只读展示、不进输入框。
  3. **两个 `maxlength` 一律绑 schema 的常量**（`WECOM_WEBHOOK_NAME_MAX` /
     `_URL_MAX`），模板里不写第二份字面量 —— 写死了就会出现「改了 schema 的上限、界面仍按旧值
     拦（或放行）」，用户在浏览器过得去、后端拿 21803 拒。
-->
<template>
  <el-dialog :model-value="modelValue" :title="title" width="560px" @update:model-value="onCancel">
    <el-form label-width="96px" @submit.prevent>
      <el-form-item label="名称" :error="errors.name" required>
        <el-input
          :model-value="form.name"
          placeholder="给这条通道起个名字，如「生产群」"
          :maxlength="WECOM_WEBHOOK_NAME_MAX"
          show-word-limit
          @update:model-value="patch({ name: String($event ?? '') })"
        />
      </el-form-item>

      <el-form-item label="Webhook 地址" :error="errors.webhook_url" :required="mode === 'create'">
        <!-- 只读展示当前那一条的**掩码**。完整地址永不出参 ⇒ 无从回显（见文件头第 2 点）。 -->
        <div v-if="mode === 'edit' && urlMasked" class="masked-hint">
          当前地址：<code>{{ urlMasked }}</code>
        </div>
        <el-input
          :model-value="form.webhook_url"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="urlPlaceholder"
          :maxlength="WECOM_WEBHOOK_URL_MAX"
          @update:model-value="patch({ webhook_url: String($event ?? '') })"
        />
        <div class="field-hint">
          从企业微信群的「群机器人 → 添加机器人 → 复制
          Webhook」拿到的完整地址；加密保存，保存后不再显示
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button type="primary" :loading="loading" @click="onConfirm">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/wecom/webhooks/WeComWebhookDialog.vue
//
// 2026-10-17 新建：见文件头。0 业务状态 —— 表单模型是 prop、补丁与提交都是 emit。

import { computed } from 'vue';
import {
  WECOM_WEBHOOK_NAME_MAX,
  WECOM_WEBHOOK_URL_MAX,
  type WeComWebhookFormFieldErrors,
  type WeComWebhookFormMode,
  type WeComWebhookFormModel,
} from './weComWebhookSchema';

const props = defineProps<{
  modelValue: boolean;
  mode: WeComWebhookFormMode;
  form: WeComWebhookFormModel;
  errors: WeComWebhookFormFieldErrors;
  /** 正在编辑那一行的**掩码**地址（`url_masked`）。完整地址永不出参。 */
  urlMasked: string;
  loading: boolean;
}>();

// emits 用**函数类型**（交叉）而不是 `{ (e, v): void }` 的类型字面量：仓库 lint 的
// `@typescript-eslint/prefer-function-type` 会把后者判红（Vue 3.3+ 两者语义等价）。
// 两条签名写成交叉而不是四条同形的联合：`update:modelValue` 带一个 payload、其余三个不带，
// 拆成四条会被 lint 的 `unified-signatures` 判「可以合并」。
const emit = defineEmits<
  ((e: 'update:modelValue', value: boolean) => void) &
    ((e: 'confirm' | 'cancel' | 'patch', value?: Partial<WeComWebhookFormModel>) => void)
>();

const title = computed(() => (props.mode === 'create' ? '新增 Webhook' : '编辑 Webhook'));

/** 编辑态 placeholder 写明「留空 = 不改」—— 这是后端显式契约，必须让用户看得见。 */
const urlPlaceholder = computed(() =>
  props.mode === 'create'
    ? 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
    : '留空表示不修改',
);

function patch(value: Partial<WeComWebhookFormModel>): void {
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
.masked-hint {
  width: 100%;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.masked-hint code {
  font-family: ui-monospace, monospace;
}

.field-hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
</style>
