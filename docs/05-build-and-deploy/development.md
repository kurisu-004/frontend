# 开发与构建命令

> **目标读者**：新人 / Agent
> **核心价值**：把 `npm run dev` / `build` / `typecheck` / `preview` / `test` 五个脚本的差异、vite proxy 行为、常见 dev 故障一次性讲清
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 五个 npm scripts 速查表

`package.json` 里只暴露这五个脚本。每个脚本对应一种工作场景，混用会导致 dev 能跑、生产构建挂；或反过来。

| 命令 | 用途 | 何时用 |
|---|---|---|
| `npm run dev` | 启动 vite dev server（监听 `:5173`，带 HMR + `/api` proxy） | 日常开发 |
| `npm run typecheck` | 只跑 `vue-tsc --noEmit`，不做产物构建 | 改完类型想快速验证，不想等完整 build |
| `npm run build` | `vue-tsc --noEmit && vite build`：先类型检查再产出 `dist/` | CI / 上线前 |
| `npm run preview` | `vite preview`，本地起静态服务预览 `dist/` | 构建完想看生产产物效果 |
| `npm run test` | `vitest run`（node 环境，只跑纯函数/单例测试） | 改完 utils / api 跑回归 |

## dev 模式行为

`npm run dev` 直接调 vite，没有前置类型检查。这意味着你保存一个 `.vue` 文件里把 `ref<number>()` 写成 `ref()`，浏览器 console 会报但 dev server 不会拒绝——上线 build 才会暴露。

dev server 的关键行为：

- **HMR 支持**：`.vue` SFC、SCSS、`src/` 下的 TS 修改即时热替换，无需手动刷新。修改 `vite.config.ts` / `index.html` / `package.json` 不在 HMR 范围内，需要手动重启 dev server。
- **`/api` 反代**：见 `vite.config.ts` 的 `server.proxy`，所有 `/api/*` 请求被转到 `http://127.0.0.1:8000`（FastAPI dev backend）。后端没起就 502——这是新人最常踩的"页面空白 + 控制台报 502"的根因。
- **监听 `0.0.0.0:5173`**：host 不是默认的 localhost，方便容器 / WSL / 局域网内同事直接访问。
- **首次启动慢**：第一次访问任意页面时 vite 会跑 dep pre-bundle（optimizeDeps）生成 `.vite/deps/` 缓存；后续 reload 几乎即时。预热过的依赖列表见下文。

启动后 `src/` 下会生成两个自动生成的类型声明文件，由 unplugin 自动 import 写出：

- `src/auto-imports.d.ts`（vue / vue-router / @vueuse 的程序式 API 类型）
- `src/components.d.ts`（`<el-*>` 组件的全局注册类型）

这两个文件**不要手动编辑**——dev 启动会重新覆盖。commit 时建议加进 `.gitignore` 或随项目约定走（当前仓库是随 commit，方便新人 clone 后立刻得到类型）。

## build 模式行为

`npm run build` = 类型检查 + 生产构建，按这个顺序串行：

1. `vue-tsc --noEmit` —— 全量走 TS 类型检查，错误立即非零退出，**build 不会执行**。
2. `vite build` —— 通过后才会触发。走 Rollup（vite 8 已迁到 rolldown 作为底层），输出到 `dist/`：hashed JS / CSS、自动代码分割、tree-shake、压缩。

Dockerfile 镜像构建阶段**只跑 `npx vite build` 不做类型检查**（见 `docker.md`）。这是有意的设计：CI 负责类型检查（见 `07-testing/` 的 CI 说明），Docker 只负责产物体积——把类型检查失败挡在 push 之前的更上游环节。

## vite.config.ts 关键配置

### `optimizeDeps.include`

显式列出 `vue` / `vue-router` / `pinia` / `axios` / `element-plus` / `@element-plus/icons-vue` / `xlsx` 这些重依赖。**不要删**：vite 在首次访问某个页面时如果发现 import 的依赖不在 include 列表里，会进入 dep discovery 模式，触发 `[optimizer] bundling dependencies...` + 浏览器 full-reload。把常用依赖 pre-bundle 后整个 dev session 稳定。

### `chunkSizeWarningLimit: 750`

vite 默认告警阈值 500kB。统计页（echarts ~700kB）+ PDF 预览（pdfjs ~560kB）属于合理的重懒加载 chunk，调到 750 避免重复告警。新超 750 的 chunk 仍会正常报警。

### rolldown `INVALID_ANNOTATION` 过滤

vite 8 底层从 rollup 切到 rolldown，迁移期 `@vueuse/core` 的 dist 里含有 rolldown 不识别的 `/* #__PURE__ */` 注解位置，触发噪音告警。`build.rollupOptions.onwarn` 里写了一个白名单：来自 `@vueuse/core` 的 `INVALID_ANNOTATION` 直接 return，让真警告浮出。

### 路径别名 `@`

`resolve.alias['@'] = src/`，与 `tsconfig.json` 的 `paths` 双侧配置一致——单独改一边会导致 TS 类型能找到但 vite 找不到（反之亦然），表现为 dev 能跑但 build 报模块未找到。

## dev / build 行为差异

| 维度 | dev | build |
|---|---|---|
| 模块加载 | ESM 即时编译，浏览器按需 import | Rollup 全量打包 + tree-shake |
| 代码分割 | 无（单 SPA 入口） | `splitChunks` 按 import 边界自动切 |
| Source map | 内联（开发期可读） | 单独 `.js.map` 文件（生产期按需启用） |
| HMR | 支持 | 不涉及 |
| 类型检查 | 不跑 | 跑（前置 vue-tsc） |
| EP CSS | 按需注入（resolver 扫到 `<template>` 才注） | 按需注入 + 提取到独立 chunk |

## 常见 dev 问题排查

### 后端 502

浏览器 console 报 `net::ERR_CONNECTION_REFUSED` 或 vite 报 `proxy error`。检查本机 `:8000` 是否有 FastAPI 进程在跑（uvicorn / docker compose）。dev proxy 不重启：后端起来后刷新页面即可。

### 改了 `vite.config.ts` 没生效

vite config 修改需要重启 dev server（HMR 不覆盖 config）。`Ctrl+C` 再 `npm run dev`。

### Element Plus 主题色不生效

EP 2.14.x 还没有 `theme` prop，主题色统一在 `src/styles/variables.scss` 的 `:root` 块覆盖 `--el-color-primary` / `--el-color-primary-light-3` 等 CSS 变量。检查：

1. `:root` 块变量是否被覆盖到期望的藏青 `#1e4d8b`。
2. `src/main.ts` 是否引入了 `element-plus/dist/index.css`（程序式 API 需要的 CSS，resolver 扫不到）。
3. `src/App.vue` 顶层 `<el-config-provider :locale="zhCn">` 是否包住了整个应用。

### 首次 dev 启动慢

依赖 pre-bundle 只在第一次跑。检查 `.vite/deps/` 是否被全局清理（不要 `rm -rf node_modules/.vite` 重现问题）。如果某个新加的重依赖没列进 `optimizeDeps.include`，每次新增页面都会触发一次 dep discovery → full-reload。

### 类型错误但 dev 能跑

正常。dev 用 esbuild 转译时**不**做检查——`vue-tsc` 的错误只会在 `npm run build` / `npm run typecheck` 时暴露。改完类型一定要跑一次 typecheck 确认。