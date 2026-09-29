// src/layouts/composables/useUserActions.ts
//
// 2026-09-29 抽离：原 MainLayout.vue 内嵌的「用户信息 + 退出登录 + 修改密码」全套
// 逻辑迁出。沿 2026-09-27 composable 归属判别——单域（layout）就近放 layouts/composables/，
// 不进 src/composables/。MainLayout.vue 不再持有 currentUser fetch、ElMessageBox 确认、
// 改密表单状态与表单 ref；仅保留折叠 / 菜单 / tagsView keep-alive。
//
// 职责：
//   - currentUser onMounted fetch（dummy-auth 守卫，沿 MainLayout 历史逻辑）
//   - userName computed（avatar/name 展示）
//   - handleUserCmd(cmd)：logout 弹确认 → auth.logout → 跳 /login；
//                         change-password → 打开 dialog
//   - 改密 dialog 全部状态：showChangePwd / pwdForm / pwdRules / pwdFormRef /
//     pwdSaving / pwdDlg / resetPwdForm / submitChangePwd
//
// consumer 形态：UserDropdown.vue 在 setup 内 `const u = useUserActions()`，
// 模板里直接 `u.xxx`——composable 返回的是 refs/reactive，解构不丢响应式
//（对比 Pinia store 的"不解构"不变量仅针对 store proxy）。

import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { me as apiMe, changeMyPassword } from '@/api/iam';
import { useDialogSize } from '@/composables/useDialogSize';
import type { CurrentUser } from '@/types/user';

export type UserCmd = 'change-password' | 'logout';

export function useUserActions() {
  const router = useRouter();
  const auth = useAuthStore();

  // ===== 用户名 =====
  const currentUser = ref<CurrentUser | null>(null);
  const userName = computed<string>(() => {
    const u = currentUser.value;
    return u?.full_name || u?.username || '未登录';
  });

  // ===== 菜单命令派发 =====
  const handleUserCmd = async (cmd: string | number | object): Promise<void> => {
    const command = cmd as UserCmd;
    if (command === 'logout') {
      try {
        await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning',
        });
        await auth.logout();
        ElMessage.success('已退出登录');
        router.replace('/login');
      } catch {
        /* cancelled */
      }
    } else if (command === 'change-password') {
      showChangePwd.value = true;
    }
  };

  // ===== 修改密码 dialog =====
  const showChangePwd = ref<boolean>(false);
  const pwdSaving = ref<boolean>(false);
  const pwdFormRef = ref<FormInstance>();
  const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const pwdDlg = useDialogSize({ desktopWidth: 420 });

  const validateNewPwd = (_rule: unknown, value: string, callback: (err?: Error) => void): void => {
    if (!value) return callback(new Error('请输入新密码'));
    if (value.length < 6) return callback(new Error('新密码至少 6 位'));
    if (value === pwdForm.oldPassword) return callback(new Error('新密码不能与原密码相同'));
    // 新密码变化时，若确认框已填，重新触发确认框校验
    if (pwdForm.confirmPassword) pwdFormRef.value?.validateField('confirmPassword');
    callback();
  };
  const validateConfirmPwd = (
    _rule: unknown,
    value: string,
    callback: (err?: Error) => void,
  ): void => {
    if (!value) return callback(new Error('请再次输入新密码'));
    if (value !== pwdForm.newPassword) return callback(new Error('两次输入的新密码不一致'));
    callback();
  };
  const pwdRules: FormRules = {
    oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
    newPassword: [{ validator: validateNewPwd, trigger: 'blur' }],
    confirmPassword: [{ validator: validateConfirmPwd, trigger: 'blur' }],
  };

  function resetPwdForm(): void {
    pwdForm.oldPassword = '';
    pwdForm.newPassword = '';
    pwdForm.confirmPassword = '';
    pwdFormRef.value?.clearValidate();
  }

  async function submitChangePwd(): Promise<void> {
    const valid = await pwdFormRef.value?.validate().catch(() => false);
    if (!valid) return;
    pwdSaving.value = true;
    try {
      await changeMyPassword({
        old_password: pwdForm.oldPassword,
        new_password: pwdForm.newPassword,
      });
      showChangePwd.value = false;
      ElMessage.success('密码已修改，请重新登录');
      await auth.logout();
      router.replace('/login');
    } catch (e: unknown) {
      ElMessage.error(e instanceof Error ? e.message : '修改密码失败');
    } finally {
      pwdSaving.value = false;
    }
  }

  // ===== 首屏 fetch（沿 MainLayout 历史 dummy 守卫） =====
  onMounted(async () => {
    // 2026-09-11 修复（沿用原逻辑）：dev:dummy 模式下跳过 apiMe()——dummy token
    // 'dummy-dev-token' 被后端判无效 → 401 → 此前会被踢回登录页。dummy 已经注入
    // 完整 CurrentUser，无需再向 /iam/me 验证。
    if (auth.isDummyAuthActive) return;
    try {
      currentUser.value = await apiMe();
    } catch {
      router.replace('/login');
    }
  });

  return {
    userName,
    handleUserCmd,
    showChangePwd,
    pwdSaving,
    pwdFormRef,
    pwdForm,
    pwdRules,
    pwdDlg,
    resetPwdForm,
    submitChangePwd,
  };
}