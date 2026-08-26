# 环境准备与首次运行

> **目标读者**：首次跑通项目的前端 / 部署运维
> **核心价值**：环境准备、三仓关系、依赖安装、首次 dev 注意事项、常见启动问题
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 环境要求

| 工具 | 版本 | 备注 |
|---|---|---|
| Node | 24+ | 与 `Dockerfile` 一致（`node:24-alpine`） |
| npm | 10+ | 跟随 Node 24 自带 |
| pnpm / yarn | **不推荐** | 仓库锁的是 `package-lock.json`，其他包管理器不会复用 lockfile |
| Docker | 24+ | 仅部署需要；本地开发不依赖 |
| Git | 2.30+ | worktree 功能需要 |

Node 18 / 20 没测过，理论上 vite 8 要 Node 20+，但 CI 与 Docker 都跑 24，强烈建议对齐。

## 三仓关系

后端双轨决定了本地需要两个后端仓 + 一个前端仓：

| 仓 | 路径 | 端口 | 说明 |
|---|---|---|---|
| 前端 | `/Users/ren/Code/frontend` | 5173 | 本仓 |
| 主仓（v1 后端） | `/Users/ren/Code/myERP` | 8000 | FastAPI，历史业务域 |
| Rust 主仓（v2 后端） | `/Users/ren/Code/hsh-erp-rust` | 3000 | axum + sqlx，新功能域（auth / deliveryNote / scanInspect 等） |

后端契约统一维护在：

```
~/Code/hsh-erp-rust/docs/api/
├── index.md          # 通用约定（信封、错误码、版本）
├── auth.md           # 登录 / 刷新 / me
├── users.md
├── delivery-notes.md
├── delivery-groups.md
└── websocket.md
```

> 前端 `src/api/` 下 `api`（v1）与 `apiV2`（v2）两个 axios 实例并存，**新接口必须走 `apiV2`**，迁移进度见 `docs/03-modules/README.md` 的 v1/v2 迁移表。

## 首次安装

```bash
cd /Users/ren/Code/frontend
npm ci
```

`npm ci` 严格按 `package-lock.json` 安装，不修改 lockfile。**不要**用 `npm install`（会重新解析依赖、改 lockfile、可能引入意外升级）。

安装时间约 1-3 分钟，体积较大（`element-plus` + `echarts` + `pdfjs-dist` + `xlsx` 几个重依赖）。

## 开发运行

```bash
npm run dev
```

启动后访问 `http://localhost:5173`。

`vite.config.ts` 的 dev 代理配置：

| 前端路径 | 代理目标 | 用途 |
|---|---|---|
| `/api` | `http://127.0.0.1:8000` | v1 FastAPI 主后端（默认走 `src/api/*.ts` 里的 `api` 实例） |

> `/api/v2/*` 也走这条规则落到 `:8000`。v2 实际由 Rust :3000 提供，端到端路由取决于 `myERP` 后端 docker-compose 与 nginx 的实际配置（前置 nginx 可能再反代到 Rust）。本地仅跑 Rust 不跑 FastAPI 时需要自行调整代理规则；常见做法是把 Rust 也起在 :8000（FastAPI 让出端口）或在前置加一层 nginx。

## 首次 dev 后自动生成

unplugin-auto-import / unplugin-vue-components 在首次 `npm run dev` 时会扫描 `<template>` 自动生成两个 d.ts：

- `src/auto-imports.d.ts` — Vue 组合式 API / EP 命令式 API 的自动 import 类型
- `src/components.d.ts` — EP 组件的全局注册类型

**这两个文件已 git 跟踪**（不在 `.gitignore` 里）。首次 dev 后 unplugin 可能因为版本更新重新生成（diff 通常只是新加了几行 import），建议 commit 时一并提交。

## 常用 npm 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | vite dev server（`:5173`，HMR） |
| `npm run typecheck` | `vue-tsc --noEmit` — 只跑类型检查，不出 dist |
| `npm run build` | `vue-tsc --noEmit && vite build` — 类型检查 + 生产构建 |
| `npm run preview` | vite preview — 本地预览 dist |
| `npm run test` | vitest run — 全部单测 |

Docker 镜像构建只跑 `npx vite build`（不做类型检查，靠 CI / 本地 `npm run typecheck` 兜底），见 `Dockerfile` 注释。

## 常见启动问题

### 端口 5173 被占用

修改 `vite.config.ts` 的 `server.port`；或者停掉占用进程。

### 后端没起来 → `/api/*` 全 502

dev 期常见，不影响前端 HMR。等后端起来就好。如果想脱离后端纯看前端 UI，可以临时把 axios 拦截器里的 baseURL 改成 mock（项目当前没有内置 mock 系统，需要后端给 mock 数据）。

### `auto-imports.d.ts` 找不到 / 报类型错误

通常是首次 dev 还没跑过。`npm run dev` 启动一次就会生成；如果是 CI 环境跑 `npm run typecheck` 报这个错，先 `npm run dev` 一次让文件落地，或在 build 前手动 touch。

### 滚动异常 / 弹窗样式错乱 / 按钮纵向堆叠

99% 是 Element Plus 命令式 API 的 CSS 没加载。检查 `src/main.ts` 顶部手动 import 的 5 个 CSS：

```
element-plus/theme-chalk/el-message-box.css
element-plus/theme-chalk/el-message.css
element-plus/theme-chalk/el-notification.css
element-plus/theme-chalk/el-loading.css
element-plus/theme-chalk/el-overlay.css
```

详见 [02-architecture/build-and-tooling.md](../02-architecture/build-and-tooling.md) 中"EP 命令式 API CSS 手动加载"段。

### SCSS 编译错误 / `breakpoints` 找不到

历史项目曾用 `@use "@/styles/breakpoints" as *;` 的 mixin 语法。T1 重构后已删除，组件内统一改用裸 `@media (min-width: 768px)`（沿用 EP 默认 sm/md/lg 阈值）。如遇到 mixin 相关编译错误，按错误提示改成裸 `@media` 即可。

### PDF worker 加载失败 / `.mjs` MIME 错

dev 期少见，多发于 nginx 部署后。详见 [02-architecture/pdf-integration.md](../02-architecture/pdf-integration.md)。

### 自动刷新 / full-reload 频繁

vite 进入 dep discovery 模式时常见症状。检查 `vite.config.ts` 的 `optimizeDeps.include` 列表是否齐全（vue / axios / element-plus / xlsx 等），不要删。
