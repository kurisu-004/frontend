# 构建与工具链

> **目标读者**：Agent 接手新模块、新人理解"为什么项目配置看着奇怪"
> **核心价值**：vite / unplugin / SCSS / Element Plus 主题色 4 类非显然配置的统一解释
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## `optimizeDeps.include`

`vite.config.ts` 里的 `optimizeDeps.include` 是一份硬编码的重依赖清单，**不要删、不要减**。删除后 dev 模式会进入 dep discovery，浏览器点新页面时立刻打印 `[optimizer] bundling dependencies...` 并触发整页 full-reload，体感像改一行 CSS 都要闪一下。

当前条目：

```ts
include: [
  'vue',
  'vue-router',
  'pinia',
  'axios',
  'element-plus',
  '@element-plus/icons-vue',
  'xlsx',
]
```

判断要不要追加一条目：如果 `import` 触发 dev 卡顿 / 频繁 full-reload，就把那个包加进来；不频繁就不加。准则**保守**——多加一个 bundle 几十 KB 的包进 dev chunk 只是 cold start 慢几百毫秒，少了却会让每次点新路由都 full-reload。

## SCSS 管线

`vite.config.ts` 里只有一行相关配置：

```ts
css: {
  preprocessorOptions: {
    scss: { api: 'modern-compiler' },
  },
},
```

`modern-compiler` 是 dart-sass 1.x 的官方推荐 API（替代 node-sass 与 legacy API），vite 内置支持。直接带来的变化：

- 编译速度快很多（dart-sass 原生，无需走 Node C++ 绑定）。
- `@use` / `@forward` 语义严格——同一文件多次 `@use` 只引入一次，循环引用会被静态检测到。

**关于组件内 `@include from(...)` 断点 mixin**：CLAUDE.md 里描述的"每个 `<style lang="scss">` 自动注入 `@use '@/styles/breakpoints'`"是历史配置，已在 T1 重构（commit `8168b2b`）中删除。当前 `vite.config.ts` 没有 `additionalData` 段，没有 `src/styles/_breakpoints.scss` / `breakpoints.scss` 文件，`@include from(...)` / `@include until(...)` now 编译会失败。

现状是响应式断点改为**裸 `@media (min-width: 768px)`**——`src/styles/index.scss` 的 `.form-grid` 就是这个写法，阈值沿用 Element Plus 默认：sm `768px` / md `992px` / lg `1200px`。如果新组件需要响应式，直接抄 `.form-grid` 的 media query 写法即可，不要找 mixin。

## Element Plus 按需加载

2026-08-21 全量注册（`app.use(ElementPlus)` + 全局图标循环）已移除，改为 `unplugin-auto-import` + `unplugin-vue-components` 双 resolver 配置（都在 `vite.config.ts`）：

```ts
AutoImport({
  resolvers: [ElementPlusResolver()],
  dts: 'src/auto-imports.d.ts',
}),
Components({
  resolvers: [ElementPlusResolver()],
  dts: 'src/components.d.ts',
}),
```

`unplugin-auto-import` 负责 `ref` / `reactive` / `ElMessage` / `ElMessageBox` 等 Vue + EP API 在 `<script setup>` 里的隐式可用；`unplugin-vue-components` 负责 `<template>` 里 `el-button` / `el-form` 等组件标签的隐式注册。两边都生成 `.d.ts`，给 TypeScript 类型推断。**两个 `.d.ts` 文件都被纳入版本控制**（`src/auto-imports.d.ts` / `src/components.d.ts`）——首次 `npm run dev` 自动生成后，提交进去；CI 跑 `vue-tsc` 也会以这份文件作为类型来源。

### resolver 只扫 `<template>`

这是新手最容易踩的坑：`unplugin-vue-components` 的 resolver 走的是模板静态扫描，只看 `<template>` 里出现的标签。`<script setup>` 里的**程序式 API 调用**——`ElMessageBox.confirm(...)` / `ElMessage.success(...)` / `ElNotification(...)` / `ElLoading.service(...)`——resolver 看不到，因此不会自动 import 它们的 JS 也不会注入对应 CSS。

CSS 缺失的症状很明显：消息框落左上角、按钮纵向堆叠、标题被截。修复方式是在 `src/main.ts` 顶部**手动 import** 这 4 个 CSS：

```ts
import 'element-plus/theme-chalk/el-message-box.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-notification.css'
import 'element-plus/theme-chalk/el-loading.css'
import 'element-plus/theme-chalk/el-overlay.css'
```

（`el-overlay.css` 是消息框 / notification 的遮罩层，2026-08-22 重构漏了这一层，全站弹窗无样式，截图记录在 `main.ts` 注释里。）

### icon 引入仍走显式 import

`@element-plus/icons-vue` 不在 `optimizeDeps.include` 也不会被 auto-import——图标组件**必须显式 import** 后在 `<script setup>` 注册才能用：

```ts
import { ArrowLeft, Search } from '@element-plus/icons-vue'
```

不要把整个 `@element-plus/icons-vue` 拉满。

## Element Plus 主题色覆盖

项目主色藏青 `#1e4d8b`，习惯性想法是"用 EP 2.x 的 `theme` prop 注入 token"。**当前 EP 2.14.x 还没有 `theme` prop**——见 EP 官方 Config Provider 文档，2026-08-22 验证过。这是 EP 升级到 2.15+ 才会发布的 API。

当前的做法是**直接覆盖 EP 的 CSS 变量**，写在 `src/styles/variables.scss` 的 `:root` 块：

```scss
:root {
  --el-color-primary: #1e4d8b;
  --el-color-primary-light-3: #4a8fd6;
  --el-color-primary-light-5: #7eb0e3;
  --el-color-primary-light-7: #b3d0ee;
  --el-color-primary-light-8: #cce0f4;
  --el-color-primary-light-9: #eaf2fb;
  --el-color-primary-dark-2: #163b6e;
}
```

EP 所有用 `var(--el-color-primary*)` 取色的组件（按钮 / switch / checkbox / radio / tag / pagination / 弹窗按钮 / 排序激活色 / 等等）都会自动跟随。CSS 变量名是 EP 的稳定 API，不绑定版本——升级 EP 后这套覆盖依然有效。

项目色板：

| 角色 | 颜色 | 用途 |
| --- | --- | --- |
| 藏青 | `#1e4d8b` | 主色（按钮、链接、激活态） |
| 蓝 | `#2c6cb8` | hover、辅按钮 |
| 浅蓝 | `#4a8fd6` | light-3 一档 |
| 极浅蓝 | `#eaf2fb` | light-9（背景、选中行底色） |
| 侧栏藏青 | `#1a3a6b` | 侧栏底色（比主色更深） |
| 内容灰 | `#f5f7fa` | 页面背景 |

### 死代码的教训

2026-08-22 之前，`src/styles/index.scss` 顶部有 `@forward 'element-plus/theme-chalk/common/var.scss' with (...)` 改 EP 主题色。**整仓没有任何文件 `@use '@/styles/index.scss'`**（只 `@use 'variables' as *`）——EP 编译时拿不到这些覆盖值，整套是死代码。该段已删除，注释留在 `index.scss` 顶部 2026-08-22 那块作为反面教材。

如果新功能想调主题色，直接改 `variables.scss` 的 `:root`，**不要**再写 `@forward` 覆盖。

## Element Plus 中文 locale

中文 locale 下沉到 `src/App.vue` 根级：

```vue
<template>
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn.mjs'
</script>
```

`<el-config-provider>` 本身由 `unplugin-vue-components` 自动解析，无需手动 import。`zh-cn.mjs` 走 es 模块路径而不是 `lib/umd/locale/lang/zh-cn`，可以 tree-shaking。

为什么不在 `main.ts` 里包 `<el-config-provider>`：`main.ts` 已经处理副作用（CSS import、事件监听、router / pinia 注册），locale 属于渲染层关注点下沉到 `App.vue`，影响范围更可控。

## `chunkSizeWarningLimit: 750`

`build.chunkSizeWarningLimit = 750` 对齐当前两个已知的合理重 chunk：

- `echarts` ~700KB（统计页用）
- `pdfjs-dist` ~560KB（PDF 预览用）

二者都是按需懒加载（不进 index chunk），不阻塞首屏。阈值调到 750 是为了对这两个已知合理 chunk 静音，避免每次 build 都看到红线。新引入的更大 chunk 仍会正常报警。

如果新加的依赖超出 750KB，要么走按需（`defineAsyncComponent` / 路由级 lazy import），要么走 CDN 外链。

## rolldown `INVALID_ANNOTATION` 警告过滤

vite.config.ts `build.rollupOptions.onwarn` 里有一段过滤：

```ts
onwarn(warning, defaultHandler) {
  if (
    warning.code === 'INVALID_ANNOTATION' &&
    typeof warning.id === 'string' &&
    warning.id.includes('@vueuse/core')
  ) {
    return
  }
  defaultHandler(warning)
},
```

背景：vite 8 / rolldown 替换 rollup 期间，`@vueuse/core` 的 dist 注释里 `/* #__PURE__ */` 位置 rolldown 不识别，触发 `INVALID_ANNOTATION` 警告。注释被忽略不影响产出正确性，只是 build log 噪音。过滤它**只是为了让未来 rolldown 修复后的真警告更容易被发现**——不是静默所有 warning。

等 `@vueuse/core` 上游修复或 vite 8 GA 后，可以整段移除。

## `@` 别名

```ts
// vite.config.ts
resolve: {
  alias: { '@': path.resolve(__dirname, 'src') },
}
```

```json
// tsconfig.json
"paths": { "@/*": ["src/*"] }
```

双侧配置确保运行时（vite 解析）与类型检查（`vue-tsc`）走同一份路径。引用示例：

```ts
import { useAuthSession } from '@/composables/useAuthSession'
import { pdfjsLib } from '@/utils/pdfjs'
```

不要在 `src/**` 内部用相对路径穿越多级（`../../../composables/...`），一律 `@/...`。
