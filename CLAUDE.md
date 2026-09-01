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
7. **auth 域 2026-08-26 临时回滚 v1**：`/api/v1/auth/*` 是当前目标；新增 auth 功能统一走 `api`（v1）。**已知 trade-off**：v2 业务端点（**仅服务于 `src/views/delivery/DeliveryNoteScan.vue` 扫码建单页 + 其路由 B 间接依赖的 inspection 流程**，共 14 个 / 4 个文件）仍走 `apiV2`，拿到 v1 JWT 会在 `get_current_user` 处 40101，由 `auth:logout` 兜底重登：
   - `src/api/deliveryNote.ts`（7 个）：`scanDelivery` / `getNote` / `submitNote` / `listNotes` / `batchGetNotes` / `removeParts` / `softDeleteNote`
   - `src/api/deliveryGroup.ts`（4 个）：`listDeliveryGroups` / `createDeliveryGroup` / `updateDeliveryGroup` / `softDeleteDeliveryGroup`（**整文件 v2**，DeliveryNoteScan 是唯一消费者）
   - `src/api/parts/crud.ts`（1 个）：`toShip`
   - `src/api/parts/batch.ts`（2 个）：`batchToInspection` / `batchToShip`
   
   其余 `deliveryNote.ts` 端点（`printNote` / `printNoteLabels` / `listPickupPending` / `createNote` / `listNoteEvents` / `updateNote` / `addParts` / `recallNote` / `pickupScan` / `pickup` / `listCandidateParts`，2026-08-29 回退）+ `parts` 单件送检（`toInspection`，2026-09-01 回退到 `POST /api/v1/parts/{id}/receive-from-outsource-to-inspection`，仅支持 OUTSOURCE → INSPECTION；payload schema 用 `shelf_id`，无 `version`）+ `parts` 品检打回（`failInspection`，2026-08-29 回退）走 v1 Python FastAPI。新增 v2 端点前先确认调用方是否为 DeliveryNoteScan 及其传递依赖（`useBulkScanInspect` / `useBulkPassInspection` / `useDeliveryScanSubmission` / `useDeliveryDraftBoard`），否则一律走 v1。**待 v1 业务端点迁完再统一切回 v2**（详见 `docs/02-architecture/api-contract.md`）。另：`http.ts` 已按 baseURL 拆 `serializeParamsV1` / `serializeParamsV2` 各自绑定（2026-08-29），新增端点若带数组参数按 baseURL 版本选 serializer，详见 [`docs/08-known-risks/framework-pitfalls.md`](./docs/08-known-risks/framework-pitfalls.md) 第 7 节。
8. **router `meta.menuCode` 必填**：单一权限源 = 后端菜单树，不填会被守卫误放行。
9. **dummy-auth 只能 dev 模式用**：`npm run dev:dummy`（=`vite --mode dummy`，自动加载 `.env.dummy` → 注入 `VITE_DUMMY_AUTH=true`）仅本地调试用。**不要**写 `npm run dev -- --dummy-auth`（cac 拒绝未知 flag，会崩）。三层 prod 保护已就位：`vite build` + `VITE_DUMMY_AUTH=true` → 硬 throw / `import.meta.env.DEV` guard + `VITE_DUMMY_AUTH === 'true'` 双判定 / 不写 localStorage。任何 prod bundle 不应含 dummy-auth 注入路径（grep `initDummyAuth` 仅命中 dev 调用点 + `useAuthSession` 函数定义）。判定逻辑统一收敛在 `useAuthSession.isDummyAuthRequested()`（2026-08-28 重写，详见 [`docs/08-known-risks/framework-pitfalls.md`](./docs/08-known-risks/framework-pitfalls.md) 第 6 节）。
10. **容器可能为 null 的拖拽点必须用 `useLazyDraggable`**：`vue-draggable-plus` 的 `useDraggable` 默认 `immediate: true`，会在 `onMounted` 里对 null 元素 `new Sortable(null)` 抛错。容器在 `v-if` 内 / `el-dialog destroy-on-close` 后重建 / el-table `tbody` 需查询才拿得到 → 用 `@/composables/useLazyDraggable`；容器挂载时已无条件存在才可直接 `useDraggable`。给 ref 赋值即触发重绑，**不要**再手动调 `start()`。
11. **el-table 列插槽里依赖 `row.xxx` 的动态绑定要加空值守卫**：EP 会用合成空行 `{ row: {} }` 额外渲染每列 `#default` 一次并真的挂载（`.hidden-columns`），`:to` 动态的 `router-link` 会因此拼出 `/parts/undefined`。详见 [`docs/08-known-risks/framework-pitfalls.md`](./docs/08-known-risks/framework-pitfalls.md)。
12. **el-table 列拖动统一 `drag.applyDrag(tableRef)`，不要自己解析表头 DOM**：`useColumnDrag` 内部已经接 EP 表头重建自愈（`MutationObserver` 挂在 `.el-table` 根上、只听 `childList+subtree`），任何把 `findElTableHeaderRow(tableRef.$el)` 留在 consumer 里、null 守卫跳过、派生 `headerRowRef` 再 watch 的旧写法都会丢自愈——必须直接把 el-table 组件 ref 传进去。列 `v-for` 必须 `:label-class-name="drag.dragLabelClass(d)"`（不打 `col-draggable` / `col-key-<key>` 就进不了 sortablejs 索引序列）。详见 [`docs/08-known-risks/framework-pitfalls.md`](./docs/08-known-risks/framework-pitfalls.md) 第 4 节。
13. **`h()` 给原生元素传 children 不能用函数**：`h('span', props, () => X)` / `h('router-link', props, X)` 都是坏的——前者 Vue 3 的 `normalizeChildren` 会把函数当 slots（`SLOTS_CHILDREN`），而 `mountElement` 只处理 `TEXT_CHILDREN`/`ARRAY_CHILDREN`，元素渲染为空；后者 `h()` 传字符串 type 不做组件解析，会渲染成字面自定义元素。组件用法 `h(ElTag, props, () => X)` 是正确的（slots 走组件分发）。`src/composables/__tests__/nativeVnodeChildren.spec.ts` 是回归守卫单测，命中即失败。详见 [`docs/08-known-risks/framework-pitfalls.md`](./docs/08-known-risks/framework-pitfalls.md) 第 5 节。

## 文档索引

按需 `Read` 对应文件，不要靠记忆：

- 入门：[`docs/01-getting-started/`](./docs/01-getting-started/)（项目结构 / 安装 / 约定）
- 架构：[`docs/02-architecture/`](./docs/02-architecture/)（api 契约 / 路由权限 / 状态管理 / 构建工具 / pdfjs）
- 业务模块：[`docs/03-modules/`](./docs/03-modules/)（11 个域，按业务切分）
- UI 与样式：[`docs/04-ui-and-styling/`](./docs/04-ui-and-styling/)（组件模式 / 设计 token / EP 集成 / 响应式）
- 构建部署：[`docs/05-build-and-deploy/`](./docs/05-build-and-deploy/)（开发 / docker / nginx / 发布 checklist 4 篇）
- 数据与 Excel：[`docs/06-data-and-excel/`](./docs/06-data-and-excel/)（Excel 解析 / PDF 与文件 2 篇）
- 测试：[`docs/07-testing/testing-strategy.md`](./docs/07-testing/testing-strategy.md)
- 已知风险：[`docs/08-known-risks/`](./docs/08-known-risks/)（依赖 / 安全运维 / 框架陷阱 3 篇）
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