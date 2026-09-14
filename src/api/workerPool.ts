// 2026-09-14 重写：worker-pool 域前端 API（v2，baseURL /api/v2）。
//
// 端点（与 backend-rust/src/modules/worker_pool/handler.rs 对齐）：
//   GET  /api/v2/worker-pool/state?worker_id=&shelf_id=    ← getWorkerState
//   GET  /api/v2/worker-pool/{process_id}                 ← getWorkerPoolByProcess
//   POST /api/v2/admin/worker-pool/refill                 ← refillWorkerPool
//   POST /api/v2/admin/worker-pool/remove                 ← removeFromWorkerPool
//   POST /api/v2/admin/worker-pool/auto-allocate          ← autoAllocate
//
// 注意：v2 端点必须用 apiV2（CLAUDE.md #2），禁止 api.post('/v2/...')。
// 历史变更：
//   - 2026-08-26：阶段一，全部走 fixture + delay；阶段二标记替换点
//   - 2026-09-14：阶段二，全部切到 apiV2；DTO 类型独立到 ./workerPool.contract.ts

import { apiV2, cleanParams } from '@/api/http';
import type {
  AutoAllocateRequest,
  AutoAllocateResultDto,
  WorkerPoolDto,
  WorkerRefillRequest,
  WorkerRefillResultDto,
  WorkerRemoveRequest,
  WorkerStateDto,
  WorkerTakenItemDto,
} from './workerPool.contract';

/** GET /api/v2/worker-pool/state?worker_id=&shelf_id=
 *  无 role guard（worker 自查 + admin 监控共用）。
 *  无工种时退化为空 pool_count_by_process + max_held=0，service 不报错。 */
export async function getWorkerState(params: {
  worker_id: string;
  shelf_id: string;
}): Promise<WorkerStateDto> {
  const resp = await apiV2.get<WorkerStateDto>('/worker-pool/state', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** GET /api/v2/worker-pool/{process_id}
 *  Manager+Clerk+Inspector（service 守卫）。
 *  返回 process 元数据 + 可执行该工序的工人 + 工种 max_held + 跨货架候选批次全量。 */
export async function getWorkerPoolByProcess(processId: string | number): Promise<WorkerPoolDto> {
  const resp = await apiV2.get<WorkerPoolDto>(
    `/worker-pool/${encodeURIComponent(String(processId))}`,
  );
  return resp.data;
}

/** POST /api/v2/admin/worker-pool/refill
 *  Manager only。WS 广播 WORKER_POOL_REFILL_DONE / WORKER_POOL_EMPTY（前端按需订阅）。
 *  业务错：20202 INACTIVE / 20904 MAX_HELD_NOT_SET / 20905 NO_PROCESS_MAPPING。 */
export async function refillWorkerPool(req: WorkerRefillRequest): Promise<WorkerRefillResultDto> {
  const resp = await apiV2.post<WorkerRefillResultDto>('/admin/worker-pool/refill', req);
  return resp.data;
}

/** POST /api/v2/admin/worker-pool/remove
 *  Manager only。把 worker 持有 batch 按 RETURNED 语义放回候选池。
 *  业务错：20114 BIZ_PART_BATCH_NOT_HELD_BY_WORKER（worker 不持有该 batch）。
 *  WS 广播 WORKER_POOL_ADMIN_REMOVED。 */
export async function removeFromWorkerPool(req: WorkerRemoveRequest): Promise<WorkerTakenItemDto> {
  const resp = await apiV2.post<WorkerTakenItemDto>('/admin/worker-pool/remove', req);
  return resp.data;
}

/** POST /api/v2/admin/worker-pool/auto-allocate
 *  Manager only。按 process + shelf 范围为每个匹配 worker 自动抢批次数/工时。
 *  业务错：20704 BIZ_AUTO_ALLOCATE_INVALID_RATIO（fill_ratio ∈ [0,1]）/ 20904 / 20905 / 20801 NOT_FOUND。
 *  WS 广播 WORKER_POOL_AUTO_ALLOCATE_DONE（payload 含 mode / fill_ratio / pool_empty）。 */
export async function autoAllocate(req: AutoAllocateRequest): Promise<AutoAllocateResultDto> {
  const resp = await apiV2.post<AutoAllocateResultDto>('/admin/worker-pool/auto-allocate', req);
  return resp.data;
}
