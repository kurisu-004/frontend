// 生产队列域前端 API（v2，baseURL `/api/v2`，前缀 `/prod/queue/*`）。
//
// 2026-10-08 域改名与收敛（后端 `prod::worker_pool` → `prod::queue`，URL **硬切**无
// alias；下发流与召回从 batch 域剥离进 queue 域）：
//   - 读路径：`/pool/counts` + `/pool/{process_id}` + `/pool/state` 三条聚合成两条
//     只读端点 —— `/queue/snapshot`（各工序候选数 + 待下发总数）与
//     `/queue/processes/{id}`（单工序看板：工人列内联持有批次 + 候选池）；
//   - 下发 / 召回：`/batches/pending`、`/batches/dispatch`、
//     `/batches/auto-dispatch`、`/batches/{batch_id}/recall-to-pending` 四个端点
//     统一迁到 `/queue/pending`、`/queue/dispatch`、`/queue/auto-dispatch`、
//     `/queue/recall`（recall 的 `batch_id` 同时从路径参数改成了 body 字段）。
//
// 分层取舍（本文件**不做** Zod 守门）：本域的 Zod schema 随视图目录走
// （`views/production/queue/composables/productionQueueSchema.ts`，与 dashboard 域同款
// 做法），api 层若 import 它就是 api → views 的反向依赖。故这里的函数一律返回
// 契约 DTO，守门由消费方 composable 在 queryFn / mutationFn 里
// `xxxSchema.parse(await fetchXxx())` 完成 —— 效果等价，且守门点与「谁驱动渲染」
// 落在同一层。
//
// 所有请求体里的雪花 ID 都必须是 **JSON 字符串**（后端 `deserialize_i64` 只收字符串，
// 发数字返 40001）。

import { api, cleanParams } from '@/api/http';
import type {
  AutoAllocateRequest,
  AutoAllocateResultDto,
  AutoDispatchPreviewDto,
  AutoDispatchPreviewRequest,
  DispatchRequest,
  DispatchResultDto,
  ListQueuePendingParams,
  MoveRequest,
  MoveResultDto,
  QueueBoardDto,
  QueuePendingBatchListDto,
  QueueRefillRequest,
  QueueRefillResultDto,
  QueueSnapshotDto,
  RecallOutDto,
  RecallRequest,
} from './productionQueue.contract';

// 只再导出 `ListQueuePendingParams`：它被共享文件 `composables/queries/keys.ts` 以
// `@/api/productionQueue` 为路径 import（query 键工厂的入参类型不该让 keys.ts 知道
// contract 文件名）。**其余契约类型一律从 `@/api/productionQueue.contract` 直接取**
// —— 视图层 / composable / scan 域共 14 个文件都是这么写的，本仓 `.contract` 文件
// （`processChain.contract.ts`）也是同一形态：contract 本身就是「给人直接 import 的
// 契约文件」，api 入口只透传 runtime 函数。曾经这里再导出全部 25 个类型、并注释
// 「视图层从 api 层入口取类型」，实际零消费方遵守，等于凭空多一层可绕过的入口。
export type { ListQueuePendingParams } from './productionQueue.contract';

/** GET /api/v2/prod/queue/snapshot —— 队列页两个徽标的唯一数据源
 *  （工序 tab 标题 `(N)`、「待下发」tab 标题 `(N)`），外加右栏工序卡的候选数与
 *  工序色。**单请求**覆盖全部工序 ⇒ 进页面不发 per-process 详情。
 *  无 query 参数（按 process_id GROUP BY 跨所有货架聚合，没有 shelf 维度）。
 *  `processes[]` 只含候选数 > 0 的工序；`pending_count` 是待下发**真实总数**。 */
export async function fetchQueueSnapshot(): Promise<QueueSnapshotDto> {
  const resp = await api.get<QueueSnapshotDto>('/prod/queue/snapshot');
  return resp.data;
}

/** GET /api/v2/prod/queue/processes/{process_id} —— 单工序看板全量。
 *  一次返回：工序元数据 + 可执行该工序的工人（**内联 held_batches 与容量三字段**）
 *  + 该工序**跨所有货架**的候选池全量（不分页）。
 *  业务错：20801 BIZ_PROCESS_NOT_FOUND。
 *  懒加载：仅在对应 el-tab-pane 首次激活时由 ProcessBoardTab 发起。 */
export async function fetchQueueBoard(processId: string): Promise<QueueBoardDto> {
  const resp = await api.get<QueueBoardDto>(
    `/prod/queue/processes/${encodeURIComponent(processId)}`,
  );
  return resp.data;
}

/** GET /api/v2/prod/queue/pending —— 待下发批次列表（PENDING / PROGRAMMING）。
 *  只接 limit / offset；`total` 是匹配总数，不受 items 截断影响。 */
export async function fetchPendingBatches(
  params: ListQueuePendingParams = {},
): Promise<QueuePendingBatchListDto> {
  const resp = await api.get<QueuePendingBatchListDto>('/prod/queue/pending', {
    params: cleanParams(params),
  });
  return resp.data;
}

/** POST /api/v2/prod/queue/dispatch —— 下发（bulk-only）。
 *  单条与批量共用：单条传 `targets.length === 1`。货架由后端按
 *  `target_process_id` 解析（20508 = 无可用货架）。
 *  业务错：20120（非 PENDING）/ 20121 / 20508 / 40901 / 40300 / 40001。 */
export async function dispatchBatches(req: DispatchRequest): Promise<DispatchResultDto> {
  const resp = await api.post<DispatchResultDto>('/prod/queue/dispatch', req);
  return resp.data;
}

/** POST /api/v2/prod/queue/auto-dispatch —— **只读预览**，不写库、不发 WS。
 *  返回每个批次的「首道工序 + 首货架 + skip_reason」，caller 据此构造
 *  `targets: [{ batch_id, target_process_id: first_process_id }]` 调 dispatch 真正下发。 */
export async function previewAutoDispatch(
  req: AutoDispatchPreviewRequest,
): Promise<AutoDispatchPreviewDto> {
  const resp = await api.post<AutoDispatchPreviewDto>('/prod/queue/auto-dispatch', req);
  return resp.data;
}

/** POST /api/v2/prod/queue/recall —— 已下发批次召回为待下发。
 *  批次可在货架上（候选池）或在工人持有中，两条路径共用本函数。
 *  - `batch_id` 是 **body 字段**（非路径参数）且必须发 JSON 字符串；
 *  - `version` 必填（取自卡片 model 的 `t_part_batch.version`），缺省 40001；
 *  - 副作用：status → PENDING，且 location / current_holder_id /
 *    current_process_id / current_process_step_id 四列一起清 NULL。
 *  业务错：20120（源状态不允许）/ 20121 / 40901 / 40300。 */
export async function recallToPending(req: RecallRequest): Promise<RecallOutDto> {
  const resp = await api.post<RecallOutDto>('/prod/queue/recall', req);
  return resp.data;
}

/** POST /api/v2/prod/queue/move —— 通用移动端点（POOL ↔ WORKER + WORKER → WORKER）。
 *  关键不变量见 contract 的 MoveRequest 注释（`from` 必须等于批次真实位置，
 *  否则 20122）。target process 由后端自推，前端不传。
 *  业务错：20121 / 20120 / 20122（from 不符）/ 20202 / 20204 / 20104 / 20507 /
 *  40901 / 40300 / 40001。 */
export async function moveBatch(req: MoveRequest): Promise<MoveResultDto> {
  const resp = await api.post<MoveResultDto>('/prod/queue/move', req);
  return resp.data;
}

/** POST /api/v2/prod/queue/auto-allocate —— 按 process + shelf 范围为每个匹配工人
 *  自动抢批次数 / 工时（`mode` 决定单位）。
 *  业务错：20704（fill_ratio 越界）/ 20705 / 20904 / 20905 / 20801。 */
export async function autoAllocate(req: AutoAllocateRequest): Promise<AutoAllocateResultDto> {
  const resp = await api.post<AutoAllocateResultDto>('/prod/queue/auto-allocate', req);
  return resp.data;
}

/** POST /api/v2/prod/queue/refill —— 为指定工人抢满 `work_type.max_held_batches`
 *  （同事务）。业务错：20202 / 20206 / 20904 / 20905。 */
export async function refillQueue(req: QueueRefillRequest): Promise<QueueRefillResultDto> {
  const resp = await api.post<QueueRefillResultDto>('/prod/queue/refill', req);
  return resp.data;
}

/** `skip_reason` 字符串 → 中文文案（前端 UI 展示用，后端只给 ASCII 枚举）。
 *  NOT_FOUND 的文案按「不存在**或**状态不可下发」表述 —— 后端把历史 PROGRAMMING
 *  批次也纳入可下发白名单，按状态枚举命名会随白名单变动而失准。 */
export const AUTO_DISPATCH_SKIP_REASON_LABELS: Record<string, string> = {
  NOT_FOUND: '批次不存在或状态不可下发',
  NO_PROCESS_CHAIN: '工单未制定工序链',
  NO_PROCESS_STEP: '工序链无可用步骤',
  NO_SHELF: '首道工序未配置货架',
};
