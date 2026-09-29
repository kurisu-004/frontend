// pending-batches 域前端 API（v2，baseURL /api/v2，2026-09-29 新增）。
//
// 端点（与 backend-rust/src/modules/prod/batch 模块对齐）：
//   GET  /api/v2/prod/batches/pending               ← fetchPendingBatches
//   POST /api/v2/prod/batches/{batch_id}/dispatch   ← dispatchBatch（单件下发）
//   POST /api/v2/prod/batches/dispatch-bulk         ← bulkDispatchBatches（批量下发）
//   POST /api/v2/prod/batches/auto-dispatch         ← autoDispatchBatches（自动下发，
//                                                    service 端按 process_chain_id 推导）
//
// 业务端点统一走 `api`（baseURL `/api/v2`，2026-09-15 Phase 5 起）。
// 2026-09-29 新增：服务于生产队列「待下发」Tab —— 拉取 status=PENDING 且未进入任何工序
// 的 part.batch，按下发场景（单件 / 批量 / 自动）触发不同 mutation。所有 mutation 在
// usePendingDispatch.ts 内集中调 invalidateQueries 失效 pendingBatchesPrefix +
// processesPrefix + partsPrefix 三域，与「跨域写操作精确失效」2026-09-26 约定对齐。

import { api, cleanParams } from '@/api/http';
import type { PendingBatchItemDto } from './workerPool.contract';

/** `GET /api/v2/prod/batches/pending` 入参形态。
 *  - limit / offset：分页；
 *  - urgent_only：可选筛选加急项；
 *  - keyword：模糊匹配图号 / 名称（与后端 PendingBatchListQuery.keyword 对齐）。 */
export interface ListPendingBatchesParams {
  limit?: number;
  offset?: number;
  urgent_only?: boolean;
  keyword?: string;
}

/** `GET /api/v2/prod/batches/pending` 出参（rust PendingBatchListOut）。
 *  结构对齐 ListOut 信封（items + total + limit + offset）。 */
export interface PendingBatchListDto {
  items: PendingBatchItemDto[];
  total: number;
  limit: number;
  offset: number;
}

/** `POST /api/v2/prod/batches/{batch_id}/dispatch` 请求（rust DispatchBatchRequest）。
 *  显式下发到指定工序 / 货架；shelf_id 与 next_process_id 二者至少其一非空（service 校验）。
 *  业务错：20706 BIZ_PROCESS_CHAIN_REQUIRED（无 process_chain_id）、
 *         20104 BIZ_BATCH_STATUS_INVALID（不是 PENDING）。 */
export interface DispatchBatchRequest {
  /** 目标货架 ID（与 placeOnShelf 同语义，可选） */
  shelf_id?: string;
  /** 下一道工序 ID（process_chain_step.id，可选） */
  next_process_id?: string;
}

/** `POST /api/v2/prod/batches/{batch_id}/dispatch` 出参（rust DispatchBatchResult）。
 *  下发成功后返回 batch 当前版本号（version + 1）。 */
export interface DispatchBatchResultDto {
  batch_id: string;
  part_id: string;
  version: number;
  shelf_id: string;
  next_process_id: string;
}

/** `POST /api/v2/prod/batches/dispatch-bulk` 请求（rust BulkDispatchRequest）。
 *  批量下发多个 batch 到同一货架 + 同一工序（共享 shelf_id / next_process_id）。 */
export interface BulkDispatchRequest {
  batch_ids: string[];
  shelf_id: string;
  next_process_id: string;
}

/** `POST /api/v2/prod/batches/dispatch-bulk` 出参（rust BulkDispatchResult）。
 *  succeeded / failed 分别记录成功与失败件；service 端单件失败不阻断其他件。 */
export interface BulkDispatchResultDto {
  succeeded: DispatchBatchResultDto[];
  failed: Array<{ batch_id: string; code: number; message: string }>;
}

/** `POST /api/v2/prod/batches/auto-dispatch` 请求（rust AutoDispatchRequest）。
 *  service 端按 batch.process_chain_id 推导 first_step → shelf 默认值 → 下发。
 *  无 process_chain_id 的 batch 跳过并返回 failed 条目（前端按 20706 提示用户先制定工艺链）。 */
export interface AutoDispatchRequest {
  batch_ids: string[];
}

/** `POST /api/v2/prod/batches/auto-dispatch` 出参（rust AutoDispatchResult）。 */
export interface AutoDispatchResultDto {
  succeeded: DispatchBatchResultDto[];
  failed: Array<{ batch_id: string; code: number; message: string }>;
}

/** GET /api/v2/prod/batches/pending —— 拉取待下发批次列表。 */
export async function fetchPendingBatches(
  params: ListPendingBatchesParams = {},
): Promise<PendingBatchListDto> {
  const resp = await api.get<PendingBatchListDto>('/prod/batches/pending', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** POST /api/v2/prod/batches/{batch_id}/dispatch —— 单件下发。 */
export async function dispatchBatch(
  batchId: string,
  req: DispatchBatchRequest,
): Promise<DispatchBatchResultDto> {
  const resp = await api.post<DispatchBatchResultDto>(
    `/prod/batches/${encodeURIComponent(batchId)}/dispatch`,
    req,
  );
  return resp.data;
}

/** POST /api/v2/prod/batches/dispatch-bulk —— 批量下发（共享 shelf_id + next_process_id）。 */
export async function bulkDispatchBatches(
  req: BulkDispatchRequest,
): Promise<BulkDispatchResultDto> {
  const resp = await api.post<BulkDispatchResultDto>('/prod/batches/dispatch-bulk', req);
  return resp.data;
}

/** POST /api/v2/prod/batches/auto-dispatch —— 自动下发（service 端按 process_chain_id 推导）。 */
export async function autoDispatchBatches(
  req: AutoDispatchRequest,
): Promise<AutoDispatchResultDto> {
  const resp = await api.post<AutoDispatchResultDto>('/prod/batches/auto-dispatch', req);
  return resp.data;
}