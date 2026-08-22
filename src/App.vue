<template>
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
// 工位扫码台已下沉为 /scan/* 下的独立路由 + 独立页面，不再需要 App 根级挂载。
// 全局扫码监听、各页面的 onScan 订阅都在对应 /scan/* 页面里。
//
// 2026-08-21：EP 改按需加载后，中文 locale 由根级 el-config-provider 下发
//（el-config-provider 组件本身由 unplugin-vue-components 自动解析，无需 import）。
// 2026-08-22：原计划通过 :theme token 注入项目藏青，但 EP 2.14.2 还没有 theme prop。
// 改走 CSS 变量覆盖 —— 在 src/styles/variables.scss 的 :root 块里直接重定义
// --el-color-primary* 系列（见那里 2026-08-22 那块注释）。
import zhCn from 'element-plus/es/locale/lang/zh-cn.mjs'
</script>