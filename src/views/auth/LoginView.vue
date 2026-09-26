<template>
  <div class="login-page">
    <LoginCard
      title="洪升宏ERP"
      subtitle="AI驱动的现代化生产管理系统"
      :submitting="submitting"
      :error-message="errorMessage"
      @submit="onSubmit"
    >
      <el-form :model="form" label-position="top" @submit.prevent>
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
    </LoginCard>
    <BeianFooter />
  </div>
</template>

<script setup lang="ts">
// 2026-09-26 重构：登录页切到 useAuthStore.loginMutation。
// useMutation 已在 store 内部（auth.loginMutation），LoginView 只持表单 ref +
// Zod schema + 角色路由跳转。
//
// 关键设计：
//   - useMutation 官方默认不重试（3 次指数退避是 query 的默认行为，不是 mutation
//     的）；全局 defaultOptions 也显式 retry: 0 双保险。仓内新增 mutation 不写 retry。
//   - Zod schema 把 trim 放在最前；mutationFn 不再做 trim（避免双重 trim）。
//   - LoginCard 只持展示态（不持表单），emit submit 无 payload，父组件
//     持有 form ref 与 mutation。
//   - 错误映射：40101（账号或密码错）/ 40105（session 吊销）→ 友好文案；
//     其它错误 → err.message 或兜底文案。
//   - **Pinia store 自动解包**：auth.loginMutation.isPending / auth.loginMutation.error
//     通过 store proxy 访问时已是解包后的值（boolean / ApiError | null），**不写 .value**。
//     这是与仓内其它 setup store（usePartsListStore）一致的不变量：consumer 走
//     `auth.xxx` 自动响应 + 自动解包。

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { User, Lock } from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';
import BeianFooter from '@/components/BeianFooter.vue';
import LoginCard from './LoginCard.vue';
import { loginSchema, toFieldErrors, type LoginInput, type LoginFieldErrors } from './loginSchema';

const UserIcon = User;
const LockIcon = Lock;

const router = useRouter();
const auth = useAuthStore();

const form = ref<LoginInput>({ username: '', password: '' });
const errors = ref<LoginFieldErrors>({});
// 2026-09-24 新增：账号无任何可用角色的独立提示位（业务逻辑判断，不属于 mutation 失败）。
const noRoleError = ref('');

// 2026-09-26：loginMutation 进 store 后，isPending / error 已经是解包后的值（boolean / 对象）。
const submitting = computed(() => auth.loginMutation.isPending);
const errorMessage = computed(() => {
  if (noRoleError.value) return noRoleError.value;
  const err = auth.loginMutation.error;
  if (!err) return '';
  // 40101 BIZ_AUTH_INVALID / 40105 SESSION_REVOKED 统一文案。
  if (err.code === 40101 || err.code === 40105) return '账号或密码错误，请重试';
  return err.message || '登录失败，请稍后重试';
});

/** 单字段校验：onBlur 触发。 */
const validateField = (field: keyof LoginInput) => {
  // 2026-09-24：直接取 schema.shape[field]（ZodObject 提供 Record<keyof T, ZodTypeAny>）
  // 而非 .pick({...} as Record<...})，避开 consistent-type-assertions 规则。
  const fieldSchema = loginSchema.shape[field];
  const result = fieldSchema.safeParse(form.value[field]);
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
  try {
    // 2026-09-26：mutateAsync 收 LoginCredentials 对象（{ username, password }）。
    const u = await auth.loginMutation.mutateAsync(result.data);
    // 按角色优先级自动跳转（视图关注点，留在 LoginView）。
    if (u.roles.includes('MANAGER')) {
      router.replace('/dashboard');
      return;
    }
    if (u.roles.includes('CLERK') || u.roles.includes('CNC_PROGRAMMER')) {
      router.replace('/parts');
      return;
    }
    if (u.roles.includes('INSPECTOR')) {
      router.replace('/inspection/pending');
      return;
    }
    if (u.roles.includes('SHELF_ACCOUNT')) {
      router.replace('/scan/badge');
      return;
    }
    noRoleError.value = '账号无任何可用角色';
  } catch {
    /* 错误已通过 auth.loginMutation.error 暴露给 LoginCard 的 errorMessage slot */
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
