# CLAUDE.md

myERP 工厂管理系统前端：Vite 8 + Vue 3 + TypeScript + Element Plus。详细文档见 [`docs/`](./docs/)（按域分组：架构 / 模块 / UI / 构建 / 测试 / API 需求）。专题内容请优先 Read 对应文档，不要只读本文件。

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

## 硬约束（agent 速查）

1. **不要新建 Pinia store**：共享状态用 composable 模块级单例（`useAuthSession` / `useScanSession` / `useBarcodeScanner` 模式）。
2. **不要写 `api.post('/v2/...')`**：新接口必须 `import { apiV2 } from '@/api/http'` 然后 `apiV2.post(...)`。
3. **雪花 ID 必须 string**：后端 ID > 2^53，`Number()` 丢精度（见 `useAuthSession.activeShelfId()`）。
4. **EP 命令式 API CSS 必须在 `src/main.ts` 手动 import**：`unplugin-auto-import` resolver 只扫 `<template>`，看不到 `<script setup>` 里的 `ElMessageBox` / `ElMessage` / `ElNotification` / `ElLoading`。
5. **不要删 `vite.config.ts` 的 `optimizeDeps.include`**：防止 dev 模式 dep discovery 触发整页 full-reload。
6. **不要直接 `import 'pdfjs-dist'`**：统一从 `@/utils/pdfjs` import `pdfjsLib`（workerSrc 缓存穿透版本串集中在这里）。
7. **auth 域 2026-08-26 已切 v2**：`/api/v2/auth/*` 是唯一目标；新增功能统一走 `apiV2`；v1 refresh_token 已作废（首登用户会被强制重登一次，由 40101/40103 兜底）。
8. **router `meta.menuCode` 必填**：单一权限源 = 后端菜单树，不填会被守卫误放行。

## 文档索引

按需 `Read` 对应文件，不要靠记忆：

- 入门：[`docs/01-getting-started/`](./docs/01-getting-started/)（项目结构 / 安装 / 约定）
- 架构：[`docs/02-architecture/`](./docs/02-architecture/)（api 契约 / 路由权限 / 状态管理 / 构建工具 / pdfjs）
- 业务模块：[`docs/03-modules/`](./docs/03-modules/)（11 个域，按业务切分）
- UI 与样式：[`docs/04-ui-and-styling/`](./docs/04-ui-and-styling/)（组件模式 / 设计 token / EP 集成 / 响应式）
- 构建部署：[`docs/05-build-and-deploy/`](./docs/05-build-and-deploy/)（开发 / docker / nginx / 发布 checklist 4 篇）
- 数据与 Excel：[`docs/06-data-and-excel/`](./docs/06-data-and-excel/)（Excel 解析 / PDF 与文件 2 篇）
- 测试：[`docs/07-testing/testing-strategy.md`](./docs/07-testing/testing-strategy.md)
- 已知风险：[`docs/08-known-risks/`](./docs/08-known-risks/)（依赖 / 安全运维 2 篇）
- 后端需求（给后端 agent）：[`docs/api-requirements/`](./docs/api-requirements/)

## API 文档路径

后端主仓已迁到 `~/Code/hsh-erp-rust`（Rust + axum + sqlx）。所有后端契约一律维护在 `~/Code/hsh-erp-rust/docs/api/`（按域切分：`auth.md` / `users.md` / `delivery-notes.md` / `delivery-groups.md` / `websocket.md` / `index.md` 通用约定）。需要查后端接口时直接 `Read` 对应文件，不要翻 `src/modules/*` 源码反推。

## 主题色

藏青 `#1e4d8b` / 蓝 `#2c6cb8` / 浅蓝 `#4a8fd6`，覆盖在 `src/styles/variables.scss` 的 `:root` 块里。

## 约定

- 代码注释、commit message、文档一律中文。
- 注释里带日期戳（如 `2026-08-26 新增`）说明变更缘由是本仓库的通行做法。

## 已知风险

- 依赖 `xlsx@0.18.5` 有原型污染 + ReDoS 高危漏洞（npm 官方无修复版本）。仅用于内部只读 Excel 解析（4 个 parser + 3 个视图统一收口，不执行公式/宏），攻击面可控。2026-08-21 决策保留，后续迁 SheetJS CDN 版或 exceljs。详见 [`docs/08-known-risks/dependency-risks.md`](./docs/08-known-risks/dependency-risks.md)。