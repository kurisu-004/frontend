import { createApp } from 'vue';
import { createPinia } from 'pinia';
// 2026-09-24 新增：注册 TanStack Query 仓内首个 QueryClient。
// 仓内首例 useMutation 出现在 LoginView.vue（2026-09-24 登录页改造）。
//
// 全局 mutation 默认 retry: 0：TanStack Query 默认失败重试 3 次（指数退避），
// 登录失败若重试会导致用户以为"点了没反应"；其它 mutation 失败重试通常也
// 是浪费（业务错误码不会被重试结果修复）。所以全局关掉。
//
// queries 默认 retry: 0 + refetchOnWindowFocus: false：
//   - retry: 0 — 仓内目前没有 useQuery 先例，但避免后续迁移时静默重试；
//   - refetchOnWindowFocus: false — 默认 true 会让编辑类表单的 GET 在窗口
//     切换时频繁刷，先关掉避免未来引入即踩坑。
//
// plugin 顺序硬约束：VueQueryPlugin 必须在 createPinia 之后、app.mount 之前。
// 否则 useMutation 会抛 "No QueryClient set"。
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

import App from './App.vue';
import router from './router';
import { useAuthSession } from './composables/useAuthSession';
import './styles/index.scss';

// Element Plus 命令式 API（ElMessageBox / ElMessage / ElNotification / ElLoading）
// 的 CSS 必须手动引入 —— unplugin-vue-components 的 ElementPlusResolver 只扫描
// <template>，<script setup> 里的程序式调用走 Vite 副作用链不会触发 CSS 注入。
// 2026-08-22 修复：8468333 重构时漏了这一层，全站弹窗无样式（截图症状：消息框
// 落左上角、按钮纵向堆叠、标题被截）。
import 'element-plus/theme-chalk/el-message-box.css';
import 'element-plus/theme-chalk/el-message.css';
import 'element-plus/theme-chalk/el-notification.css';
import 'element-plus/theme-chalk/el-loading.css';
import 'element-plus/theme-chalk/el-overlay.css';
// 2026-09-17 新增：PartDetail 卡片化重构（PR-4）引入 el-tabs（PartFilesTabsCard
// header 行内 tabs）和 el-timeline（ProcessChainCard / PartHistoryCard）。
// unplugin-auto-import resolver 只扫 <template>，但走 CSS bundle 仍需手动
// 引入 theme-chalk CSS（与 ElMessage 等命令式 API 同源问题）。
import 'element-plus/theme-chalk/el-tabs.css';
import 'element-plus/theme-chalk/el-timeline.css';

// 2026-08-21：Element Plus 全量注册（app.use + 全局图标循环）已移除，改为
// unplugin-auto-import / unplugin-vue-components 按需自动解析（见 vite.config.ts），
// index chunk 从 1.1MB 降到 500kB 以下。中文 locale 下沉到 App.vue 根级
// el-config-provider；侧栏菜单图标见 layouts/components/MenuTreeItem.vue 的 ICON_MAP；
// 命令式 API 样式见更上方那块注释（resolver 看不到 <script setup> 里的调用）。
const app = createApp(App);

// 2026-09-24 新增：仓内首个 QueryClient（默认 retry: 0，详见 import 块上方注释）。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 0, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });

// 2026-08-28 重写：dev-only dummy-auth 注入。
// 改走 `import.meta.env.DEV && import.meta.env.VITE_DUMMY_AUTH === 'true'`
// （由 `npm run dev:dummy` → vite --mode dummy → 自动加载 .env.dummy 注入）。
// prod build 里 import.meta.env.DEV === false，import.meta.env.VITE_DUMMY_AUTH
// 也是 undefined，整段 tree-shake。
// 必须放在 app.use(router) 之前——router 首次 beforeEach 触发时 user + isDummy 已就位，
// 守卫短路 refreshOrLogout 不调 /iam/me。
if (import.meta.env.DEV && import.meta.env.VITE_DUMMY_AUTH === 'true') {
  useAuthSession().initDummyAuth();
}

app.use(router);

// 2026-07-10 起：refresh token 失效 / 40102 兜底都走这个事件统一跳登录页。
// axios 响应拦截器（http.ts）会 dispatch；这里只负责导航，避免拦截器反向依赖 vue-router。
window.addEventListener('auth:logout', () => {
  // 拦截器失败分支已经清掉 localStorage；这里只负责跳转。
  router.replace('/login');
});

app.mount('#app');
