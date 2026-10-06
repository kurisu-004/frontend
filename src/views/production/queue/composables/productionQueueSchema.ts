// 2026-10-08 新建：生产队列域（queue）的 Zod schema，随视图目录走
// （与 dashboard 域 `views/dashboard/composables/dashboardSnapshotSchema.ts` 同款做法），
// 不再寄居全局 `composables/queries/schemas.ts`：
//   - 本域 schema 只被本域自己的 composable 消费，全局 schemas.ts 是「跨域共享
//     基础数据」的 schema 集，queue 域的 9 个端点没有任何跨域消费方；
//   - api 层不 import 本文件（api → views 是反向依赖），守门由
//     `useQueueSnapshot` / `useQueueBoard` / `useQueueMove` / `useQueueDispatch`
//     在 queryFn / mutationFn 里 `xxxSchema.parse(await fetchXxx())` 完成。
//
// 契约来源：backend-rust 分支 `feat/queue-domain` 的 `src/modules/prod/queue/`
// （`docs/api/production/queue.md` 与 `vo/queue.rs` 两处**口径一致**，但该分支尚未
// 合入 master，别在 master 上找不到就以为契约不存在）。九个端点的 schema 覆盖情况：
//   - GET  /queue/snapshot                  → queueSnapshotSchema
//   - GET  /queue/processes/{process_id}    → queueBoardSchema（及其嵌套 4 组）
//   - GET  /queue/pending                   → queuePendingBatchListSchema
//   - POST /queue/move                      → moveRequestSchema / moveResultSchema
//   - POST /queue/dispatch                  → dispatchRequestSchema / dispatchResultSchema
//   - POST /queue/auto-dispatch             → autoDispatchRequestSchema / autoDispatchResultSchema
//   - POST /queue/recall                    → recallRequestSchema / recallOutSchema
//   - POST /queue/refill                    → refillResultSchema
//   - POST /queue/auto-allocate             → **无**（出参未声明，见下）
//
// ⚠️ 两处如实登记，不要按「九个端点各有守门」去推断覆盖面：
//   - `auto-allocate` 出参（`{process_id, shelf_id, mode, fill_ratio, filled[],
//     pool_empty}`）**未声明 schema**，`useQueueMove.runAutoAllocate` 的 mutationFn
//     也**没有** Zod parse（与 move 的 `moveResultSchema.parse` 不同款）。后果：
//     后端改 AutoAllocateResult 的字段名不会被任何测试或运行时抓到。补 schema 时
//     注意别复用 `refillResultSchema` —— 两者字段集完全不同（refill 是
//     `{worker_id, shelf_id, taken[], pool_empty}`，auto-allocate 是
//     `{process_id, shelf_id, mode, fill_ratio, filled[], pool_empty}`）。
//   - `refillResultSchema` 与它守的 `refillQueue()` 目前**零生产消费方**
//     （仓内只有自动分配走这条链路，没有「手动抢批」入口）。声明保留是为了改
//     auto-allocate 出参时有个同族参照，**它不是任何在跑的守门点**。
//
// 关键约束（沿仓内 queryFn Zod 守门 + Zod schema-first 两条约定）：
//   - 所有字段**显式声明**。Zod 默认 strip 会静默丢弃未声明字段，漏一个字段声明
//     守门就形同虚设（该失败模式在本仓已造成过「schema 声明了后端没有的字段 ⇒
//     parse 永远失败 ⇒ 页面永久「加载失败」」与反向的「漏声明 ⇒ 字段被静默丢掉
//     ⇒ 模板里出现 undefined」两类事故）；
//   - 雪花 ID 一律 string；计数 / version 一律 number；i64 主键在后端是 JSON 字符串，
//     绝不能声明 number；
//   - 可空字段一律 `.nullable()` 且**不给默认值**：后端显式返 null 与「字段缺失」
//     是两种状态，混起来会让下游的 `?? '—'` 把缺字段也渲染成「无值」而不是暴露漂移；
//   - 后端带 `skip_serializing_if` 的字段用 `.nullish()`（undefined 与 null 都收），
//     用 `.nullable()` 会在真实响应上抛错；
//   - 不强制长度 / 范围（DDL 边界是表单 schema 的职责）。

import { z } from 'zod';

/** `QueueSnapshot.processes[]` 元素（rust QueueProcess）。6 字段全声明。
 *  color 是 `t_process.color`（9 字符 `#RRGGBBAA` 含 alpha），未设置时 null ——
 *  前端直接把它喂给 CSS `border-left-color`，不做字符串加工，故**不能**收窄成
 *  正则 / 长度。 */
export const queueProcessSchema = z.object({
  process_id: z.string(),
  process_code: z.string(),
  process_name: z.string(),
  color: z.string().nullable(),
  category: z.enum(['INHOUSE', 'OUTSOURCE']),
  pool_count: z.number(),
});

export type QueueProcessSchema = z.infer<typeof queueProcessSchema>;

/** `GET /queue/snapshot` 顶层出参（rust QueueSnapshot）。3 字段。
 *
 *  - `processes[]` 只含 `pool_count > 0` 的工序（零候选的工序不出现），按
 *    `process_id` 升序 ⇒ 右栏工序卡仍需与工序列表 join 才能拿到「只有列表才有的」
 *    字段，不能拿本数组直接当工序全集；
 *  - `pending_count` 是待下发**真实总数**（PENDING / PROGRAMMING 合计），与
 *    `/queue/pending` 分页返回的 `items.length` 是两个数 —— tab 标题徽标必须用
 *    它，否则超过一页时会低报；
 *  - `ts` 是 RFC3339 带 `+08:00` 的字符串（**不**是 naive 时间串）。前端不做
 *    `new Date()` 解析，避免浏览器时区与服务端不一致把「新鲜度」算错。 */
export const queueSnapshotSchema = z.object({
  processes: z.array(queueProcessSchema),
  pending_count: z.number(),
  ts: z.string(),
});

export type QueueSnapshotSchema = z.infer<typeof queueSnapshotSchema>;

/** `QueueWorker.held_batches[]` 元素（rust QueueHeldBatch）。17 字段全声明。
 *  与 queuePoolItemSchema 的差别：多 `planned_delivery_date`、多 `location`，
 *  **没有** shelf_id / shelf_code / shelf_name（批次在工人手里，没有货架位置）。
 *  `location` 恒 'WORKER'（后端按 held 态判定），仍按 `z.string()` 收，不锁字面量 ——
 *  将来出现新的 held 形态（例如外协公司持有）时不必改 schema。 */
export const queueHeldBatchSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
  quantity: z.number(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  name: z.string(),
  system_delivery_date: z.string().nullable(),
  planned_delivery_date: z.string().nullable(),
  is_urgent: z.boolean(),
  has_cnc_program: z.boolean(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  applicant_name: z.string().nullable(),
  location: z.string(),
  note: z.string().nullable(),
  version: z.number(),
});

export type QueueHeldBatchSchema = z.infer<typeof queueHeldBatchSchema>;

/** `QueueWorker` 元素（rust QueueWorker）。8 字段。
 *
 *  `held_batches` 与容量三字段（`max_held` / `current_held` /
 *  `capacity_remaining`）由后端内联在工人对象里 —— 这三项 + 持有批次正是原先
 *  「每个工人列各发一次单工人 state 请求」的 N+1 来源，现在一次工序请求全部到齐，
 *  工人列组件零请求。
 *  `max_held` 取自工种 `t_work_type.max_held_batches`，工种未设置时后端返 0
 *  （不是 null）；此时 `capacity_remaining` 恒 0，前端进度条按 0% 渲染。 */
export const queueWorkerSchema = z.object({
  worker_id: z.string(),
  name: z.string(),
  work_type_code: z.string(),
  /** 工人编号牌；未设置时后端返空串而非 null。 */
  badge_code: z.string(),
  max_held: z.number(),
  current_held: z.number(),
  capacity_remaining: z.number(),
  held_batches: z.array(queueHeldBatchSchema),
});

export type QueueWorkerSchema = z.infer<typeof queueWorkerSchema>;

/** `QueueBoard.items[]` 元素（rust QueuePoolItem）。18 字段全声明。
 *
 *  ⚠️ `shelf_id` 是承重字段：`POST /queue/move` 的 `from: {kind:'POOL', shelf_id}`
 *  必须等于批次真实所在货架（候选池跨所有货架，不能拿用户当前激活货架凑），填错后端
 *  返 20122。前端经卡片 `:data-shelf-id` → DOM dataset → `recordPoolSource` 把它
 *  带到落点请求里 ⇒ 漏声明这一项的表现是「请求体少字段 / move 恒 20122」。
 *  `location` 原始枚举（'PRODUCTION_SHELF'）**不在**本 schema：位置由
 *  shelf_code 表达，卡片的 location 行渲染货架 code，原始枚举前端零消费。 */
export const queuePoolItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
  quantity: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  applicant_name: z.string().nullable(),
  shelf_id: z.string(),
  shelf_code: z.string(),
  shelf_name: z.string(),
  is_urgent: z.boolean(),
  has_cnc_program: z.boolean(),
  note: z.string().nullable(),
  version: z.number(),
});

export type QueuePoolItemSchema = z.infer<typeof queuePoolItemSchema>;

/** `GET /queue/processes/{process_id}` 顶层出参（rust QueueBoard）。5 字段。
 *  `total` = `items.length`（候选池不分页），两者都保留是为了让消费方能一处取到
 *  「头部数量」而不必再算一次 length。 */
export const queueBoardSchema = z.object({
  process: z.object({
    process_id: z.string(),
    process_code: z.string(),
    process_name: z.string(),
    color: z.string().nullable(),
  }),
  workers: z.array(queueWorkerSchema),
  items: z.array(queuePoolItemSchema),
  total: z.number(),
  ts: z.string(),
});

export type QueueBoardSchema = z.infer<typeof queueBoardSchema>;

/** `QueuePendingBatch` 元素（rust PendingBatchItem）。17 字段全声明。
 *
 *  `planned_delivery_date` 是**非 null** 字符串：待下发批次必然已制定计划交期，
 *  后端对 DB NULL 兜底为 `1970-01-01`。故前端**不能**拿它判「无交期」（会把兜底值
 *  显示成 1970 年），也没有哨兵值需要解释。
 *
 *  ⚠️ 末两项（`current_process_step_id` / `process_chain_id`）在后端是**非 Option
 *  的 `i64`**（`unwrap_or(0)` 兜底），故 Zod 侧按 `z.string()` 收、不给 nullable：
 *  DB 列为 NULL 时后端投影成 `"0"`，前端按 `=== '0'` 判「未挂」。判据**不能**改成
 *  「字段缺失或 null」—— 那两种形态在这条契约上不存在，认它们等于把真值当缺失。 */
export const queuePendingBatchSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
  quantity: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  planned_delivery_date: z.string(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  applicant_name: z.string().nullable(),
  is_urgent: z.boolean(),
  note: z.string().nullable(),
  version: z.number(),
  /** `t_part_batch.current_process_step_id`；DB 为 NULL 时后端返 `"0"` = 未挂 step。
   *  待下发批次按定义还没挂 step，值恒 `"0"`；保留它是为了让「已挂 / 未挂」在列表
   *  上可见（后续做「未挂 step 不可下发」之类的提示时不必再动契约）。 */
  current_process_step_id: z.string(),
  /** `t_part.process_chain_id`；未制定工序链时后端返 `"0"`。 */
  process_chain_id: z.string(),
});

export type QueuePendingBatchSchema = z.infer<typeof queuePendingBatchSchema>;

/** `GET /queue/pending` 顶层出参（rust QueuePendingBatchList）。4 字段。
 *  `total` 是匹配总数、**不受 items 截断影响** —— 面板「总计 N 件待下发」用它，
 *  用 items.length 会在触顶（默认 limit 200）时谎报。 */
export const queuePendingBatchListSchema = z.object({
  items: z.array(queuePendingBatchSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type QueuePendingBatchListSchema = z.infer<typeof queuePendingBatchListSchema>;

/** `TakenItem`（rust TakenItem）—— 既是 `RefillResult.taken[]` 的元素，也是
 *  `MoveResult.taken`（仅 POOL→WORKER 时填）的元素。
 *  声明在 refillResultSchema / moveResultSchema 之前：`z.array(takenItemSchema)` 在
 *  模块求值期就要取到该 const，提前声明避免 TDZ。 */
export const takenItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
  quantity: z.number(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  system_delivery_date: z.string().nullable(),
  planned_delivery_date: z.string().nullable(),
  is_urgent: z.boolean(),
  version: z.number(),
  has_cnc_program: z.boolean(),
});

export type TakenItemSchema = z.infer<typeof takenItemSchema>;

/** `POST /queue/refill` 出参（rust RefillResult）。4 字段。 */
export const refillResultSchema = z.object({
  worker_id: z.string(),
  shelf_id: z.string(),
  taken: z.array(takenItemSchema),
  pool_empty: z.boolean(),
});

export type RefillResultSchema = z.infer<typeof refillResultSchema>;

/** `POST /queue/move` 请求（rust MoveRequest）—— 出入参守门。
 *  `from` / `to` 是 tagged enum（`{"kind":"POOL","shelf_id"}` /
 *  `{"kind":"WORKER","worker_id"}`），故用 discriminatedUnion 按 kind 分派。 */
export const moveRequestSchema = z.object({
  batch_id: z.string(),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('POOL'), shelf_id: z.string() }),
    z.object({ kind: z.literal('WORKER'), worker_id: z.string() }),
  ]),
  to: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('POOL'), shelf_id: z.string() }),
    z.object({ kind: z.literal('WORKER'), worker_id: z.string() }),
  ]),
  note: z.string().optional(),
});

export type MoveRequestSchema = z.infer<typeof moveRequestSchema>;

/** `POST /queue/move` 出参（rust MoveResult）。10 字段。
 *
 *  ⚠️ `current_held` / `max_held` / `shelf_id` / `taken` 四字段在 rust 侧都带
 *  `#[serde(skip_serializing_if = "Option::is_none")]` ⇒ 条件不满足时**整个字段从
 *  JSON 省略**（不是 null）。故这四项用 `.nullish()`（同时接受 undefined 与 null），
 *  用 `.nullable()` 会在 WORKER→WORKER 等真实响应上直接抛 ZodError。 */
export const moveResultSchema = z.object({
  batch_id: z.string(),
  from_kind: z.enum(['POOL', 'WORKER']),
  to_kind: z.enum(['POOL', 'WORKER']),
  /** 移动后 `batch.current_holder_id`（POOL 时=shelf_id；WORKER 时=worker_id）。 */
  new_holder_id: z.string(),
  /** 移动后 `batch.location`（"PRODUCTION_SHELF" / "WORKER"）。 */
  new_location: z.string(),
  /** batch.version + 1 */
  version: z.number(),
  /** 仅 to_kind=WORKER 时填：目标工人移动后持有数（含本批次） */
  current_held: z.number().nullish(),
  /** 仅 to_kind=WORKER 时填：目标工种 max_held_batches */
  max_held: z.number().nullish(),
  /** 货架雪花 ID：POOL→WORKER 填 `from.shelf_id`、WORKER→POOL 填 `to.shelf_id`、
   *  WORKER→WORKER 不填（字段整体省略）。 */
  shelf_id: z.string().nullish(),
  /** 仅 POOL→WORKER 移动时填：从候选池取出的 batch 详情 */
  taken: takenItemSchema.nullish(),
});

export type MoveResultSchema = z.infer<typeof moveResultSchema>;

/** `POST /queue/dispatch` 请求（rust DispatchRequest）。
 *  `targets` 至少 1 条（空数组 → 40001 / HTTP 422）。 */
export const dispatchRequestSchema = z.object({
  targets: z
    .array(
      z.object({
        batch_id: z.string(),
        target_process_id: z.string(),
      }),
    )
    .min(1),
  note: z.string().optional(),
});

export type DispatchRequestSchema = z.infer<typeof dispatchRequestSchema>;

/** `DispatchResult.succeeded[]` 单条（rust DispatchSuccessItem）。6 字段。
 *  `current_process_id` 是下发后写入 `t_part_batch.current_process_id` 的值，
 *  恒等于本次 `target_process_id`；后端留 Option 形态，故用 `.nullable()`。 */
export const dispatchSuccessItemSchema = z.object({
  batch_id: z.string(),
  /** Option<i64>：dispatch 路径不解析工序链步骤 → None → JSON null。 */
  current_process_step_id: z.string().nullable(),
  /** 下发后 batch 当前工序；当前恒等于 `target_process_id`。 */
  current_process_id: z.string().nullable(),
  target_process_id: z.string(),
  /** service 按 target_process_id 在 t_shelf_process 解析出的货架
   *  （sort_order ASC, id ASC LIMIT 1）。 */
  shelf_id: z.string(),
  version: z.number(),
});

export type DispatchSuccessItemSchema = z.infer<typeof dispatchSuccessItemSchema>;

/** `DispatchResult.failed[]` 单条（rust DispatchFailureItem）。
 *  当前实现「任一失败 → 全回滚」，该数组恒空（预留 partial commit 未来扩展），
 *  schema 保留以防后端启用 partial commit。 */
export const dispatchFailureItemSchema = z.object({
  batch_id: z.string(),
  code: z.number(),
  message: z.string(),
});

export type DispatchFailureItemSchema = z.infer<typeof dispatchFailureItemSchema>;

/** `POST /queue/dispatch` 出参（rust DispatchResult）。2 字段。
 *  `failed` 用 `.default([])`：rust 侧 `skip_serializing_if = "Vec::is_empty"` 会把
 *  空数组整个从 JSON 中省略，而消费侧要在成功提示里读 `failed.length`。 */
export const dispatchResultSchema = z.object({
  /** 成功下发的批次列表（顺序与 req.targets 一致） */
  succeeded: z.array(dispatchSuccessItemSchema),
  failed: z.array(dispatchFailureItemSchema).default([]),
});

export type DispatchResultSchema = z.infer<typeof dispatchResultSchema>;

/** `POST /queue/auto-dispatch` 请求（rust AutoDispatchRequest）。
 *  后端是 `Option<Vec<i64>>` + `deserialize_i64_vec_opt`：缺省 / null / 空数组
 *  三种形态都返 40001，故锁死非空。 */
export const autoDispatchRequestSchema = z.object({
  batch_ids: z.array(z.string()).min(1),
});

export type AutoDispatchRequestSchema = z.infer<typeof autoDispatchRequestSchema>;

/** `AutoDispatchResult.items[]` 单条（rust AutoDispatchItem）。9 字段。
 *  `first_process_code` / `first_process_name` 是非 Option String（后端
 *  `unwrap_or_default()` 兜空串），漏声明会让真实响应被 strip 掉。 */
export const autoDispatchItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  /** Option<i64>：skip_reason = NO_PROCESS_CHAIN 时为 null */
  process_chain_id: z.string().nullable(),
  /** Option<i64>：NO_PROCESS_CHAIN / NO_PROCESS_STEP 时为 null；
   *  NO_SHELF 时仍 Some（首道工序存在但未映射货架） */
  first_process_id: z.string().nullable(),
  first_process_code: z.string(),
  first_process_name: z.string(),
  /** Option<i64>：skip_reason 非 null 时通常为 null */
  first_shelf_id: z.string().nullable(),
  /** NOT_FOUND / NO_PROCESS_CHAIN / NO_PROCESS_STEP / NO_SHELF 之一；null = 可下发。
   *  中文文案映射见 `@/api/productionQueue::AUTO_DISPATCH_SKIP_REASON_LABELS`。 */
  skip_reason: z.string().nullable(),
});

export type AutoDispatchItemSchema = z.infer<typeof autoDispatchItemSchema>;

/** `POST /queue/auto-dispatch` 出参（rust AutoDispatchResult）。
 *  **只读预览**：不写库、不发 WS。`items` 按 `req.batch_ids` 入参顺序稳定排序。 */
export const autoDispatchResultSchema = z.object({
  items: z.array(autoDispatchItemSchema),
});

export type AutoDispatchResultSchema = z.infer<typeof autoDispatchResultSchema>;

/** `POST /queue/recall` 请求（rust RecallRequest）。
 *  ⚠️ `batch_id` 是 **body 字段**（不是路径参数）且必须是 **JSON 字符串** ——
 *  后端 `deserialize_i64` 只接受字符串，发数字返 40001。`version` 必填
 *  （无 `#[serde(default)]` ⇒ 缺省 40001）。 */
export const recallRequestSchema = z.object({
  batch_id: z.string(),
  version: z.number(),
  note: z.string().optional(),
});

export type RecallRequestSchema = z.infer<typeof recallRequestSchema>;

/** `POST /queue/recall` 出参（rust RecallOut）。3 字段。
 *  `version` 是召回后的新版本（`batch.version + 1`）。前端当前零消费，但保留声明：
 *  出参少一个字段不会让 parse 失败，可一旦后端开始消费它（例如前端要就地回显新
 *  version 而不再等下一次列表拉取），漏声明的代价是静默 undefined。 */
export const recallOutSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  version: z.number(),
});

export type RecallOutSchema = z.infer<typeof recallOutSchema>;
