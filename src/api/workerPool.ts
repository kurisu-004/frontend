// worker-pool 域前端 API（v2，baseURL /api/v2，2026-09-15 Phase 5 业务全切 v2）。
//
// 端点（与 backend-rust/src/modules/worker_pool/handler.rs 对齐）：
//   GET  /api/v2/prod/worker-pool/state?worker_id=&shelf_id=    ← getWorkerState
//   GET  /api/v2/prod/worker-pool/{process_id}                 ← getWorkerPoolByProcess
//   POST /api/v2/prod/admin/worker-pool/refill                 ← refillWorkerPool
//   POST /api/v2/prod/admin/worker-pool/assign                 ← assignWorkerPool（2026-09-14 新增）
//   POST /api/v2/prod/admin/worker-pool/remove                 ← removeFromWorkerPool
//   POST /api/v2/prod/admin/worker-pool/auto-allocate          ← autoAllocate
//
// 业务端点统一走 `api`（baseURL `/api/v2`，2026-09-15 Phase 5 起）。
// 2026-09-25 修正：后端路由前缀缺失 /prod/ 段，补齐对齐 v2 backend-rust 实际契约。
// 历史变更：
//   - 2026-08-26：阶段一，全部走 fixture + delay；阶段二标记替换点
//   - 2026-09-14：阶段二，全部切到 apiV2；DTO 类型独立到 ./workerPool.contract.ts
//   - 2026-09-14 follow-up：新增 assignWorkerPool（单 batch 分配，替代批量 refill
//     在「拖拽 batch 到 worker」场景的滥用）
//   - 2026-09-15 Phase 5：`apiV2` → `api`（baseURL `/api/v2`，业务全切 v2）

import { api, cleanParams } from '@/api/http';
import type {
  AdminAssignRequest,
  AssignResultDto,
  AutoAllocateRequest,
  AutoAllocateResultDto,
  WorkerPoolDto,
  WorkerRefillRequest,
  WorkerRefillResultDto,
  WorkerRemoveRequest,
  WorkerStateDto,
  WorkerTakenItemDto,
} from './workerPool.contract';

/** GET /api/v2/prod/worker-pool/state?worker_id=&shelf_id=
 *  无 role guard（worker 自查 + admin 监控共用）。
 *  无工种时退化为空 pool_count_by_process + max_held=0，service 不报错。 */
export async function getWorkerState(params: {
  worker_id: string;
  shelf_id: string;
}): Promise<WorkerStateDto> {
  const resp = await api.get<WorkerStateDto>('/prod/worker-pool/state', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** GET /api/v2/prod/worker-pool/{process_id}
 *  Manager+Clerk+Inspector（service 守卫）。
 *  返回 process 元数据 + 可执行该工序的工人 + 工种 max_held + 跨货架候选批次全量。 */
export async function getWorkerPoolByProcess(processId: string | number): Promise<WorkerPoolDto> {
  const resp = await api.get<WorkerPoolDto>(
    `/prod/worker-pool/${encodeURIComponent(String(processId))}`,
  );
  return resp.data;
}

/** POST /api/v2/prod/admin/worker-pool/refill
 *  Manager only。WS 广播 WORKER_POOL_REFILL_DONE / WORKER_POOL_EMPTY（前端按需订阅）。
 *  业务错：20202 INACTIVE / 20904 MAX_HELD_NOT_SET / 20905 NO_PROCESS_MAPPING。
 *  2026-09-14 follow-up：仅用于「批量抢批」场景（auto-allocate 入口）。
 *  拖拽 batch → worker 改用 assignWorkerPool（单 batch 分配语义）。 */
export async function refillWorkerPool(req: WorkerRefillRequest): Promise<WorkerRefillResultDto> {
  const resp = await api.post<WorkerRefillResultDto>('/prod/admin/worker-pool/refill', req);
  return resp.data;
}

/** POST /api/v2/prod/admin/worker-pool/assign（2026-09-14 新增）
 *  Manager only。单 batch 分配：把候选池某个 batch 直接塞给 worker。
 *  替代之前「拖拽 batch → worker 调 refillWorkerPool（批量抢到 max_held）」的滥用。
 *  业务错：20204 WORKER_CAPACITY_EXCEEDED / 20706 BIZ_BATCH_NOT_IN_POOL /
 *         20114 BIZ_PART_BATCH_NOT_HELD_BY_WORKER / 20801 NOT_FOUND。 */
export async function assignWorkerPool(req: AdminAssignRequest): Promise<AssignResultDto> {
  const resp = await api.post<AssignResultDto>('/prod/admin/worker-pool/assign', req);
  return resp.data;
}

/** POST /api/v2/prod/admin/worker-pool/remove
 *  Manager only。把 worker 持有 batch 按 RETURNED 语义放回候选池。
 *  业务错：20114 BIZ_PART_BATCH_NOT_HELD_BY_WORKER（worker 不持有该 batch）。
 *  WS 广播 WORKER_POOL_ADMIN_REMOVED。 */
export async function removeFromWorkerPool(req: WorkerRemoveRequest): Promise<WorkerTakenItemDto> {
  const resp = await api.post<WorkerTakenItemDto>('/prod/admin/worker-pool/remove', req);
  return resp.data;
}

/** POST /api/v2/prod/admin/worker-pool/auto-allocate
 *  Manager only。按 process + shelf 范围为每个匹配 worker 自动抢批次数/工时。
 *  业务错：20704 BIZ_AUTO_ALLOCATE_INVALID_RATIO（fill_ratio ∈ [0,1]）/ 20904 / 20905 / 20801 NOT_FOUND。
 *  WS 广播 WORKER_POOL_AUTO_ALLOCATE_DONE（payload 含 mode / fill_ratio / pool_empty）。 */
export async function autoAllocate(req: AutoAllocateRequest): Promise<AutoAllocateResultDto> {
  const resp = await api.post<AutoAllocateResultDto>('/prod/admin/worker-pool/auto-allocate', req);
  return resp.data;
}
