// pending-batches 域前端 API（v2，baseURL /api/v2，2026-09-29 新增）。
//
// 端点（与 backend-rust/src/modules/prod/batch 模块对齐）：
//   GET  /api/v2/prod/batches/pending               ← fetchPendingBatches
//   POST /api/v2/prod/batches/dispatch              ← dispatchBatch（单件下发；
//                                                    batch_id 走 body 不走 URL）
//   POST /api/v2/prod/batches/bulk-dispatch         ← bulkDispatchBatches（批量下发，
//                                                    payload 形态 targets: [...]）
//   POST /api/v2/prod/batches/auto-dispatch         ← autoDispatchBatches（自动下发，
//                                                    service 端按 process_chain_id 推导）
//
// 2026-09-29 修复 dispatch 契约漂移：
//   - dispatch / bulk-dispatch 请求 payload 与响应字段对齐 backend VO
//     （backend-rust src/modules/prod/batch/vo.rs:88-119），URL 漂移修正
//     （`/{batch_id}/dispatch` → `/dispatch` 连字符 `/dispatch-bulk` → `/bulk-dispatch`）；
//   - 所有函数体在拿到响应后走 Zod parse 守门（dispatchResultSchema /
//     bulkDispatchResultSchema / autoDispatchResultSchema），后端契约漂移立刻抛
//     ZodError 而非运行时 `undefined.length`（首轮 bug 根因）。
//
// 业务端点统一走 `api`（baseURL `/api/v2`，2026-09-15 Phase 5 起）。
// 2026-09-29 新增：服务于生产队列「待下发」Tab —— 拉取 status=PENDING 且未进入任何工序
// 的 part.batch，按下发场景（单件 / 批量 / 自动）触发不同 mutation。所有 mutation 在
// usePendingDispatch.ts 内集中调 invalidateQueries 失效 pendingBatchesPrefix +
// processesPrefix + partsPrefix 三域，与「跨域写操作精确失效」2026-09-26 约定对齐。

import { api, cleanParams } from '@/api/http';
import type { PendingBatchItemDto } from './workerPool.contract';
import {
  autoDispatchResultSchema,
  bulkDispatchResultSchema,
  dispatchResultSchema,
} from '@/composables/queries/schemas';

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

/** `POST /api/v2/prod/batches/dispatch` 请求（rust DispatchRequest）。
 *  2026-09-29 修复：必填 `target_process_id`（service 端按 `t_shelf_process` 解析货架）；
 *  旧前端 `shelf_id / next_process_id` 形态已删（backend 实际无此入参）；`note` 可选
 *  落到 `t_part_event.note`。
 *  业务错：20706 BIZ_PROCESS_CHAIN_REQUIRED（无 process_chain_id）、
 *         20120 BIZ_BATCH_INVALID_STATUS（不是 PENDING）、
 *         20508 BIZ_SHELF_PROCESS_NOT_FOUND（target_process 无对应货架）。 */
export interface DispatchBatchRequest {
  /** 目标工序 ID（必填；service 按 t_shelf_process 解析货架） */
  target_process_id: string;
  /** 备注（落到 t_part_event.note） */
  note?: string;
}

/** `POST /api/v2/prod/batches/dispatch` 出参（rust DispatchResult，
 *  backend-rust vo.rs:88-97）。5 字段：batch_id / current_process_step_id（Option<i64>，
 *  dispatch 路径不解析 step → null）/ target_process_id / shelf_id / version。
 *  旧前端 `part_id` 字段已删（VO 实际不含，dispatch.md:84）。 */
export interface DispatchBatchResultDto {
  batch_id: string;
  current_process_step_id: string | null;
  target_process_id: string;
  shelf_id: string;
  version: number;
}

/** `POST /api/v2/prod/batches/bulk-dispatch` 单条 target（rust BulkDispatchTarget）。 */
export interface BulkDispatchTarget {
  batch_id: string;
  target_process_id: string;
}

/** `POST /api/v2/prod/batches/bulk-dispatch` 请求（rust BulkDispatchRequest）。
 *  2026-09-29 修复：旧前端 `{ batch_ids, shelf_id, next_process_id }` 共享形态已删
 *  （业务允许不同 target 走不同 process）；改用 backend `targets: BulkDispatchTarget[]`
 *  形态（bulk-dispatch.md:111-119）。service 端「任一失败 → 全回滚」单事务处理。 */
export interface BulkDispatchRequest {
  targets: BulkDispatchTarget[];
}

/** `POST /api/v2/prod/batches/bulk-dispatch` 出参（rust BulkDispatchResult）。
 *  succeeded / failed 分别记录成功与失败件；当前实现「任一失败 → 全回滚」，失败码
 *  通常由 AppError.code() 抛出（HTTP 4xx/5xx），failed 数组在事务成功提交后一般恒空
 *  —— 但保留 schema 以防 backend 后续改为 partial commit（vo.rs:103-107）。 */
export interface BulkDispatchResultDto {
  succeeded: DispatchBatchResultDto[];
  failed: Array<{ batch_id: string; code: number; message: string }>;
}

/** `POST /api/v2/prod/batches/auto-dispatch` 请求（rust AutoDispatchRequest）。
 *  service 端按 batch.process_chain_id 推导 first_step → target_process；无 chain
 *  或 chain 无 step 的 batch 跳过并返回 skipped 条目（不影响其他件事务）。 */
export interface AutoDispatchRequest {
  batch_ids: string[];
}

/** `POST /api/v2/prod/batches/auto-dispatch` 跳过条目（rust AutoDispatchSkippedItem）。
 *  2026-09-29 修复：reason 字符串区分 'NO_PROCESS_CHAIN' / 'NO_PROCESS_STEP'；
 *  旧前端 `code + message` 形态已删（auto-dispatch 是 soft-skip 而非抛错，
 *  auto-dispatch.md:156-161）。 */
export interface AutoDispatchSkippedItem {
  batch_id: string;
  /** 'NO_PROCESS_CHAIN' | 'NO_PROCESS_STEP' */
  reason: string;
}

/** `POST /api/v2/prod/batches/auto-dispatch` 出参（rust AutoDispatchResult）。
 *  2026-09-29 修复：`failed` 改 `skipped`（auto-dispatch 是 soft-skip 而非抛错，
 *  vo.rs:107-119）。skipped 与 succeeded 互不影响事务。 */
export interface AutoDispatchResultDto {
  succeeded: DispatchBatchResultDto[];
  skipped: AutoDispatchSkippedItem[];
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

/** POST /api/v2/prod/batches/dispatch —— 单件下发。
 *  2026-09-29 修复：batch_id 走 body 而非 URL；URL `/prod/batches/dispatch`
 *  （旧 `/prod/batches/{batch_id}/dispatch` 与 backend 实际不符，dispatch.md:64-67）。
 *  响应经 `dispatchResultSchema.parse()` 守门 —— 后端字段漂移立刻抛 ZodError。 */
export async function dispatchBatch(
  batchId: string,
  req: DispatchBatchRequest,
): Promise<DispatchBatchResultDto> {
  const resp = await api.post<DispatchBatchResultDto>('/prod/batches/dispatch', {
    batch_id: batchId,
    ...req,
  });
  return dispatchResultSchema.parse(resp.data);
}

/** POST /api/v2/prod/batches/bulk-dispatch —— 批量下发（每条 target 独立 batch + process）。
 *  2026-09-29 修复：URL `/prod/batches/bulk-dispatch`（旧 `/dispatch-bulk` 与 backend
 *  实际不符，bulk-dispatch.md:103-104）；payload 改 `targets: [...]` 形态。
 *  响应经 `bulkDispatchResultSchema.parse()` 守门。 */
export async function bulkDispatchBatches(
  req: BulkDispatchRequest,
): Promise<BulkDispatchResultDto> {
  const resp = await api.post<BulkDispatchResultDto>('/prod/batches/bulk-dispatch', req);
  return bulkDispatchResultSchema.parse(resp.data);
}

/** POST /api/v2/prod/batches/auto-dispatch —— 自动下发（service 端按 process_chain_id 推导）。
 *  响应经 `autoDispatchResultSchema.parse()` 守门 —— `res.failed` 读 undefined 是首轮
 *  `Cannot read properties of undefined (reading 'length')` bug 根因。 */
export async function autoDispatchBatches(
  req: AutoDispatchRequest,
): Promise<AutoDispatchResultDto> {
  const resp = await api.post<AutoDispatchResultDto>('/prod/batches/auto-dispatch', req);
  return autoDispatchResultSchema.parse(resp.data);
}