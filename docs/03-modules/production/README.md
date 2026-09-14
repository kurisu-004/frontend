# 生产域模块

## 工序工种（`/production/process-work-type`）

**menuCode**: `process_work_type`
**权限**: MANAGER / CLERK / INSPECTOR（见后端 migration 021 授权脚本）
**状态**: 2026-09-12 上线（替代原 `/settings/{work-types,processes,work-type-processes}` 三菜单）

### 入口

- 路由：`/production/process-work-type`
- 组件：`src/views/production/ProcessWorkTypePage.vue`（tabbed shell）
- 侧栏路径：生产管理 → 工序工种

### Tab 组成

1. **工种管理**（默认 tab）— `WorkTypeTab.vue`，工种 CRUD
2. **工序管理** — `ProcessTab.vue`，工序 CRUD；含 `t_process.color` 字段
3. **工序映射** — `ProcessWorkTypeMappingTab.vue`，工种 ↔ 工序 多对多映射

### URL 同步

`?tab=work-types|processes|mapping` 记忆上次选择；初次进入默认 `work-types`。

### 后端依赖

- `GET/POST /api/v1/work-types` / `GET/POST /api/v1/work-types/{id}/update` / `POST /api/v1/work-types/{id}/soft-delete`
- `GET/POST /api/v1/processes` / `GET/POST /api/v1/processes/{id}/update` / `POST /api/v1/processes/{id}/soft-delete`
- `GET/POST /api/v1/work-types/{id}/processes`
- `t_process.color VARCHAR(9)`：格式 `#RRGGBBAA`，9 字符（Element Plus `el-color-picker color-format="hex8"` 默认输出）。

### 工序卡片颜色

- 表单字段：`<el-color-picker color-format="hex8" />`，输出 9 字符 hex（带 alpha 通道）
- 表格列：固定在「操作」列之前，宽度 80，渲染 24×24 色块
- NULL 时显示默认灰色 `#ddd`

## 生产队列看板（`/workers/queue`）

**menuCode**: `worker_queue`
**权限**: Manager
**状态**: 2026-09-14 mock 阶段（后端 5 个 endpoint 待补，fixture 阶段跑通）

### 入口

- 路由：`/workers/queue`
- 组件：`src/views/workers/WorkerQueueBoard.vue`
- 侧栏路径：**生产管理** → 生产队列（原"权限管理"breadcrumb，2026-09-11 重命名，commit `ac6c436`）

### 后端依赖

- `GET /api/v2/admin/worker-pool/workers` — 工人列表（待补）
- `GET /api/v2/admin/worker-pool/pools` — 工序 pool（待补）
- `GET /api/v2/admin/worker-pool/workers/{id}/held` — 工人持有（待补）
- `POST /api/v2/admin/worker-pool/assign` — 分配（待补）
- `POST /api/v2/admin/worker-pool/return` — 撤回（待补）

详细规格见 [`docs/api-requirements/worker-pool.md`](../../api-requirements/worker-pool.md)。Phase 1 跑 fixture（`src/api/__fixtures__/workerPool.fixtures.ts`），Phase 2 切 apiV2。

### 交互

- 左侧 PoolDrawer 按工序分组待领取工单
- 右侧 WorkerColumn[] 一列一个工人
- 拖拽工单卡片在 pool ↔ worker 间移动，乐观更新
- 拖到 capacity 满的工人会拒绝并回滚
- 顶部 tabs（待领取 / 进行中 / 已完成）切换 WorkerColumn 状态
- `useColumnDrag` + `useLazyDraggable` 双基建：`useColumnDrag` 走 EP 表头 `MutationObserver` 自愈，`useLazyDraggable` 兜底 `v-if` 内 `null` 容器
- 主区域使用 `el-splitter` 二分栏布局（pool / worker 列宽度持久化）
- `WorkOrderCard.vue` 2026-09-11 重设计：信息密度提升 + 状态徽章合并

## 工序制定页（`/production/process-design`）

**menuCode**: `process_design_list`
**权限**: Manager
**状态**: 2026-09-14 phase 1（fixture 阶段，前端 UI 与交互定稿；phase 2 实接 apiV2）

### 入口

- 路由：`/production/process-design`
- 组件：`src/views/production/ProcessDesignView.vue`（三栏 splitter shell）
- 侧栏路径：生产管理 → 工序制定

### 三栏结构

| 栏位                       | 组件                              | 职责                                       |
| -------------------------- | --------------------------------- | ------------------------------------------ |
| 左 — 零件列表              | `components/PartPickerList.vue`   | 列出所有可制定工序的零件（fixture/数据源） |
| 中 — 图纸预览              | `components/DrawingPreviewPane.vue` | pdfjs 渲染选中零件的图纸 PDF                |
| 右 — 工序步骤卡片列表      | `components/ProcessStepCardList.vue` | 工序拖拽排序、新增 / 编辑 / 删除          |

`useResizablePane` 持久化 splitter 宽度到 localStorage，刷新后保留用户习惯。

### composable

- `src/views/production/composables/usePartProcessDesign.ts` — 跨三栏共享的「当前零件 + 工序步骤列表」响应式状态
- 单测在 `src/views/production/__tests__/usePartProcessDesign.spec.ts`，覆盖 fixture 加载 / 步骤顺序变更 / 步骤增删等分支

### fixture vs apiV2 边界

- **phase 1（当前）**：数据源走 `src/views/production/__fixtures__/partProcess.fixtures.ts`，前端 UI / 交互定稿；后端契约对齐中（后端 endpoint 暂未上线）
- **phase 2（待）**：切到 apiV2（v2 Rust 后端的 process-design 域），`usePartProcessDesign` 内部把 fixture 调用换成 `apiV2.get/post(...)`，单测更新 mock axios 适配器

### 关键约束

- **雪花 ID 必须 string**：`partId` / `processId` 都按 string 传，不要 `Number()`
- **不强制要求所有零件有图纸**：无图纸的零件中间栏降级显示「未上传图纸」占位
- **步骤排序改动**：拖拽后只改本地 state，落库需点「保存」按钮（避免每帧请求风暴）
