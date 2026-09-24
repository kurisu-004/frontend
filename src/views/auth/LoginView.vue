<template>
  <div class="login-page">
    <LoginCard
      title="myERP"
      subtitle="零件加工订单管理系统"
      :submitting="submitting"
      :error-message="errorMessage"
      @submit="onSubmit"
    >
      <el-form ref="formRef" :model="form" label-position="top" @submit.prevent>
        <el-form-item label="账号" :error="errors.username">
          <el-input
            v-model="form.username"
            placeholder="用户名"
            :prefix-icon="UserIcon"
            @blur="validateField('username')"
          />
        </el-form-item>
        <el-form-item label="密码" :error="errors.password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            show-password
            :prefix-icon="LockIcon"
            @blur="validateField('password')"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <BeianFooter />
      </template>
    </LoginCard>
  </div>
</template>

<script setup lang="ts">
// 2026-09-24 重构：登录页接入 TanStack Query useMutation + Zod schema 校验。
//
// 关键设计：
//   - useMutation 是仓内首例；retry: 0 必须显式写，避免默认 3 次重试。
//   - mutationFn 调 useAuthSession().login() 而非直接 api.post：token 持久化
//     与 ApiError 规范化都在 useAuthSession 那一层，mutationFn 必须薄。
//   - Zod schema 把 trim 放在最前；mutationFn 不再做 trim（避免双重 trim）。
//   - LoginCard 只持展示态（不持表单），emit submit 无 payload，父组件
//     持有 form ref 与 mutation。
//   - 错误映射：40101（账号或密码错）/ 40105（session 吊销）→ 友好文案；
//     其它错误 → err.message 或兜底文案。

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMutation } from '@tanstack/vue-query';
import { User, Lock } from '@element-plus/icons-vue';
import { useAuthSession } from '@/composables/useAuthSession';
import { ApiError } from '@/api/http';
import type { CurrentUser } from '@/types/user';
import BeianFooter from '@/components/BeianFooter.vue';
import LoginCard from './LoginCard.vue';
import { loginSchema, toFieldErrors, type LoginInput, type LoginFieldErrors } from './loginSchema';

const UserIcon = User;
const LockIcon = Lock;

const router = useRouter();
const session = useAuthSession();

const form = ref<LoginInput>({ username: '', password: '' });
const errors = ref<LoginFieldErrors>({});
// 2026-09-24 新增：账号无任何可用角色的独立提示位（业务逻辑判断，不属于 mutation 失败）。
const noRoleError = ref('');

const loginMutation = useMutation<CurrentUser, ApiError, LoginInput>({
  mutationKey: ['auth', 'login'],
  retry: 0,
  mutationFn: async (creds) => {
    // Zod schema 已在 safeParse 时完成 trim，creds.username 已是 trim 后值。
    // mutationFn 不再二次 trim。
    return session.login(creds.username, creds.password);
  },
  onSuccess: (user) => {
    // 按角色优先级自动跳转（与改造前一致）。
    if (user.roles.includes('MANAGER')) {
      router.replace('/dashboard');
      return;
    }
    if (user.roles.includes('CLERK') || user.roles.includes('CNC_PROGRAMMER')) {
      router.replace('/parts');
      return;
    }
    if (user.roles.includes('INSPECTOR')) {
      router.replace('/inspection/pending');
      return;
    }
    if (user.roles.includes('SHELF_ACCOUNT')) {
      router.replace('/scan/badge');
      return;
    }
    noRoleError.value = '账号无任何可用角色';
  },
});

const submitting = computed(() => loginMutation.isPending.value);
const errorMessage = computed(() => {
  if (noRoleError.value) return noRoleError.value;
  const err = loginMutation.error.value;
  if (!err) return '';
  // 40101 BIZ_AUTH_INVALID / 40105 SESSION_REVOKED 统一文案。
  if (err.code === 40101 || err.code === 40105) return '账号或密码错误，请重试';
  return err.message || '登录失败，请稍后重试';
});

/** 单字段校验：onBlur 触发。 */
const validateField = (field: keyof LoginInput) => {
  const fieldSchema = loginSchema.pick({ [field]: true } as Record<keyof LoginInput, true>);
  const result = fieldSchema.safeParse(form.value);
  if (result.success) {
    delete errors.value[field];
  } else {
    errors.value[field] = result.error.issues[0]?.message;
  }
};

const onSubmit = async () => {
  // 全表单校验。
  const result = loginSchema.safeParse(form.value);
  if (!result.success) {
    errors.value = toFieldErrors(result.error.issues);
    return;
  }
  errors.value = {};
  noRoleError.value = '';
  // mutateAsync 错误已被 useMutation 写入 mutation.error.value（驱动 errorMessage）；
  // 这里 try/catch 仅用于吞掉 promise rejection，避免 unhandledRejection。
  try {
    await loginMutation.mutateAsync(result.data);
  } catch {
    /* 错误已通过 mutation.error.value 暴露给 LoginCard 的 errorMessage slot */
  }
};
</script>

<style lang="scss" scoped>
.login-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1a365d 0%, #2d5a87 100%);
}
</style>