# 生产域模块

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