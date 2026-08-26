# Worker-Pool 域接口需求（前端 ↔ Rust 后端）

> **状态**：待后端实现。前端当前 mock（详见 `src/api/workerPool.ts` + `__fixtures__/workerPool.fixtures.ts`）。
> 起草日期：2026-08-26，对应前端任务：工人队列调度看板。

## 背景

现有 `/Users/ren/Code/hsh-erp-rust/docs/api/worker-pool.md` 只暴露：
- `GET /api/v2/worker-pool/state`（仅返回计数）
- `POST /api/v2/admin/worker-pool/refill`（自动按 `max_held` 抢多张）
- `POST /api/v2/admin/worker-pool/remove`（RETURNED 语义，非单纯撤回）

管理员调度看板需要**精确控制单张工单的分配 / 撤回**，下面 4 个 endpoint 必须新增。

## 待新增 Endpoint

### 1. `GET /api/v2/admin/worker-pool/workers`

- **权限**：Manager
- **Query**：`shelf_id: string`（必填，i64 雪花）
- **Response.data**：`Worker[]`（字段定义见前端 `src/types/workerPool.ts`，含 `current_held` / `capacity_remaining`）

### 2. `GET /api/v2/admin/worker-pool/pools`

- **权限**：Manager
- **Query**：`shelf_id: string`
- **Response.data**：`ProcessPoolView[]`（字段定义见前端 `src/types/workerPool.ts`）

### 3. `GET /api/v2/admin/worker-pool/workers/{worker_id}/held`

- **权限**：Manager
- **Path**：`worker_id: string`（雪花）
- **Response.data**：`{ worker_id: string, held: WorkOrderCard[] }`

### 4. `POST /api/v2/admin/worker-pool/assign` （新增）

- **权限**：Manager
- **Body**：`AssignRequest { worker_id, batch_id, shelf_id, process_id }`
- **Response.data**：`WorkOrderCard`（`version+1`）
- **错误**：
  - `20201` worker 不存在
  - `20206` 工人 capacity 满（`current_held >= max_held`）
  - `20101` batch 不存在
  - `40001` 参数校验失败
  - `40300` 权限不足
  - `40901` OCC 冲突（version 不匹配）
- **WS 广播**：`WORKER_POOL_ASSIGNED { worker_id, batch_id, version }`

### 5. `POST /api/v2/admin/worker-pool/return` （新增）

- **权限**：Manager
- **Body**：`ReturnRequest { worker_id, batch_id, shelf_id, next_process_id }`
- **Response.data**：`WorkOrderCard`（`version+1`）
- **错误**：同 assign
- **WS 广播**：`WORKER_POOL_RETURNED { worker_id, batch_id, next_process_id, version }`

## Worker CRUD 补充

`worker-pool.md` 第 219 行注明「WorkerRepo 列表 / 创建 / 软删等 CRUD 未上线」，本需求同样依赖 Worker 列表 endpoint，**优先级 P0**。

## 菜单变更

后端 `t_menu` 表需新增：
- `code: 'worker_queue'`
- `path: '/workers/queue'`
- `parent_id`: 工人管理分组的 ID
- `title: '工人队列调度'`
- `icon: 'Operation'`

无此菜单项，路由守卫会降级踢走。

## 验收

- 前端 `src/api/workerPool.ts` 移除 mock，切换为真接口（每个函数体去掉 `FIXTURE_*` import 与 `delay` 调用）
- 看板页面 E2E 测试：拖拽一张卡 → 工人 `current_held +1`、对应 pool `batches.length -1`
- OCC 冲突：两个 admin 同时分配同一 batch → 后者收到 40901，前端显示「版本冲突，请刷新」Toast 并触发 `loadBoard()`
