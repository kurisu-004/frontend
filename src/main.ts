import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './styles/index.scss'

// 2026-08-21：Element Plus 全量注册（app.use + 全局图标循环）已移除，改为
// unplugin-auto-import / unplugin-vue-components 按需自动解析（见 vite.config.ts），
// index chunk 从 1.1MB 降到 500kB 以下。中文 locale 下沉到 App.vue 根级
// el-config-provider；侧栏菜单图标见 layouts/components/MenuTreeItem.vue 的 ICON_MAP。
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