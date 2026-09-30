// pending-batches 域前端 API（v2，baseURL /api/v2，2026-09-29 新增）。
//
// 2026-09-30 后端重构（本文件同步重写，见
// backend-rust/src/modules/prod/batch/{mod.rs,dto.rs,vo.rs,service.rs} 与
// docs/api/production/batches.md）：
//   - **dispatch 统一 bulk-only**：单条下发即 `targets.length == 1`；旧
//     `DispatchRequest { batch_id, target_process_id }` 形态已删。
//   - **bulk-dispatch 端点删除**（router 层不再挂载 ⇒ 404）：批量下发复用
//     `POST /batches/dispatch` 的 targets 数组。
//   - **auto-dispatch 改为只读 preview**：不再真正下发，只返回每个 batch 的
//     「首道工序 + 首货架 + skip_reason」；前端据此构造 dispatch 请求真正下发。
//   - 响应体：dispatch 出参由单个 `DispatchSuccessItem` 改 `DispatchResult
//     { succeeded[], failed[] }`（`failed` 当前恒空，任一失败 → service 抛
//     AppError 全回滚）；auto-dispatch 出参由 `{succeeded, skipped}` 改 `{items[]}`。
//
// 端点（与 backend-rust/src/modules/prod/batch/mod.rs:54-58 对齐）：
//   GET  /api/v2/prod/batches/pending          ← fetchPendingBatches
//   POST /api/v2/prod/batches/dispatch         ← dispatchBatches（bulk-only）
//   POST /api/v2/prod/batches/auto-dispatch    ← previewAutoDispatch（只读）
//
// 历史变更：
//   - 2026-09-29 修复 dispatch 契约漂移：URL `/{batch_id}/dispatch` → `/dispatch`；
//     响应加 Zod parse 守门。
//   - 2026-09-30：与后端 2026-09-30 重构对齐（详见上方）。
//   2026-09-29：服务于生产队列「待下发」Tab —— 拉取 status=PENDING 的 part.batch。
//   所有 mutation 在 usePendingDispatch.ts 内集中调 invalidateQueries 失效
//   pendingBatchesPrefix + partsPrefix + worker-pool 两域。
//   2026-09-30 修复：去掉 processesPrefix —— 下发批次不改变工序列表，失效它只会
//   重拉会话级缓存的 processes。
//
// 业务端点统一走 `api`（baseURL `/api/v2`）。

import { api, cleanParams } from '@/api/http';
import type { PendingBatchItemDto } from './workerPool.contract';
import {
  autoDispatchResultSchema,
  dispatchResultSchema,
  type AutoDispatchResultSchema,
  type DispatchResultSchema,
} from '@/composables/queries/schemas';

/** `GET /api/v2/prod/batches/pending` 入参形态（rust ListPendingQuery）。
 *  2026-09-30 修正：后端只接 `limit` / `offset` 两个 Query 参数
 *  （batch/dto.rs::ListPendingQuery），旧前端的 `urgent_only` / `keyword` 已删
 *  （后端从不消费，cleanParams 只是把死参发出去）。 */
export interface ListPendingBatchesParams {
  /** 默认 200；service 层 clamp(1, 500) */
  limit?: number;
  /** 默认 0；service 层 max(0) */
  offset?: number;
}

/** `GET /api/v2/prod/batches/pending` 出参（rust PendingBatchListOut）。 */
export interface PendingBatchListDto {
  items: PendingBatchItemDto[];
  total: number;
  limit: number;
  offset: number;
}

/** `POST /api/v2/prod/batches/dispatch` 单条 target（rust DispatchTarget）。 */
export interface DispatchTarget {
  batch_id: string;
  target_process_id: string;
}

/** `POST /api/v2/prod/batches/dispatch` 请求（rust DispatchRequest）。
 *  2026-09-30：bulk-only 形态 —— 单条下发即 `targets.length == 1`，多条按数组
 *  顺序执行，任一硬失败 → service 抛 AppError，handler 的 Transaction Drop 回滚
 *  全部 succeeded 写入。空 targets → 40001 VALIDATION_ERROR（HTTP 422）。
 *
 *  不带 shelf_id / version：货架由 service 按 `target_process_id` 在
 *  `t_shelf_process` 自动解析（sort_order ASC, id ASC LIMIT 1），0 结果 →
 *  20508 BIZ_SHELF_PROCESS_NOT_FOUND；版本号走 batch 当前 version 隐式 OCC。
 *
 *  业务错：20120 BIZ_BATCH_INVALID_STATUS（409，batch 非 PENDING）/
 *         20121 BIZ_BATCH_NOT_FOUND（404）/ 20508 SHELF_PROCESS_NOT_FOUND（404）/
 *         40901 VERSION_CONFLICT（409）/ 40300 FORBIDDEN（非 Manager/Clerk）。 */
export interface DispatchRequest {
  targets: DispatchTarget[];
  /** 可选，落到所有 t_part_event.note（bulk 共享） */
  note?: string;
}

/** `POST /api/v2/prod/batches/dispatch` 出参（rust DispatchResult）。
 *  2026-09-30 由「单条 DispatchSuccessItem」改为 `{succeeded[], failed[]}` 列表形态。
 *  当前实现「任一失败 → 全回滚」，`failed` 恒空且 rust 侧 skip_serializing_if
 *  会省略空数组 ⇒ 前端 schema 给 `.default([])` 兜底。 */
export type DispatchBatchResultDto = DispatchResultSchema;

/** `POST /api/v2/prod/batches/auto-dispatch` 请求（rust AutoDispatchRequest）。
 *  2026-09-30：字段是 `Option<Vec<i64>>`（`deserialize_i64_vec_opt`）——
 *  缺省 / null / 空数组三种形态都让后端返 40001，前端须保证非空。 */
export interface AutoDispatchPreviewRequest {
  batch_ids: string[];
}

/** `POST /api/v2/prod/batches/auto-dispatch` 出参（rust AutoDispatchResult）。
 *  2026-09-30：由旧 `{succeeded, skipped}` 改为只读预览 `{items[]}`。 */
export type AutoDispatchPreviewDto = AutoDispatchResultSchema;

/** `AutoDispatchPreviewDto.items[]` 元素（rust AutoDispatchItem）。 */
export type AutoDispatchPreviewItem = AutoDispatchResultSchema['items'][number];

/** `skip_reason` 字符串 → 中文文案（前端 UI 展示用，后端只给 ASCII 枚举）。
 *  2026-09-30：后端 auto-dispatch 改为只读 preview 后，「无工序链」不再走
 *  20706 业务错，而是以 `skip_reason` 形式出现在 items 里
 *  （batches.md §AutoDispatchResult / batch/service.rs:273-292）。 */
export const AUTO_DISPATCH_SKIP_REASON_LABELS: Record<string, string> = {
  NOT_FOUND: '批次不存在或已非 PENDING',
  NO_PROCESS_CHAIN: '工单未制定工序链',
  NO_PROCESS_STEP: '工序链无可用步骤',
  NO_SHELF: '首道工序未配置货架',
};

/** GET /api/v2/prod/batches/pending —— 拉取待下发批次列表。 */
export async function fetchPendingBatches(
  params: ListPendingBatchesParams = {},
): Promise<PendingBatchListDto> {
  const resp = await api.get<PendingBatchListDto>('/prod/batches/pending', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** POST /api/v2/prod/batches/dispatch —— 下发（bulk-only）。
 *  2026-09-30：单条与批量合并为同一函数 —— 单条传 `targets.length === 1`。
 *  响应经 `dispatchResultSchema.parse()` 守门 —— 后端字段漂移立刻抛 ZodError
 *  而非运行时 `undefined.length`（首轮 bug 根因）。 */
export async function dispatchBatches(req: DispatchRequest): Promise<DispatchBatchResultDto> {
  const resp = await api.post<unknown>('/prod/batches/dispatch', req);
  return dispatchResultSchema.parse(resp.data);
}

/** POST /api/v2/prod/batches/auto-dispatch —— **只读预览**（2026-09-30 语义变更）。
 *  不写库、不发 WS。返回每个 batch 的「首道工序 + 首货架 + skip_reason」，
 *  caller 据此构造 `targets: [{batch_id, target_process_id: first_process_id}]`
 *  调 dispatchBatches 真正下发。
 *  响应经 `autoDispatchResultSchema.parse()` 守门。 */
export async function previewAutoDispatch(
  req: AutoDispatchPreviewRequest,
): Promise<AutoDispatchPreviewDto> {
  const resp = await api.post<unknown>('/prod/batches/auto-dispatch', req);
  return autoDispatchResultSchema.parse(resp.data);
}
