<template>
  <el-card class="login-card">
    <div class="card-header">
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <form @submit.prevent="onSubmit">
      <slot />
      <p v-if="errorMessage" class="error-msg" role="alert">{{ errorMessage }}</p>
      <el-button
        type="primary"
        native-type="submit"
        :loading="submitting"
        :disabled="disabled"
        class="submit-btn"
      >
        {{ submitting ? '登录中...' : submitText }}
      </el-button>
    </form>
    <div v-if="$slots.footer" class="card-footer">
      <slot name="footer" />
    </div>
  </el-card>
</template>

<script setup lang="ts">
// 2026-09-24 新增：登录视觉壳。LoginView 的卡片布局与 BeianFooter 链接区抽出来
// 让"找回密码 / 注册 / 二步验证"等场景复用同一视觉壳；表单字段由调用方
// 通过 #default slot 注入，本组件不持有任何业务状态。
//
// emit 不带 payload —— 父组件持有 form ref 与 mutation，按 submit 触发器拿 form.value。
// 这样 LoginCard 不依赖 useAuthSession / vue-query，纯展示组件。

interface Props {
  title: string;
  subtitle?: string;
  submitText?: string;
  submitting?: boolean;
  errorMessage?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  subtitle: '',
  submitText: '登 录',
  submitting: false,
  errorMessage: '',
  disabled: false,
});

const emit = defineEmits<{ submit: [] }>();

const onSubmit = () => {
  if (props.submitting || props.disabled) return;
  emit('submit');
};
</script>

<style lang="scss" scoped>
.login-card {
  width: 380px;
  max-width: calc(100vw - 24px);
  background: #fff;
  border-radius: 8px;
  padding: 40px 36px 32px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
}
.card-header {
  text-align: center;
  margin-bottom: 28px;
  h1 {
    margin: 0 0 4px;
    font-size: 22px;
    color: #1a365d;
  }
  p {
    color: #909399;
    font-size: 13px;
    margin: 0;
  }
}
.submit-btn {
  width: 100%;
  margin-top: 8px;
}
.error-msg {
  color: #f56c6c;
  font-size: 13px;
  text-align: center;
  margin-top: 12px;
}
.card-footer {
  margin-top: 16px;
  text-align: center;
}
</style>