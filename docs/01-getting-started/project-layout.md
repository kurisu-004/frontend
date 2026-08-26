# 项目目录结构

> **目标读者**：新人前端 / Agent 接手新模块
> **核心价值**：30 秒理解 `src/` 拓扑、各目录职责、关键文件位置
> **最后更新**：2026-08-26 · **维护者**：@frontend-team

---

## 顶层目录树

```
frontend/
├── docs/                   本目录所在的开发者文档
├── public/                 静态资源（图标、favicon）
├── src/                    全部源代码（详见下文）
├── Dockerfile              多阶段构建：node:24-alpine → nginx:1.30-alpine
├── entrypoint.sh           容器启动脚本（证书检测 + envsubst 渲染 nginx 配置）
├── nginx.conf              生产 HTTPS 主配置（含 /api/ 反代、/mcp deny-all）
├── nginx.http-only.conf    无证书时的 HTTP-only 降级配置
├── vite.config.ts          构建配置（dev 代理 / auto-import / optimizeDeps）
├── tsconfig.json           TS 配置（路径别名 @ → src）
├── package.json            依赖与 npm 脚本
├── CLAUDE.md               AI Agent 速查手册
└── README.md               30 秒上手
```

## src/ 顶层结构

> **关键提醒**：`src/modules/` **不存在**。业务模块目录是 `src/views/<domain>/`，**不要按 `src/modules/<domain>/` 找代码**。

```
src/
├── api/                    接口层 — 按业务域切分（17 个 .ts + parts/ 子目录）
├── components/             跨业务域通用组件（10+ 个）
├── composables/            模块级单例 composable（30+ 个）
├── constants/              静态映射（partStatus / batch / bid / crud / file）
├── layouts/                MainLayout 等布局
├── router/                 路由表 + 全局前置守卫
├── styles/                 全局样式 + 主题变量
├── types/                  业务类型定义
├── utils/                  工具函数（pdfjs / jwt / date / excel parsers）
├── views/                  业务模块（11 业务域）
├── App.vue                 根组件（中文 locale 下沉到这里）
├── main.ts                 应用入口（pinia / router / EP CSS 手动 import）
├── auto-imports.d.ts       unplugin 自动生成（已 git 跟踪）
└── components.d.ts         unplugin 自动生成（已 git 跟踪）
```

## src/views/ — 11 业务域归属表

业务模块以域为单位组织在 `src/views/<domain>/` 下。路由路径与路由 `meta.menuCode` 见 `src/router/index.ts`。

| 路径 | 一句话职责 | 主要 menuCode |
|---|---|---|
| `views/Dashboard.vue` | 首页大屏（WebSocket 实时推送） | `home` |
| `views/WorkerList.vue` | 工人花名册（**注意在 views 根目录**） | `workers_list` |
| `views/auth/Login.vue` | 登录（独立全屏路由树） | — |
| `views/parts/` | 零件 / 装配（核心域，含 11+ 详情子组件） | `parts_list` / `parts_new` |
| `views/inspection/` | 待品检一览 | `inspection_pending` |
| `views/repair/` | 返修接收 | `repair_receive` |
| `views/cnc/` | 待编程一览（CNC 编程员专属） | `pending_programming` |
| `views/assemblies/` | 装配件详情（老路由 `/assemblies` 已并入 `/parts`） | — |
| `views/outsource/` | 外协厂 / 报价 / 发送接收 / 对账 | `outsource_companies_list` / `outsource_quotes_list` / `outsource_send_receive_list` |
| `views/delivery/` | 送货单列表 / 详情 / v2 扫码建单 | `delivery_notes_manage` |
| `views/delivery-dispatch/` | 司机送货台（独立全屏路由树） | `delivery_dispatch` |
| `views/scan/` | 工位扫码台（独立全屏路由树） | `scan_badge`（守卫用 `allowRoles` 兜底） |
| `views/shelves/` | 货架管理 | `shelves_list` |
| `views/users/` | 账号管理（含角色分配） | `users_list` |
| `views/customers/` | 客户树 | `customers_list` |
| `views/applicants/` | 申请人主数据 | `applicants_list` |
| `views/settings/` | 工种 / 工序 / 映射 | `work_types_list` / `processes_list` / `work_type_processes_list` |
| `views/statistics/` | 生产统计（4 Tab） | `production_stats` |

> **老路径兼容**：`/assemblies` → 重定向到 `/parts`；`/outsource` → `/outsource/companies`；`/outsource/send` 与 `/outsource/receive` → `/outsource/send-receive`。不要新增新的重定向，老域往新域合并是既定方向。

## src/api/ — 接口层（17 文件 + parts/ 子目录）

按业务域切分，每个文件导出对应的 axios 调用函数。**v1 走 `api` 实例，v2 走 `apiV2` 实例**，新接口必须在 `apiV2` 上加。

| 文件 | 域 | v1 / v2 |
|---|---|---|
| `http.ts` | 双实例 + 拦截器 + 401 处理 | 共用基座 |
| `auth.ts` | 登录 / 刷新 / me | **v2** |
| `deliveryNote.ts` | 送货单 CRUD + 详情 + 扫码建单 | **v2** |
| `deliveryGroup.ts` | 送货组聚合 | **v2** |
| `parts.ts` | 兼容 shim，re-export `./parts/*` | — |
| `parts/` | 拆为 `crud.ts` / `batch.ts` / `bid.ts` / `file.ts` 4 子文件 | v1 + 部分 v2（`scanInspect` / `batchScanInspect`） |
| `dashboard.ts` | 首页大屏 + WebSocket 入口 | v1 |
| `outsource.ts` | 外协全流程 | v1 |
| `shelves.ts` | 货架管理 | v1 |
| `users.ts` | 账号 | v1 |
| `worker.ts` | 工人 | v1 |
| `customer.ts` | 客户 | v1 |
| `applicant.ts` | 申请人 | v1 |
| `assembly.ts` | 装配件 | v1 |
| `cnc.ts` | CNC 待编程 | v1 |
| `process.ts` | 工序 | v1 |
| `workType.ts` | 工种 | v1 |
| `statistics.ts` | 生产统计 | v1 |

## src/composables/ — 30+ 模块级单例

按字母表列出（一行说明）：

| 名称 | 职责 |
|---|---|
| `useActiveShelfSelection` | 工位扫码台的"当前货架"选中状态 |
| `useApplicantSearch` | 申请人下拉搜索（懒加载） |
| `useAuthSession` | 登录态 + token + 用户菜单（核心） |
| `useBarcodeScanner` | 扫码枪输入识别（Web Bluetooth / 键盘事件） |
| `useBulkPassInspection` | 批量通过品检（v2 端点） |
| `useBulkScanInspect` | 批量扫码送检（v2 端点） |
| `useColumnVisibility` | 表格列显隐持久化 |
| `useConfirm` | 全局 `ElMessageBox.confirm` 封装 |
| `useCustomerTree` | 客户树懒加载 |
| `useDeliveryNoteDetailCache` | 送货单详情页缓存（共享给列表 → 详情） |
| `useDeliveryScanState` | 扫码建单的扫码状态机 |
| `useDialogSize` | `el-dialog` 响应式 size（lg/md/sm/full） |
| `useHoldToScroll` | 长按加速滚动（扫码台选件列表用） |
| `useListFilterPersist` | 列表筛选条件持久化到 localStorage |
| `usePagedListQuery` | 分页查询的通用模板 |
| `usePartLocationTree` | 零件位置树（货架 → 库位） |
| `usePdfPageCount` | PDF 页数探测 |
| `usePermissions` | 权限工具（hasRole / hasMenuCode / canOperateShelf） |
| `usePooledDetail` | 详情页对象池（避免反复创建销毁） |
| `usePrintedLabels` | 已打印标签记录 |
| `useRowEditor` | el-table 行内编辑 |
| `useScanBus` | 扫码事件总线（跨组件传递扫码事件） |
| `useScanPartsSort` | 扫码选件的排序规则 |
| `useScanSession` | 扫码台的 worker session（核心） |
| `useShelfProcessFilter` | 货架工序筛选 |

**模式约定**：所有 composable 都是模块级 `ref` + 导出 `useXxx()`，调用方操作同一份响应式状态。详见 [02-architecture/state-management.md](../02-architecture/state-management.md)。**禁止新建 Pinia store**。

## src/components/ vs views/<domain>/components/

两类组件目录要分清：

- **`src/components/`** — 跨业务域通用组件：`Barcode` / `EChart` / `PdfViewer` / `FileListCard` / `PartListShell` / `PagedTable` / `HmiPickerCard` / `ShelfPickerCard` / `NotificationBanner` / `ColumnFilterPopover` / `ColumnVisibilityPopover` / `BeianFooter`（备案号）。
- **`src/views/<domain>/components/`** — 单业务域内组件，例：`views/parts/components/PartsTable.vue`、`views/parts/components/PartInfoCard.vue`、`views/delivery/components/DeliveryNoteDetail*.vue`。

判定原则：**被两个及以上业务域使用 → `src/components/`**；仅一个域用 → `views/<domain>/components/`。重构时遇到跨域复用需求，按此原则迁移。

## src/router/ — 路由表

单文件 `src/router/index.ts`（约 385 行）。所有路由 meta 字段：

- `title` — 面包屑 / 浏览器标题
- `icon` — Element Plus 图标名（侧栏菜单用）
- `breadcrumb` — 面包屑链
- `requireAuth` — 是否需要登录
- `menuCode` — 菜单权限 code（单一权限源）
- `allowRoles` — 角色兜底（仅 `/scan/*` 用，`SHELF_ACCOUNT` 必须能进但菜单树不含 `scan_badge`）

路由守卫三道检查：`requireAuth` → `allowRoles` → `menuCode` 降级。详见 [02-architecture/routing-and-permissions.md](../02-architecture/routing-and-permissions.md)。

## src/constants/ / src/types/ / src/utils/ / src/styles/ / src/layouts/

- `constants/` — 静态映射：`partStatus.ts`（零件状态枚举）/ `batch.ts` / `bid.ts` / `crud.ts` / `file.ts`。
- `types/` — 业务 TypeScript 类型：每个域一个文件（`parts.ts` / `deliveryNote.ts` / `outsource.ts` 等）。
- `utils/` — 工具函数：`pdfjs.ts`（PDF 渲染单点入口）/ `jwt.ts` / `date.ts` / `deliveryDate.ts` / `mergePdfs.ts` / `drawingFilename.ts` / 4 个 Excel parser（`bidExcelParser` / `historicalPriceExcelParser` / `purchaseOrderExcelParser` / `xlsxParseUtils`）。
- `styles/` — 全局样式与主题变量：`index.scss` / `variables.scss`（藏青 `#1e4d8b` 主题色覆盖 EP CSS 变量）。**已删除** `breakpoints.scss`（T1 重构）。
- `layouts/` — `MainLayout.vue`（侧栏 + 面包屑 + 顶栏），包裹大多数页面；`/scan/*` 与 `/delivery-dispatch/*` 与 `/login` 在外。

## 测试文件分布

- `src/**/*.spec.ts` — vitest 单测，与源码同目录或集中放 `src/utils/__tests__/`。
- 项目明确**不做组件测试**（不引入 testing-library）。
