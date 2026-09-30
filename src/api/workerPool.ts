// pool 域前端 API（v2，baseURL /api/v2）。
//
// 2026-09-30 后端 worker-pool → pool 路径收敛（原 6 端点归并为 5 个，
// 见 backend-rust/src/modules/prod/worker_pool/mod.rs:26-36 与
// docs/api/production/worker-pool.md §端点列表）：
//   旧 `/worker-pool/*` + `/admin/worker-pool/*` 全部 404（router 层不再挂载），
//   旧 `/admin/worker-pool/{assign,remove}` 合并为通用移动端点 `/pool/move`
//   （POOL ↔ WORKER + WORKER ↔ WORKER 三方向）。
//
// 端点（与 backend-rust/src/modules/prod/worker_pool/handler.rs 对齐）：
//   GET  /api/v2/prod/pool/state?worker_id=&shelf_id=  ← getWorkerState
//   GET  /api/v2/prod/pool/counts                     ← getWorkerPoolCounts
//   GET  /api/v2/prod/pool/{process_id}               ← getWorkerPoolByProcess
//   POST /api/v2/prod/pool/refill                     ← refillWorkerPool
//   POST /api/v2/prod/pool/move                       ← moveBatch（取代 assign + remove）
//   POST /api/v2/prod/pool/auto-allocate              ← autoAllocate
//
// 历史变更：
//   - 2026-08-26：阶段一，全部走 fixture + delay；阶段二标记替换点
//   - 2026-09-14：阶段二，全部切到 apiV2；DTO 类型独立到 ./workerPool.contract.ts
//   - 2026-09-14 follow-up：新增 assignWorkerPool（单 batch 分配，替代批量 refill
//     在「拖拽 batch 到 worker」场景的滥用）
//   - 2026-09-15 Phase 5：`apiV2` → `api`（baseURL `/api/v2`，业务全切 v2）
//   - 2026-09-25：后端路由前缀缺失 /prod/ 段，补齐对齐 v2 实际契约
//   - 2026-09-30：worker-pool → pool 路径收敛；assign + remove 合并为 move；
//     counts 端点去掉 shelf_id query（后端 pool_counts handler 无 Query extractor，
//     按 process_id GROUP BY 跨所有货架聚合）

import { api, cleanParams } from '@/api/http';
import type {
  AutoAllocateRequest,
  AutoAllocateResultDto,
  MoveRequest,
  MoveResultDto,
  WorkerPoolCountsDto,
  WorkerPoolDto,
  WorkerRefillRequest,
  WorkerRefillResultDto,
  WorkerStateDto,
} from './workerPool.contract';

/** GET /api/v2/prod/pool/state?worker_id=&shelf_id=
 *  无 role guard（worker 自查 + admin 监控共用）。
 *  无工种时退化为空 pool_count_by_process + max_held=0，service 不报错。
 *  业务错：20201 BIZ_WORKER_NOT_FOUND。 */
export async function getWorkerState(params: {
  worker_id: string;
  shelf_id: string;
}): Promise<WorkerStateDto> {
  const resp = await api.get<WorkerStateDto>('/prod/pool/state', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** GET /api/v2/prod/pool/counts
 *  Manager+Clerk+Inspector（service 守卫）。
 *  全工序候选 batch 聚合（GROUP BY process_id，跨所有货架），tab 标题 (N) 徽标
 *  与「待下发」Tab 工序卡 badge 的唯一数据源 —— 避免了 per-process 详情的 N+1 轮询。
 *  **无 query 参数**（后端 `pool_counts` handler 只有 State + CurrentUser，
 *  不接 Query extractor；传 shelf_id 会被 serde 忽略成死参）。
 *  含 0 候选批次的 process 不出现在 counts 中（GROUP BY 不输出 0 行）。
 *  Eager 拉取（30s staleTime 去重缓存 + 写操作 invalidate）。 */
export async function getWorkerPoolCounts(): Promise<WorkerPoolCountsDto> {
  const resp = await api.get<WorkerPoolCountsDto>('/prod/pool/counts');
  return resp.data;
}

/** GET /api/v2/prod/pool/{process_id}
 *  Manager+Clerk+Inspector（service 守卫）。
 *  返回 process 元数据 + 可执行该工序的工人 + 工种 max_held + **跨所有货架**
 *  候选批次全量（不分页，admin 视角）。
 *  业务错：20801 BIZ_PROCESS_NOT_FOUND。
 *  懒加载：仅在对应 el-tab-pane 首次激活时由 WorkerPoolTab 发起。 */
export async function getWorkerPoolByProcess(processId: string | number): Promise<WorkerPoolDto> {
  const resp = await api.get<WorkerPoolDto>(
    `/prod/pool/${encodeURIComponent(String(processId))}`,
  );
  return resp.data;
}

/** POST /api/v2/prod/pool/refill
 *  Manager only。为指定 worker 抢满 work_type.max_held_batches（同事务）。
 *  WS 广播 WORKER_POOL_REFILL_DONE / WORKER_POOL_EMPTY（前端按需订阅）。
 *  业务错：20202 INACTIVE / 20206 NO_WORK_TYPE / 20904 MAX_HELD_NOT_SET /
 *         20905 NO_PROCESS_MAPPING。
 *  2026-09-14 follow-up：仅用于「批量抢批」场景（auto-allocate 入口）。
 *  拖拽 batch → worker 改用 moveBatch（单 batch POOL→WORKER 语义）。 */
export async function refillWorkerPool(req: WorkerRefillRequest): Promise<WorkerRefillResultDto> {
  const resp = await api.post<WorkerRefillResultDto>('/prod/pool/refill', req);
  return resp.data;
}

/** POST /api/v2/prod/pool/move（2026-09-30 新增，取代旧 assign + remove）
 *  Manager only。通用移动端点，`from` / `to` 为 tagged enum：
 *    {"kind":"POOL",   "shelf_id":"100"}
 *    {"kind":"WORKER", "worker_id":"50"}
 *  支持方向：POOL→WORKER（旧 assign）/ WORKER→POOL（旧 remove）/ WORKER→WORKER；
 *  POOL→POOL 非法（40001）。
 *
 *  关键不变量（前端必须遵守，否则后端返 409/422）：
 *  - `from` 必与 batch 当前 `(location, current_holder_id)` 严格一致：
 *      POOL   → shelf_id 必等于 batch.current_holder_id
 *      WORKER → worker_id 必等于 batch.current_holder_id
 *    不一致 → `20122 BIZ_BATCH_LOCATION_MISMATCH`（HTTP 409）。
 *    ⇒ 前端「pool → worker」必须传 batch **真实所在货架**（拖拽时从
 *      PoolBatchItem.shelf_id 记录），不能拿当前激活货架凑 —— 候选池跨货架。
 *  - `to.kind=POOL`：目标货架必须映射到 batch 当前工序，否则
 *    `20507 BIZ_SHELF_PROCESS_NOT_MAPPED`（HTTP 422）。
 *  - `to.kind=WORKER`：worker 必须 is_active、工种含 batch 当前工序、
 *    持有数 < max_held_batches，否则 20202 / 20104 / 20204。
 *  - 所有 move SQL 不写 current_process_step_id（move 不推进工序链）。
 *
 *  其它业务错：20121 BIZ_BATCH_NOT_FOUND（404）/ 20120 BIZ_BATCH_INVALID_STATUS（409）/
 *  40901 VERSION_CONFLICT（OCC）/ 40300 FORBIDDEN / 40001 VALIDATION_ERROR。
 *  WS 广播 WORKER_POOL_MOVE_DONE（取代旧 WORKER_POOL_ASSIGN_DONE /
 *  WORKER_POOL_ADMIN_REMOVED）。 */
export async function moveBatch(req: MoveRequest): Promise<MoveResultDto> {
  const resp = await api.post<MoveResultDto>('/prod/pool/move', req);
  return resp.data;
}

/** POST /api/v2/prod/pool/auto-allocate
 *  Manager only。按 process + shelf 范围为每个匹配 worker 自动抢批次数/工时。
 *  业务错：20704 BIZ_AUTO_ALLOCATE_INVALID_RATIO（fill_ratio ∈ [0,1]）/ 20904 / 20905 / 20801。
 *  WS 广播 WORKER_POOL_AUTO_ALLOCATE_DONE（payload 含 mode / fill_ratio / pool_empty）。 */
export async function autoAllocate(req: AutoAllocateRequest): Promise<AutoAllocateResultDto> {
  const resp = await api.post<AutoAllocateResultDto>('/prod/pool/auto-allocate', req);
  return resp.data;
}
