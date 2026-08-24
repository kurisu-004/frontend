# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。从 `myERP/frontend` fork 出的独立仓库；全栈主仓在 `../myERP`（FastAPI 后端、docker-compose 编排都在那边）。

> **2026-08-24 起后端服务迁移**：今后新开发的后端服务都在 `~/Code/hsh-erp-rust`（Rust + axum + sqlx），对应的 API 文档在 `~/Code/hsh-erp-rust/docs/api/`（业务 REST 统一 `/api/v2`，与历史 Python `/api/v1` 并行运行；老 `v1` 仅作为兼容兜底，新功能不再走 v1）。前端 `src/api/` 下既有 `api`（v1）也有 `apiV2`（v2）两个 axios 实例，新增接口统一用 `apiV2`；migration 进度见 `docs/api/index.md` 的「未上线域」表。
>
> **API 文档路径**：新开发后端服务的契约一律维护在 `~/Code/hsh-erp-rust/docs/api/`（按域切分：`auth.md` / `users.md` / `delivery-notes.md` / `delivery-groups.md` / `websocket.md` / `index.md` 通用约定）；今后任何需要查后端接口的环节直接 `Read` 对应文件，不要去翻 `src/modules/*` 源码。

## 常用命令

```bash
npm run dev          # 开发服务器 :5173，/api 代理到 http://127.0.0.1:8000（FastAPI）
npm run build        # vue-tsc --noEmit && vite build（类型检查 + 构建）
npm run typecheck    # 只跑 vue-tsc 类型检查
npm run test         # vitest run（全部单测）
npx vitest run src/utils/__tests__/bidExcelParser.spec.ts   # 单个测试文件
npx vitest run -t "测试名"                                   # 按名称跑单个用例
docker build -t myerp-frontend .   # 多阶段镜像：node:24-alpine 构建 → nginx:1.30-alpine 托管
```

注意：Docker 镜像构建只跑 `npx vite build`（不做类型检查，见 Dockerfile 注释），类型检查靠 CI/本地的 `npm run typecheck`。

## 架构要点

### 后端契约（api/ 层的一切由此派生）

- 统一 axios 实例在 `src/api/http.ts`：baseURL `/api/v1`（v1 兼容用），另有 `apiV2`（baseURL `/api/v2`）承载 Rust 主仓（`~/Code/hsh-erp-rust`）的所有业务 REST——新接口必须在 `apiV2` 上加。响应是 `{code, message, data}` 信封——`code === 0` 时拦截器把 `response.data` 替换成裸 `data`；非 0 抛 `ApiError(code, message)`，调用方用 `(e as ApiError).code` 判断业务错误。
- 认证错误码：`40101`（未登录）/ `40102`（access 过期）/ `40103`（refresh 失效）。`40102` 会触发自动 refresh 并重试原请求（模块级 `refreshPromise` 防雪崩）；refresh 走无拦截器的 `refreshClient` 裸实例防递归。每次成功响应还会 proactive 检查 exp（剩余 <5min 后台刷新）。
- session 失效的统一出口：`window.dispatchEvent('auth:logout')` → `main.ts` 监听后 `router.replace('/login')`。拦截器不直接依赖 vue-router。
- 数组 query 参数默认序列化为 `?key=a&key=b` 重复形式（无 `[]` 后缀），与历史 FastAPI `/api/v1` 兼容；白名单 key（含 `statuses`）会自动序列化为 CSV 单值 `?statuses=A,B`，与 v2 后端期望对齐（见 `src/api/http.ts` 的 `ARRAY_AS_CSV_KEYS`）。
- **雪花 ID 精度**：后端 ID 是雪花 ID，超过 2^53，前端必须当 string 处理（`Number()` 会丢精度）。见 `useAuthSession.activeShelfId()` 注释。

### 状态管理：模块级 composable 单例（不是 Pinia）

虽然装了 pinia 并在 main.ts `app.use()`，但实际状态都在 composables 的模块级 ref 里（`useAuthSession`、`useScanSession`、`useBarcodeScanner` 同构）。新功能共享状态沿用这个模式，不要新建 pinia store。

- `useAuthSession`：localStorage key `auth_session` = `{token, refresh_token, user}`。提供 `hasRole` / `menus()` / `hasMenuCode` / `canOperateShelf`。监听 `auth:tokens-refreshed` 事件同步拦截器刷新后的新 token（CustomEvent 解耦，避免循环依赖）。

### 权限模型（router/index.ts 前置守卫，单一权限源 = 后端菜单树）

守卫按顺序执行三道检查：

1. `requireAuth`：未登录 → `refreshOrLogout()`（拉 `/auth/me` 验证）→ 失败去 `/login`。
2. `allowRoles`：用户有任一列出角色直接放行（用于 SHELF_ACCOUNT 进 `/scan/*` 这类 menuCode 会卡住的场景）。
3. `menuCode`：DFS 用户菜单树（`user.menus`，后端下发）查 code，查不到降级到菜单树第一个可达 path。

新增页面时：路由 meta 填 `menuCode`（与后端菜单表 code 对齐），菜单渲染和路由守卫共用这一份数据。角色有 `MANAGER` / `CLERK` / `INSPECTOR` / `SHELF_ACCOUNT` 等。

### 布局结构

- `MainLayout.vue`（侧栏 + 面包屑 + 顶栏）包裹大部分页面。
- `/scan/*`（工位扫码台）、`/delivery-dispatch/*`（司机送货台）、`/login` 是全屏独立路由树，在 MainLayout 之外。

### 构建配置的非显然点（vite.config.ts）

- `optimizeDeps.include` 显式列出重依赖（vue/axios/element-plus/xlsx 等）——防止 dev 模式进入 dep discovery 触发整页 full-reload，不要删。
- SCSS：每个 `<style lang="scss">` 自动注入 `@use "@/styles/breakpoints" as *;`，组件内可直接 `@include from(...)/until(...)` 断点 mixin，无需手动 import。
- Element Plus 按需加载靠 `unplugin-auto-import` + `unplugin-vue-components`（ElementPlusResolver），生成 `src/auto-imports.d.ts` / `src/components.d.ts`。两者都**只扫描 `<template>`**，自动注入对应 JS + CSS；`<script setup>` 里的程序式 API（`ElMessageBox` / `ElMessage` / `ElNotification` / `ElLoading`）resolver 看不到，相关 CSS 必须在 `src/main.ts` 手动 import（见那里 2026-08-22 那块注释）。
- 中文 locale 下沉到 `src/App.vue` 的 `<el-config-provider :locale="zhCn">`；项目主题色（藏青 #1e4d8b）在 `src/styles/variables.scss` 的 `:root` 块里直接覆盖 EP 的 `--el-color-primary*` 系列 CSS 变量（2026-08-22 新增）—— EP 2.14.x 还没有 `theme` prop（见 EP 官方 Config Provider 文档），这是当前唯一可行的官方推荐方式。`src/styles/index.scss` 顶部**不再**用 `@forward` 改 EP 主题色（之前是死代码，无 `@use` 消费者，已删）。
- 别名 `@` → `src`（vite + tsconfig paths 双侧配置）。

### pdfjs 单点配置（src/utils/pdfjs.ts）

所有 PDF 渲染必须从这里 import `pdfjsLib`，**不要**直接 `import 'pdfjs-dist'`：

- workerSrc 带缓存穿透版本串 `PDF_WORKER_CACHE_BUST`（历史上 nginx 错配 .mjs MIME 导致 worker 被 immutable 缓存整年；再遇类似缓存中毒就递增版本串）。
- CJK PDF 需要 cMap：`PDF_CMAP_OPTIONS` 在 `getDocument()` 时传入。

### 测试

vitest（node 环境），只测纯函数/单例（`src/**/*.spec.ts`，集中在 `utils/__tests__/` 和 `api/dashboard.spec.ts`）。**项目明确不做组件测试**（不引入 testing-library）。

## 部署（Docker + nginx）

- `Dockerfile` 两阶段：`node:24-alpine` 构建 dist → `nginx:1.30-alpine` 托管。
- `entrypoint.sh`（容器启动时）：SSL 证书存在 → 用 `nginx.conf`（HTTP 301 + HTTPS 主服务）；不存在 → 换 `nginx.http-only.conf`。然后用 envsubst 渲染 4 个占位符（`NGINX_SERVER_NAME` / `NGINX_REDIRECT_TARGET` / `SSL_CRT_FILENAME` / `SSL_KEY_FILENAME`），值由 docker-compose 注入（在主仓 myERP）。
- nginx 反代 `/api/` → `backend:8000`，`client_max_body_size 300m`（批量 PDF 上传），WebSocket upgrade 已配。
- **MCP 端点（`/api/mcp*`、`/mcp`）在 nginx 层 deny all**——应用层无鉴权，安全完全靠 nginx + 云安全组。改这几条 location 前必读 nginx.conf 里的匹配细节注释（`^~` 不能省、尾斜杠、正则优先级）。
- `.mjs` 有专门的 location 块声明 `application/javascript`（pdf worker，见 pdfjs.ts 背景注释）。

## 约定

- 代码注释、commit message、文档一律中文。注释里带日期戳（如 `2026-07-10 新增`）说明变更缘由是本仓库的通行做法。
- Element Plus 中文 locale（zh-CN），主题色：藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`。

## 已知安全风险

依赖 `xlsx@0.18.5` 存在原型污染与 ReDoS 高危漏洞（npm audit: high），npm 官方仓库无修复版本（SheetJS 新版只通过自己的 CDN 分发，未发布到 npm）。本系统仅将 xlsx 用于内部上传 Excel 的只读解析（4 个 parser 工具函数 + 3 个视图统一收口，不执行公式/宏），攻击面可控。经评估保留该版本并承担风险（2026-08-21 决策）；后续如迁移到 SheetJS CDN 版或 exceljs，再行消除。
