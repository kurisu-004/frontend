<!--
  2026-09-29 抽离：原 MainLayout.vue 的用户下拉 + 改密 dialog 拆为独立组件，
  MainLayout 顶栏右侧仅放 <UserDropdown />。内部逻辑（fetch / logout / 改密
  表单 + 校验）走 src/layouts/composables/useUserActions.ts。
-->
<template>
  <el-dropdown trigger="click" @command="handleUserCmd">
    <div class="user-info">
      <el-avatar :size="32" class="user-avatar" />
      <span class="user-name">{{ userName }}</span>
      <el-icon><ArrowDown /></el-icon>
    </div>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="change-password">
          <el-icon><Lock /></el-icon>修改密码
        </el-dropdown-item>
        <el-dropdown-item divided command="logout">
          <el-icon><SwitchButton /></el-icon>退出登录
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>

  <!-- 修改密码弹窗 -->
  <el-dialog
    v-model="showChangePwd"
    title="修改密码"
    :width="pwdDlg.width"
    :top="pwdDlg.top"
    @closed="resetPwdForm"
  >
    <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="90px">
      <el-form-item label="原密码" prop="oldPassword">
        <el-input
          v-model="pwdForm.oldPassword"
          type="password"
          show-password
          placeholder="请输入原密码"
        />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="pwdForm.newPassword"
          type="password"
          show-password
          placeholder="至少 6 位"
        />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirmPassword">
        <el-input
          v-model="pwdForm.confirmPassword"
          type="password"
          show-password
          placeholder="再次输入新密码"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showChangePwd = false">取消</el-button>
      <el-button type="primary" :loading="pwdSaving" @click="submitChangePwd">
        确定
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
// 2026-09-29：图标原在 MainLayout 直接导入，迁出。本组件只用三个：ArrowDown（下拉指示）、
// Lock（菜单 icon）、SwitchButton（退出 icon）。
import { ArrowDown, Lock, SwitchButton } from '@element-plus/icons-vue';
import { useUserActions } from '@/layouts/composables/useUserActions';

// composable 返回的是 refs + plain 对象 + 函数。解构后 ref 仍保留响应式（不是
// Pinia store proxy 的「不解构」不变量场景）；模板 <el-dialog v-model> / :loading
// 直读 ref 名（Vue 模板自动解包 setup 顶层 ref）。
const {
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
} = useUserActions();
</script>

<style lang="scss" scoped>
/* 2026-09-29 抽离：原 MainLayout.vue 的 .user-info 样式迁出。 */
.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.2s;

  &:hover {
    background-color: var(--primary-bg);
  }

  .user-avatar {
    background-color: var(--primary-light);
  }

  .user-name {
    font-size: 14px;
    color: var(--text-primary);
  }
}
</style>