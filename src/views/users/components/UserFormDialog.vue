<!--
  UserFormDialog.vue — 新增 / 编辑账号（合并为一个对话框）

  2026-10-10 新建。校验走 Zod（`views/users/usersSchema.ts::userFormSchema`）而不是
  el-form 的内联校验规则 —— 报错文案与规则集中一处、可单测，且与登录表单 / 其余现代页
  同一套口径。

  编辑态的两条 UI 约定（沿旧版）：
    - 用户名禁用（后端不允许改用户名）；
    - 密码留空 = 不改密码（提交时不传该键，不是传空串）。
-->
<template>
  <el-dialog
    v-model="store.dialogs.form.visible"
    :title="store.dialogs.form.editingId ? '编辑账号' : '新增账号'"
    :width="dlg.width"
    :top="dlg.top"
    :close-on-click-modal="false"
  >
    <el-form :model="store.dialogs.form.form" label-width="80px" @submit.prevent>
      <el-form-item label="用户名" :error="errors.username">
        <el-input
          ref="usernameInputRef"
          v-model="store.dialogs.form.form.username"
          :disabled="!!store.dialogs.form.editingId"
          placeholder="登录用的账号"
        />
      </el-form-item>
      <el-form-item label="姓名" :error="errors.full_name">
        <el-input v-model="store.dialogs.form.form.full_name" />
      </el-form-item>
      <el-form-item label="密码" :error="errors.password">
        <el-input
          v-model="store.dialogs.form.form.password"
          type="password"
          show-password
          :placeholder="
            store.dialogs.form.editingId ? '留空不改' : `留空则用默认口令 ${DEFAULT_PASSWORD}`
          "
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="store.dialogs.form.visible = false">取消</el-button>
      <el-button type="primary" :loading="store.dialogs.form.saving" @click="onSubmit">
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// views/users/components/UserFormDialog.vue
//
// 2026-10-10 新建：见文件头。本组件 0 业务状态 —— 表单字段、对话框态、提交分发全在
// store（`composables/useUsersListStore.ts`），这里只做「Zod 校验 + 焦点回送 + 收口 try」。
// 组件层零 `api/*` 依赖（DTO 差异只能在适配层消化）。

import { ref, watch } from 'vue';
import type { InputInstance } from 'element-plus';
import { useDialogSize } from '@/composables/useDialogSize';
import { DEFAULT_PASSWORD } from '../usersConstants';
import {
  toFieldErrors,
  userFormSchema,
  type UserFormFieldErrors,
  type UserFormInput,
} from '../usersSchema';
import { useUsersListStore } from '../composables/useUsersListStore';

const store = useUsersListStore();
const dlg = useDialogSize({ desktopWidth: 420 });

const errors = ref<UserFormFieldErrors>({});
const usernameInputRef = ref<InputInstance | null>(null);

function onSubmit(): void {
  const parsed = userFormSchema.safeParse({
    username: store.dialogs.form.form.username,
    full_name: store.dialogs.form.form.full_name,
    password: store.dialogs.form.form.password,
  });
  if (!parsed.success) {
    errors.value = toFieldErrors<UserFormInput>(parsed.error.issues);
    return;
  }
  errors.value = {};
  // 提交失败（后端拒）时错误提示由 store 的 mutation onError 弹，弹窗保持开着让用户改完
  // 重试；这里 catch 掉 rejection 只是为了不让它变成 unhandledrejection。
  store.submitForm(parsed.data).catch(() => {
    /* 已提示 */
  });
}

// 20602（用户名重复）由 store 置 focusUsername ⇒ 把焦点送回该字段，并清掉本地的字段报错。
watch(
  () => store.dialogs.form.focusUsername,
  (focus) => {
    if (!focus) return;
    errors.value = { ...errors.value, username: '用户名已存在' };
    usernameInputRef.value?.focus();
  },
);
</script>
