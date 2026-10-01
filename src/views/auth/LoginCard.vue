<template>
  <el-card class="login-card">
    <div class="card-header">
      <!-- 2026-10-01 新增：品牌图形标。路径不写死在壳里，由调用方经 logoSrc 传入
           （沿用本组件既定的「复用时只改 LoginView，不动 LoginCard」约定）。
           alt 留空是装饰性图片——产品名由下方 h1 承担。 -->
      <img v-if="logoSrc" class="card-logo" :src="logoSrc" alt="" />
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
// 这样 LoginCard 不依赖 useAuthStore / vue-query，纯展示组件。
// 2026-09-26：原 useAuthSession 已迁到 Pinia store useAuthStore。

interface Props {
  title: string;
  subtitle?: string;
  submitText?: string;
  submitting?: boolean;
  errorMessage?: string;
  disabled?: boolean;
  // 2026-10-01 新增：品牌图形标 URL（不含字标的纯图形，见 public/logo-mark.svg）。
  // 选图形标而非完整 lockup：字标是黑色 #010102，本卡片是白底，完整 lockup 里
  // 「图形 + 字标」会与下方 h1 的产品名重复；且字标仅占整体高度 9.7%，缩到
  // 卡片内的合理尺寸后不可读。
  logoSrc?: string;
}

const props = withDefaults(defineProps<Props>(), {
  subtitle: '',
  submitText: '登 录',
  submitting: false,
  errorMessage: '',
  disabled: false,
  logoSrc: '',
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
  /* 2026-10-01 新增：120×80 ≈ 1.5:1，贴合 logo 的 1.51:1 宽高比；
     object-fit: contain 保证 SVG 根节点 mm 固有尺寸不把图拉变形。
     卡片高 380px、上 padding 40px，内容宽 308px —— 120px 居中留白充裕。 */
  .card-logo {
    display: block;
    width: 120px;
    height: 80px;
    object-fit: contain;
    margin: 0 auto 16px;
  }
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
