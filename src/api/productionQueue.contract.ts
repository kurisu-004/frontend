// 2026-10-08 重写：生产队列域（queue）前端 wire 契约（types only，无 runtime）。
//
// 端点（baseURL `/api/v2`，前缀 `/prod/queue/*`，**无 alias**）：
//   GET  /api/v2/prod/queue/snapshot                  ← fetchQueueSnapshot
//   GET  /api/v2/prod/queue/processes/{process_id}    ← fetchQueueBoard
//   POST /api/v2/prod/queue/move                      ← moveBatch
//   POST /api/v2/prod/queue/auto-allocate             ← autoAllocate
//   POST /api/v2/prod/queue/refill                    ← refillQueue
//   GET  /api/v2/prod/queue/pending                   ← fetchPendingBatches
//   POST /api/v2/prod/queue/dispatch                  ← dispatchBatches
//   POST /api/v2/prod/queue/auto-dispatch             ← previewAutoDispatch
//   POST /api/v2/prod/queue/recall                    ← recallToPending
//
// RBAC（各端点 service 层守卫，本仓靠 token 拦截器）：
//   - 读端点（snapshot / processes / pending）：Manager + Clerk + Inspector；
//   - 写端点（move / auto-allocate / refill / dispatch / auto-dispatch）：
//     Manager（部分操作放开 Clerk，见各函数注释）；
//   - recall：Manager 或 Clerk。
//
// 错误码（跨域共用的 2xxxx / 4xxxx 段，完整表见后端 `docs/api/production/queue.md`）：
//   20120 BIZ_BATCH_INVALID_STATUS   批次状态不允许该操作
//   20121 BIZ_BATCH_NOT_FOUND        批次不存在
//   20122 BIZ_BATCH_LOCATION_MISMATCH move 的 from 与批次实际位置不符
//   20104 BIZ_WORKER_PROCESS_MISMATCH 工人工种不含该批次工序
//   20202 WORKER_INACTIVE            工人已停用
//   20204 WORKER_CAPACITY_FULL       工人持有数已达 max_held
//   20206 WORKER_NO_WORK_TYPE        工人无工种
//   20507 SHELF_PROCESS_NOT_MAPPED   目标货架未映射该工序
//   20508 SHELF_PROCESS_NOT_FOUND    该工序无可用货架（下发解析不到货架）
//   20704 AUTO_ALLOCATE_INVALID_RATIO fill_ratio ∉ [0,1]
//   20705 AUTO_ALLOCATE_NO_WORKERS   范围内无可分配工人
//   20801 PROCESS_NOT_FOUND          工序不存在
//   20904 WORK_TYPE_MAX_HELD_NOT_SET 工种未设置 max_held_batches
//   20905 NO_PROCESS_MAPPING        工种未映射该工序
//   40901 VERSION_CONFLICT          OCC 乐观锁冲突（HTTP 409）
//   40300 FORBIDDEN                 角色无权（HTTP 403）
//   40001 VALIDATION_ERROR          入参不合法（HTTP 422）
//
// wire 层形态约定：
//   - i64 主键 → JSON **字符串**（雪花 ID 防 JS 精度截断）。⚠️ 请求体里的雪花 ID
//     同样必须发字符串 —— 后端 `deserialize_i64` 只接受字符串，发数字返 40001。
//   - `Option<T>` 字段在 rust 侧未加 `skip_serializing_if` 时序列化为 `null`；
//     加了则**整个字段从 JSON 省略** ⇒ 契约按「可能缺省」标注（`?:` / `| undefined`）。
//   - 计数（`pool_count` / `total` / `capacity_remaining` / `max_held` 等）是
//     COUNT/算术结果，JSON integer，前端 `number`。
//   - `ts` 是 RFC3339 带 `+08:00` 偏移的字符串（`2026-10-08T09:12:33+08:00`），
//     前端只在需要展示/对比时用，**不**做 Date 解析（避免浏览器时区与服务端错位）。

/** `GET /api/v2/prod/queue/snapshot` 出参（rust QueueSnapshot）。
 *  队列页的两个徽标数据源：工序 tab 标题 `(N)` 与「待下发」tab 标题 `(N)`。
 *  processes[] 只含 `pool_count > 0` 的工序（零候选的工序不出现），
 *  因此右栏「待下发」工序卡仍需与 `useProcessesQuery` 的工序列表 join 才能拿到
 *  `color` / `category` 等只在该列表上出现的字段。 */
export interface QueueSnapshotDto {
  processes: QueueProcessDto[];
  /** 待下发批次数（PENDING / PROGRAMMING 两个状态合计）。
   *  这是**真实总数**，不是当前页长度 —— 「待下发」列表按 limit 分页，
   *  tab 标题用 `batches.length` 会在超过一页时低报。 */
  pending_count: number;
  /** 服务端生成快照时刻（RFC3339 带 +08:00）。 */
  ts: string;
}

/** `QueueSnapshotDto.processes[]` 元素（rust QueueProcess）。
 *  pool_count 是该工序的候选批次数，**跨所有货架**聚合（候选池不是按货架切的）。 */
export interface QueueProcessDto {
  process_id: string;
  process_code: string;
  process_name: string;
  /** `t_process.color`，形如 `#RRGGBBAA`（9 字符，含 alpha）；未设置时 null。
   *  直接喂 CSS `border-left-color`，前端不做字符串加工。 */
  color: string | null;
  category: 'INHOUSE' | 'OUTSOURCE';
  pool_count: number;
}

/** `GET /api/v2/prod/queue/processes/{process_id}` 出参（rust QueueBoard）。
 *  **单工序一个请求拿全**：`workers[]` 内联了每个工人的持有批次与容量三字段、
 *  `items[]` 是该工序的候选池。工人列组件零请求。 */
export interface QueueBoardDto {
  process: QueueBoardProcessDto;
  workers: QueueWorkerDto[];
  items: QueuePoolItemDto[];
  /** = items.length（候选池不分页，全量返回）。 */
  total: number;
  ts: string;
}

/** `QueueBoardDto.process`（rust QueueBoardProcess）。4 字段。 */
export interface QueueBoardProcessDto {
  process_id: string;
  process_code: string;
  process_name: string;
  /** 同 QueueProcessDto.color：9 字符含 alpha，未设置时 null。 */
  color: string | null;
}

/** `QueueBoardDto.workers[]` 元素（rust QueueWorker）。7 字段：
 *  持有批次（`held_batches`）与容量三字段（`max_held` / `current_held` /
 *  `capacity_remaining`）全部内联 ⇒ 工人列不再自己发请求。
 *
 *  `max_held` 取自工种 `t_work_type.max_held_batches`；工种未设置时后端返 0，
 *  此时 `capacity_remaining` 恒 0（无可派活容量），前端进度条按 0% 渲染。 */
export interface QueueWorkerDto {
  worker_id: string;
  name: string;
  work_type_code: string;
  /** 工人编号牌；未设置时后端返空串（不返 null）。 */
  badge_code: string;
  max_held: number;
  /** 当前持有批次数（IN_PROCESS + WORKER + current_holder_id = worker_id）。 */
  current_held: number;
  /** max(0, max_held - current_held)。 */
  capacity_remaining: number;
  held_batches: QueueHeldBatchDto[];
}

/** `QueueWorkerDto.held_batches[]` 元素（rust QueueHeldBatch）。17 字段。
 *  字段集与 QueuePoolItemDto 的差别（都经 `views/production/queue/utils/queueItemToCard.ts`
 *  适配成同一个 BatchCardModel，组件零 DTO 依赖）：
 *   - 多了 `planned_delivery_date`（已下发的批次期望有计划交期）；
 *   - 没有 `shelf_id` / `shelf_code` / `shelf_name`（批次在工人手里，没有货架位置），
 *     取而代之的是 `location`（`t_part_batch.location` 枚举原始值，held 态恒 'WORKER'）；
 *   - 客户名两级：`customer_name` = L2 客户名（叶子），`parent_customer_name` = L1
 *     客户名（一级集团）。 */
export interface QueueHeldBatchDto {
  /** `t_part_batch.id`，雪花 ID。 */
  batch_id: string;
  /** `t_part.id`，雪花 ID。 */
  part_id: string;
  batch_no: number;
  quantity: number;
  /** `t_part.serial_no`。 */
  serial_no: string | null;
  /** `t_part.name`（零件 / 工单名称）。 */
  name: string;
  /** `t_part.drawing_no`。 */
  drawing_no: string;
  /** `t_part.system_delivery_date`（系统推算交期，ISO `YYYY-MM-DD`）。 */
  system_delivery_date: string | null;
  /** `t_part.planned_delivery_date`（计划交期，ISO `YYYY-MM-DD`）。 */
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** 是否已上传 G 代码（`t_part_file` EXISTS 派生）；UI 据此渲染「已编程」tag。 */
  has_cnc_program: boolean;
  customer_name: string | null;
  parent_customer_name: string | null;
  /** `t_applicant.name`。 */
  applicant_name: string | null;
  /** `t_part_batch.location` 枚举原始值（held 态恒 'WORKER'）。 */
  location: string;
  /** `t_part.note`。 */
  note: string | null;
  /** OCC 乐观锁 version（召回 / move 的入参锚）。 */
  version: number;
}

/** `QueueBoardDto.items[]` 元素（rust QueuePoolItem）。18 字段。
 *  候选 = `IN_PROCESS` + `PRODUCTION_SHELF` + 未删除，按批次当前工序维度匹配。
 *
 *  `shelf_id` 保留的理由：`POST /queue/move` 的 `from: {kind:'POOL', shelf_id}`
 *  **必须等于批次真实所在货架**（候选池跨所有货架，不能拿用户当前激活货架凑），
 *  填错后端返 20122。前端经卡片 `:data-shelf-id` → DOM dataset → `recordPoolSource`
 *  这条链把它带到落点的 move 请求里。 */
export interface QueuePoolItemDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  quantity: number;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  /** `t_part.system_delivery_date`；候选池只关心系统交期，没有 planned 字段。 */
  system_delivery_date: string | null;
  customer_name: string | null;
  parent_customer_name: string | null;
  applicant_name: string | null;
  /** `t_part_batch.current_holder_id` = 批次所在货架 id（move 的 `from.shelf_id` 数据源）。 */
  shelf_id: string;
  /** `t_shelf.code`。 */
  shelf_code: string;
  /** `t_shelf.name`。 */
  shelf_name: string;
  is_urgent: boolean;
  has_cnc_program: boolean;
  /** `t_part.note`。 */
  note: string | null;
  version: number;
}

/** `GET /api/v2/prod/queue/pending` 入参形态（rust ListQueuePendingQuery）。
 *  只接 limit / offset 两个 query 参数（service 层 clamp limit ∈ [1,500]）。 */
export interface ListQueuePendingParams {
  /** 默认 200；service clamp(1, 500)。 */
  limit?: number;
  /** 默认 0；service max(0)。 */
  offset?: number;
}

/** `GET /api/v2/prod/queue/pending` 出参（rust QueuePendingBatchList）。 */
export interface QueuePendingBatchListDto {
  items: QueuePendingBatchDto[];
  /** 匹配总数，**不受 items 截断影响**（面板「总计 N 件」用它）。 */
  total: number;
  limit: number;
  offset: number;
}

/** `QueuePendingBatchListDto.items[]` 元素（rust PendingBatchItem）。17 字段。
 *
 *  `planned_delivery_date` 是**非 null** 字符串：待下发批次必然已制定计划交期，
 *  后端对 NULL 兜底为 `1970-01-01`（不要拿它做「无交期」判据）；
 *  `system_delivery_date` 才是 nullable。
 *
 *  ⚠️ 末两项在后端是**非 Option 的 i64**（`unwrap_or(0)`），故声明为非 null string：
 *  DB 列为 NULL 时后端投影成 `"0"`，前端按 `=== '0'` 判「未挂」。判据不要写成
 *  「缺失 / null」—— 那两种形态在这条契约上不存在。 */
export interface QueuePendingBatchDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  quantity: number;
  serial_no: string | null;
  name: string;
  drawing_no: string;
  /** 计划交付日，非 null（NULL 已被后端兜底为 `1970-01-01`）。 */
  planned_delivery_date: string;
  /** 系统推算交付日，nullable。 */
  system_delivery_date: string | null;
  customer_name: string | null;
  parent_customer_name: string | null;
  applicant_name: string | null;
  is_urgent: boolean;
  note: string | null;
  version: number;
  /** `t_part_batch.current_process_step_id`；`"0"` = DB 列为 NULL = 未挂 step。
   *  待下发批次按定义尚未挂 step，值恒 `"0"`。 */
  current_process_step_id: string;
  /** `t_part.process_chain_id`；`"0"` = 工单未制定工序链。 */
  process_chain_id: string;
}

/** `POST /api/v2/prod/queue/recall` 请求（rust RecallRequest）。
 *  - `batch_id` 从路径参数改成了 **body 字段**，且必须发 **JSON 字符串** ——
 *    后端 `deserialize_i64` 只接受字符串，发数字返 40001；
 *  - `version` 必填（OCC 乐观锁，无 `#[serde(default)]` ⇒ 缺省 40001）。 */
export interface RecallRequest {
  batch_id: string;
  version: number;
  /** 可选，写入事件 `note`。 */
  note?: string;
}

/** `POST /api/v2/prod/queue/recall` 出参（rust RecallOut）。3 字段。
 *  `version` 是召回后的新版本（`batch.version + 1`），前端**当前零消费** ——
 *  列表下一次拉取即拿到新值，保留字段是为了「不因未消费就少声明」。 */
export interface RecallOutDto {
  batch_id: string;
  part_id: string;
  version: number;
}

/** `POST /api/v2/prod/queue/refill` 请求（rust QueueRefillRequest）。 */
export interface QueueRefillRequest {
  worker_id: string;
  shelf_id: string;
}

/** `POST /api/v2/prod/queue/move` 的 `from` / `to` tagged enum
 *  （rust MoveLocation，`#[serde(tag = "kind", rename_all = "UPPERCASE")]`）：
 *    {"kind":"POOL",   "shelf_id":"100"}
 *    {"kind":"WORKER", "worker_id":"50"} */
export type MoveLocationDto =
  | { kind: 'POOL'; shelf_id: string }
  | { kind: 'WORKER'; worker_id: string };

/** `POST /api/v2/prod/queue/move` 请求（rust MoveRequest）。三个移动方向：
 *  | from    | to      | 说明                                        |
 *  |---------|---------|--------------------------------------------|
 *  | POOL    | WORKER  | 候选池 → 工人（派活）                       |
 *  | WORKER  | POOL    | 工人 → 候选池（撤回，落在目标货架）         |
 *  | WORKER  | WORKER  | 工人之间转交                               |
 *  | POOL    | POOL    | 非法 → 40001                               |
 *
 *  不变量（前端必须遵守，否则 409 / 422）：
 *  - `from` 必与批次当前 `(location, current_holder_id)` 严格一致，否则 **20122**
 *    （HTTP 409）；
 *  - `to.kind = 'POOL'`：目标货架必须映射到批次当前工序，否则 **20507**（HTTP 422）；
 *  - `to.kind = 'WORKER'`：工人须在岗、工种含批次当前工序、持有数 < max_held，
 *    否则 20202 / 20104 / 20204。
 *  move 不推进工序链（不写 `current_process_step_id`），目标工序由后端从批次当前
 *  step 自推 ⇒ 前端不需要也不该传 process_id。 */
export interface MoveRequest {
  batch_id: string;
  from: MoveLocationDto;
  to: MoveLocationDto;
  note?: string;
}

/** `TakenItem`（rust TakenItem）—— 既是 `RefillResult.taken[]` 的元素，
 *  也是 `MoveResult.taken`（仅 POOL→WORKER 时填）的元素。11 字段。
 *  字段比 QueuePoolItemDto 窄：只有 move / refill 响应真正需要的部分。 */
export interface TakenItemDto {
  batch_id: string;
  part_id: string;
  batch_no: number;
  quantity: number;
  serial_no: string | null;
  drawing_no: string;
  system_delivery_date: string | null;
  planned_delivery_date: string | null;
  is_urgent: boolean;
  /** 移动 / 抢批后的 batch.version。 */
  version: number;
  has_cnc_program: boolean;
}

/** `POST /api/v2/prod/queue/refill` 出参（rust RefillResult）。4 字段。 */
export interface QueueRefillResultDto {
  worker_id: string;
  shelf_id: string;
  /** 本次抢到的批次。 */
  taken: TakenItemDto[];
  /** 是否池空（前端按 `pool_empty + taken.length` 综合判断）。 */
  pool_empty: boolean;
}

/** `POST /api/v2/prod/queue/move` 出参（rust MoveResult）。10 字段。
 *
 *  ⚠️ `current_held` / `max_held` / `shelf_id` / `taken` 四个字段在 rust 侧都带
 *  `#[serde(skip_serializing_if = "Option::is_none")]` ⇒ 条件不满足时**整个字段从
 *  JSON 省略**（不是 null）。契约按 `?: T | null` 标注（undefined 与 null 都可能），
 *  Zod 侧必须 `.nullish()`，用 `.nullable()` 会在真实响应上抛错。 */
export interface MoveResultDto {
  batch_id: string;
  /** 入参 `from.kind` 的字面回显。 */
  from_kind: 'POOL' | 'WORKER';
  /** 入参 `to.kind` 的字面回显。 */
  to_kind: 'POOL' | 'WORKER';
  /** 移动后 `batch.current_holder_id`（POOL 时 = shelf_id；WORKER 时 = worker_id）。 */
  new_holder_id: string;
  /** 移动后 `batch.location`（'PRODUCTION_SHELF' / 'WORKER'）。 */
  new_location: string;
  /** `batch.version + 1`。 */
  version: number;
  /** 仅 to_kind=WORKER 时填：目标工人移动后持有数（含本批次）。 */
  current_held?: number | null;
  /** 仅 to_kind=WORKER 时填：目标工种的 max_held_batches。 */
  max_held?: number | null;
  /** 货架雪花 ID：POOL→WORKER 填 `from.shelf_id`、WORKER→POOL 填 `to.shelf_id`、
   *  WORKER→WORKER 不填（字段整体省略）。 */
  shelf_id?: string | null;
  /** 仅 POOL→WORKER 时填：从候选池取出的批次详情。 */
  taken?: TakenItemDto | null;
}

/** 自动分配模式：`COUNT` 按批次数填满；`TIME` 按累计预估工时填满。 */
export type AutoAllocateMode = 'COUNT' | 'TIME';

/** `POST /api/v2/prod/queue/auto-allocate` 请求（rust AutoAllocateRequest）。 */
export interface AutoAllocateRequest {
  process_id: string;
  shelf_id: string;
  mode: AutoAllocateMode;
  /** 填充比例 ∈ [0, 1]；越界 → 20704（HTTP 422）。 */
  fill_ratio: number;
}

/** `POST /api/v2/prod/queue/auto-allocate` 出参（rust AutoAllocateResult）。 */
export interface AutoAllocateResultDto {
  process_id: string;
  shelf_id: string;
  mode: AutoAllocateMode;
  fill_ratio: number;
  filled: WorkerFillItemDto[];
  /** 任一工人中途遇「池空 / 容量触顶」。 */
  pool_empty: boolean;
}

/** `AutoAllocateResultDto.filled[]` 元素（rust WorkerFillItem）。 */
export interface WorkerFillItemDto {
  worker_id: string;
  /** 目标：COUNT = 批次数；TIME = 累计分钟数。 */
  target: number;
  /** 实际抢到的批次 / 工时（与 target 同单位）。 */
  filled_count: number;
  /** 跳过原因（如「工种 max_held 未设置」）；存在 ⇒ 该工人被跳过。
   *  rust 侧 `skip_serializing_if` ⇒ 可能整个字段缺失。 */
  skipped_reason?: string | null;
}

/** `POST /api/v2/prod/queue/dispatch` 单条 target（rust DispatchTarget）。 */
export interface DispatchTarget {
  batch_id: string;
  target_process_id: string;
}

/** `POST /api/v2/prod/queue/dispatch` 请求（rust DispatchRequest）。
 *  **bulk-only**：单条下发即 `targets.length === 1`；多条按数组顺序执行，任一硬失败
 *  → service 抛 AppError、handler 的事务 drop 回滚全部 succeeded 写入。
 *  空 targets → 40001（HTTP 422）。
 *
 *  不带 shelf_id / version：货架由 service 按 `target_process_id` 在 `t_shelf_process`
 *  解析（sort_order ASC, id ASC LIMIT 1），0 结果 → 20508。 */
export interface DispatchRequest {
  targets: DispatchTarget[];
  /** 可选，落到全部 `t_part_event.note`。 */
  note?: string;
}

/** `POST /api/v2/prod/queue/dispatch` 出参（rust DispatchResult）。
 *  `failed` 当前恒空（任一失败即全回滚），且 rust 侧
 *  `skip_serializing_if = "Vec::is_empty"` 会省略空数组 ⇒ 前端按可缺省处理。 */
export interface DispatchResultDto {
  /** 成功下发的批次列表（顺序与 `req.targets` 一致）。 */
  succeeded: DispatchSuccessItemDto[];
  /** 预留 partial commit（当前恒空 / 可能整体省略）。 */
  failed?: DispatchFailureItemDto[];
}

/** `DispatchResultDto.succeeded[]` 元素（rust DispatchSuccessItem）。6 字段。 */
export interface DispatchSuccessItemDto {
  batch_id: string;
  /** dispatch 路径不解析工序链步骤 ⇒ Option 为 None ⇒ 后端返 null。 */
  current_process_step_id: string | null;
  /** 下发后写入 `t_part_batch.current_process_id` 的值，恒等于本次
   *  `target_process_id`。后端保留 Option 形态（None → JSON `null`）。 */
  current_process_id: string | null;
  target_process_id: string;
  /** service 按 `target_process_id` 在 `t_shelf_process` 解析出的货架。 */
  shelf_id: string;
  version: number;
}

/** `DispatchResultDto.failed[]` 元素（rust DispatchFailureItem）。 */
export interface DispatchFailureItemDto {
  batch_id: string;
  code: number;
  message: string;
}

/** `POST /api/v2/prod/queue/auto-dispatch` 请求（rust AutoDispatchRequest）。
 *  后端是 `Option<Vec<i64>>` + `deserialize_i64_vec_opt`：缺省 / null / 空数组
 *  三种形态都返 40001 ⇒ 前端保证非空。 */
export interface AutoDispatchPreviewRequest {
  batch_ids: string[];
}

/** `POST /api/v2/prod/queue/auto-dispatch` 出参（rust AutoDispatchResult）。
 *  **只读预览**：不写库、不发 WS。返回每个批次的「首道工序 + 首货架 + skip_reason」，
 *  caller 据此构造 `targets` 调 dispatch 真正下发。
 *  可下发判定：`skip_reason === null` 且 `first_process_id !== null`。 */
export interface AutoDispatchPreviewDto {
  /** 按 `req.batch_ids` 入参顺序稳定排序。 */
  items: AutoDispatchItemDto[];
}

/** `AutoDispatchPreviewDto.items[]` 元素（rust AutoDispatchItem）。 */
export interface AutoDispatchItemDto {
  batch_id: string;
  part_id: string;
  /** `skip_reason = NO_PROCESS_CHAIN` 时为 null。 */
  process_chain_id: string | null;
  /** 可下发时的首道工序 id；NO_PROCESS_CHAIN / NO_PROCESS_STEP 时为 null
   *  （NO_SHELF 时仍非 null —— 首道工序存在但没配货架）。 */
  first_process_id: string | null;
  /** 非 Option String：取不到时后端兜空串。 */
  first_process_code: string;
  /** 非 Option String：同上。 */
  first_process_name: string;
  /** 首货架 id；`skip_reason` 非 null 时通常为 null。 */
  first_shelf_id: string | null;
  /** NOT_FOUND / NO_PROCESS_CHAIN / NO_PROCESS_STEP / NO_SHELF 之一；null = 可下发。
   *  中文文案映射见 `productionQueue.ts::AUTO_DISPATCH_SKIP_REASON_LABELS`。 */
  skip_reason: string | null;
}
