import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './styles/index.scss'

// Element Plus 命令式 API（ElMessageBox / ElMessage / ElNotification / ElLoading）
// 的 CSS 必须手动引入 —— unplugin-vue-components 的 ElementPlusResolver 只扫描
// <template>，<script setup> 里的程序式调用走 Vite 副作用链不会触发 CSS 注入。
// 2026-08-22 修复：8468333 重构时漏了这一层，全站弹窗无样式（截图症状：消息框
// 落左上角、按钮纵向堆叠、标题被截）。
import 'element-plus/theme-chalk/el-message-box.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-notification.css'
import 'element-plus/theme-chalk/el-loading.css'
import 'element-plus/theme-chalk/el-overlay.css'

// 2026-08-21：Element Plus 全量注册（app.use + 全局图标循环）已移除，改为
// unplugin-auto-import / unplugin-vue-components 按需自动解析（见 vite.config.ts），
// index chunk 从 1.1MB 降到 500kB 以下。中文 locale 下沉到 App.vue 根级
// el-config-provider；侧栏菜单图标见 layouts/components/MenuTreeItem.vue 的 ICON_MAP；
// 命令式 API 样式见更上方那块注释（resolver 看不到 <script setup> 里的调用）。
const app = createApp(App)

app.use(createPinia())
app.use(router)

// 2026-07-10 起：refresh token 失效 / 40102 兜底都走这个事件统一跳登录页。
// axios 响应拦截器（http.ts）会 dispatch；这里只负责导航，避免拦截器反向依赖 vue-router。
window.addEventListener('auth:logout', () => {
  // 拦截器失败分支已经清掉 localStorage；这里只负责跳转。
  router.replace('/login')
})

app.mount('#app')