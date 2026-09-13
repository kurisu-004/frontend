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

## 工人队列调度看板（`/workers/queue`）

**menuCode**: `worker_queue`
**权限**: Manager
**状态**: 2026-08-26 mock 阶段（后端 3 个 endpoint 待补）

### 入口

- 路由：`/workers/queue`
- 组件：`src/views/workers/WorkerQueueBoard.vue`

### 后端依赖

- `GET /api/v2/admin/worker-pool/workers` — 工人列表（待补）
- `GET /api/v2/admin/worker-pool/pools` — 工序 pool（待补）
- `GET /api/v2/admin/worker-pool/workers/{id}/held` — 工人持有（待补）
- `POST /api/v2/admin/worker-pool/assign` — 分配（待补）
- `POST /api/v2/admin/worker-pool/return` — 撤回（待补）

详细规格见 [`docs/api-requirements/worker-pool.md`](../../api-requirements/worker-pool.md)。

### 交互

- 左侧 PoolDrawer 按工序分组待领取工单
- 右侧 WorkerColumn[] 一列一个工人
- 拖拽工单卡片在 pool ↔ worker 间移动，乐观更新
- 拖到 capacity 满的工人会拒绝并回滚
