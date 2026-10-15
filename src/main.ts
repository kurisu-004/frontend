import { createApp, defineAsyncComponent } from 'vue';
import { createPinia } from 'pinia';
// 2026-09-24 新增：注册 TanStack Query 仓内首个 QueryClient。
// 仓内首例 useMutation 出现在 LoginView.vue（2026-09-24 登录页改造）。
//
// 全局 mutation 默认 retry: 0：TanStack Query v5 官方默认 mutation 不重试
// （3 次指数退避是 query 的默认行为，不是 mutation 的）；这里显式 retry: 0
// 是双保险并明示意图。登录失败若重试会让用户以为"点了没反应"；其它 mutation
// 失败重试通常也是浪费（业务错误码不会被重试结果修复）。
//
// queries 默认 retry: 0 + refetchOnWindowFocus: false：
//   - retry: 0 — query 默认重试 3 次，关掉避免静默重试；
//   - refetchOnWindowFocus: false — 默认 true 会让编辑类表单的 GET 在窗口
//     切换时频繁刷，先关掉避免未来引入即踩坑。
//
// plugin 顺序硬约束：VueQueryPlugin 必须在 createPinia 之后、app.mount 之前。
// 否则 useMutation 会抛 "No QueryClient set"。
// 2026-10-02（M-4）追加：auth store 在 setup 顶部调 useQueryClient()（会话终止时
// clear() 缓存），所以本注册还必须早于**任何** store 实例化点 —— 最早的实例化是下面
// dummy 分支的 useAuthStore()，非 dummy 模式则是 src/router/index.ts 的全局前置
// 守卫。提前量已足够（createPinia 与本注册之间没有任何 store 访问）。
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';

import App from './App.vue';
import router from './router';
// 2026-09-30 新增：vue-echarts 8.3 全局注册（沿 CLAUDE.md 硬约束：图表统一 vue-echarts）。
// 2026-10-21 改为**懒加载注册**：静态 import 会把 echarts + zrender + vue-echarts 整块
// （改前实测 660KB / gzip 226KB，摘掉三个未用组件后 628KB / gzip 215KB）拉进入口
// chunk —— 它只被 `main.ts` 引用一次，所以无法被拆成共享 chunk，那 660KB 恒占首屏
// （实测占入口 chunk 的 70~85%）。而全站只有
// dashboard 一张图 + statistics 三个 tab 用到图表，绝大多数页面（登录 / 报工台 / 队列 /
// 列表…）根本不画图。改成异步组件后，这块只在**第一个 `<v-chart>` 真正渲染时**下载。
//
// 仍然是全局注册：模板里 `<v-chart>` / `<VChart>` 两种写法照旧可用，业务组件照旧不局部
// import（CLAUDE.md「图表」一节的硬约束没有被削弱）。vue-echarts 8 自身的 CSS 由它在
// 运行时 `createElement('style')` 注入，样式随 chunk 同批到位 ⇒ 不会 FOUC。
// 守卫见 `src/plugins/__tests__/echartsContract.spec.ts`（「注册必须是动态形态」那条）。
// ⚠️ 这里**不能**留 `import { VChart } from '@/plugins/echarts'` 的静态语句 ——
// 留了等于什么都没改（那 660KB 会照旧进入口 chunk），且不会有任何报错。
// 2026-09-26：迁移到 Pinia setup store useAuthStore（src/stores/auth.ts），
// 替代原 composables/useAuthSession 模块级单例。store 内 loadFromStorage 自执行
// 首次 useAuthStore() 时恢复 localStorage；CustomEvent listener 在 setup 里挂，
// 拦截器刷新 token 后会自动同步。
import { useAuthStore } from './stores/auth';
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
// 2026-09-30 Phase 2 followup #2：FactoryRealtimeStrip 引入 <el-carousel> 承载
// worker groups >4 时的轮播；unplugin-vue-components resolver 只扫 <template>，
// theme-chalk CSS 必须手动 import（与上方 ElMessage / ElTabs 同源问题）。EP v2.14.x
// 的 el-carousel 与 el-carousel-item 样式分文件（unplugin ElementPlusResolver 不自动
// 按需），必须双 import；漏掉 el-carousel-item.css 会让 carousel-item 节点以 block
// 默认布局垂直堆叠、不绝对定位，autoplay 翻页不可见（仅首屏露出）。
import 'element-plus/theme-chalk/el-carousel.css';
import 'element-plus/theme-chalk/el-carousel-item.css';

// 2026-10-09 新增：批次卡片右键菜单换用 `@imengyu/vue3-context-menu`（看板五区共用）。
// 该库的样式**必须**单独 import —— 它是预编译 CSS、不走 unplugin-vue-components 的按需
// 注入链，漏掉这行的症状是「菜单渲染出来了但完全没有样式」（无边框 / 无背景 / 全透明）。
// 外观全走库原生主题（`theme: 'default'`），本仓不覆写它的任何 CSS 变量。
import '@imengyu/vue3-context-menu/lib/vue3-context-menu.css';

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

// 2026-09-30 新增：全局注册 <v-chart>；按需模块已在 plugins/echarts.ts 完成。
// 注册名用 PascalCase 'VChart'（vue-echarts 官方推荐 + 满足 alloy 的
// vue/component-definition-name-casing 规则）；模板里 <v-chart> / <VChart>
// 两种写法都能命中——Vue 模板对组件名自动归一。
// 2026-10-21：注册体改 defineAsyncComponent（理由见文件头那段注释）：首屏不再带
// echarts/zrender 那 628KB，第一个 <v-chart> 渲染时才拉。
app.component(
  'VChart',
  defineAsyncComponent(() => import('@/plugins/echarts').then((m) => m.VChart)),
);

// 2026-08-28 重写：dev-only dummy-auth 注入。
// 改走 `import.meta.env.DEV && import.meta.env.VITE_DUMMY_AUTH === 'true'`
// （由 `npm run dev:dummy` → vite --mode dummy → 自动加载 .env.dummy 注入）。
// prod build 里 import.meta.env.DEV === false，import.meta.env.VITE_DUMMY_AUTH
// 也是 undefined，整段 tree-shake。
// 必须放在 app.use(router) 之前——router 首次 beforeEach 触发时 user + isDummy 已就位，
// 守卫短路 refreshOrLogout 不调 /iam/me。
// 2026-09-26 迁移到 useAuthStore()：调用 initDummyAuth() 注入 fake session + 标记
// isDummyAuthActive。store 内部保证 VITE_DUMMY_AUTH=true 时才注入；外层判定重复
// 一遍节省 dev-only 分支的运行开销（条件不满足时函数内立即 return）。
if (import.meta.env.DEV && import.meta.env.VITE_DUMMY_AUTH === 'true') {
  useAuthStore().initDummyAuth();
}

app.use(router);

// 2026-07-10 起：refresh token 失效 / 40102 兜底都走这个事件统一跳登录页。
// axios 响应拦截器（http.ts）会 dispatch；这里只负责导航，避免拦截器反向依赖 vue-router。
//
// 2026-10-02 订正：本注释原写「拦截器失败分支已经清掉 localStorage；这里只负责跳转」
// —— 那是**事实错误**：`src/api/http.ts` 全文件零 QueryClient 引用、也从不碰
// localStorage（它只在 refresh 成功时经 persistTokens() **写** auth_session）。
// 真实的分工是：
//   - 会话状态（token / user / auth_session / tagsView / **query 缓存**）由
//     src/stores/auth.ts 订阅同一个 'auth:logout' 事件 → teardownSession() 收口
//     （M-4 新增，此前只有本处一个订阅方、状态无人清理）；
//   - 本 listener 只负责导航。
window.addEventListener('auth:logout', () => {
  router.replace('/login');
});

app.mount('#app');
