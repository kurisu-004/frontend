// 2026-10-08 新建：外协看板（queue）域的 Zod schema，随视图目录走（照
// `views/production/queue/composables/productionQueueSchema.ts` 与 dashboard 域同款做法），
// 不再寄居全局 `composables/queries/schemas.ts`：
//   - 本域 schema 只被本域的 query hook / 视图消费，全局 schemas.ts 是「跨域共享基础
//     数据」的 schema 集；
//   - `company_options` 的公司下拉项 schema 除外 —— 它同时服务 `GET /outsource-sendable`
//     （全局 schemas.ts 里的共享基础数据层），故留在那里由本文件 import。
//
// 契约来源：后端 outsource 域「看板三件套」（`/outsource-queue/*`）。**已删除的字段不要
// 在这里声明**：新契约删掉的 `status_label` / `source_status` / `batch_quantity` /
// `customer_path` 曾在前端 schema 里存在，跟着一起删掉 —— 留着会让「后端已删」看起来像
// 「前端漏声明」，两边的漂移方向刚好相反，排查时要来回猜。
//
// 端点（baseURL `/api/v2`，前缀 `/outsource-queue/*`，**无 alias**）与本文件的覆盖：
//   GET  /outsource-queue/snapshot          → outsourceQueueSnapshotSchema
//                                                （+ 嵌套 outsourceQueueProcessSchema）
//   GET  /outsource-queue/processes/{id}    → outsourceQueueProcessDetailSchema
//                                                （+ 嵌套 outsourceQueueCompanySchema
//                                                  / outsourceQueueCandidateSchema
//                                                  / outsourceQueueHeldBatchSchema）
//   POST /outsource-queue/move              → outsourceMoveResultSchema（写端点出参；
//                                                入参形状见 api/outsource.contract.ts
//                                                的 OutsourceMoveRequestDto —— 请求体
//                                                不守门，它由三个包装函数的入参守卫
//                                                按方向组装）
//
// 三条序列化约定（与本域其它 schema 逐字一致）：
//   - 雪花 i64 **全字段 `z.string()`**：后端 `#[serde(serialize_with =
//     "serialize_i64")]`（JS Number 会丢精度）；不用 `z.coerce.string()` / `z.number()`
//     掩盖类型漂移。⚠️ 请求体里的雪花 ID 同样必须发字符串；
//   - Decimal 与 datetime **全字段 `z.string()`**（Decimal 保留精度，datetime 是 naive
//     字符串）；
//   - 计数与 version（`sendable_count` / `in_flight_count` / `sendable_total` /
//     `in_flight_total` / `held_count` / `version`）是**裸 i64 / i32** ⇒ `z.number()`，
//     方向与雪花 ID 相反。
//
// `receive_next_process_id` 的 `"0"` 兜底口径：**非 nullable** —— 后端投影层已把 NULL
// 吃成 0（`Option<i64> → i64` 走 `.unwrap_or(0)`）且序列化为字符串，即「无下一道工序」
// 在 JSON 上是 `"0"` 而不是 `null`（与 `prod::queue` 的 `current_process_step_id`
// 同口径）。写成 `z.string().nullable()` 会把合法响应当契约漂移整列炸掉。
//
// 可空字段一律 `.nullable()` 且**不给默认值**：后端显式返 null 与「字段缺失」是两种状态，
// 混起来会让下游的 `?? '—'` 把缺字段也渲染成「无值」而不是暴露漂移。
//
// 必填字段**逐个显式声明**（Zod strip 陷阱）：`z.object()` 默认 strip，漏声明的字段被
// 静默丢弃、parse 照过不误 —— 守门形同虚设。键集由
// `__tests__/outsourceQueueSchema.spec.ts` 的「parse 后键集 == fixture 键集」断言钉死。

import { z } from 'zod';
import { outsourceCompanyOptionSchema } from './outsourceListSchema';

/** 看板左列的一个候选批次卡片（后端 `OutsourceQueueCandidate`）—— 25 字段。
 *
 *  行粒度 = 「可发送候选批次 × 该外协工序」。发送侧需要的锚都在这里：
 *  `version`（OCC）、`send_mode`（APPROVAL / DIRECT）、`outsource_company_id` /
 *  `quote_id`（APPROVAL）、`company_options`（DIRECT 的公司下拉源）。
 *
 *  几处容易误判的字段：
 *  - `quantity` 是**可发送数量**（行 = 批次时恒等于批次量）；
 *  - `shelf_id` 是批次真实所在货架（发送时给「撤回 / 对账」用），`shelf_code` 是它的
 *    展示形态；`PENDING` 且未上架的批次没有 holder，两个字段都为 null；
 *  - `can_send` 是**后端派生**的可发送判据（APPROVAL，或 DIRECT 且 company_options
 *    非空），前端口径统一读它，不自己再算一遍；
 *  - `has_cnc_program` 与卡片 body 的「已编程」tag 同源。 */
export const outsourceQueueCandidateSchema = z.object({
  /** `t_part_batch.version`（批次级 OCC，发送时原样回传）。 */
  version: z.number(),
  /** `"APPROVAL"`（该外协工序 `requires_approval = true` 且已命中已批准报价）/
   *  `"DIRECT"`（`requires_approval = false`，免审批直发）。 */
  send_mode: z.enum(['APPROVAL', 'DIRECT']),
  part_id: z.string(),
  part_serial_no: z.string().nullable(),
  part_drawing_no: z.string().nullable(),
  part_name: z.string().nullable(),
  quantity: z.number(),
  batch_id: z.string(),
  batch_no: z.number(),
  planned_delivery_date: z.string().nullable(),
  is_urgent: z.boolean(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  shelf_code: z.string().nullable(),
  shelf_id: z.string().nullable(),
  /** APPROVAL 单值；DIRECT 为 null（用 company_options）。 */
  outsource_company_id: z.string().nullable(),
  outsource_company_name: z.string().nullable(),
  /** 发送端点的报价 id；APPROVAL 必传、DIRECT 为 null。 */
  quote_id: z.string().nullable(),
  /** DIRECT 时为该批次可用的全部公司；APPROVAL 时为空数组。 */
  company_options: z.array(outsourceCompanyOptionSchema),
  /** APPROVAL 为该报价的 Decimal 字符串；DIRECT 为 null。 */
  price: z.string().nullable(),
  has_cnc_program: z.boolean(),
  applicant_name: z.string().nullable(),
  note: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  /** 后端派生的可发送判据（APPROVAL 或 DIRECT 有 company_options）。 */
  can_send: z.boolean(),
});

export type OutsourceQueueCandidateData = z.infer<typeof outsourceQueueCandidateSchema>;

/** 看板右列（某公司在某工序在外协）的一个批次卡片（后端 `OutsourceQueueHeldBatch`）
 *  —— 22 字段。随 `outsourceQueueCompanySchema.held_batches` 内联下发。
 *
 *  `location` 锁成字面量：在途批次必然在外协公司手上（恒 `"OUTSOURCE_COMPANY"`）。
 *  值恒定就锁死，后端哪天改了值立刻炸而不是静默进 UI。
 *
 *  ⚠️ `sent_at` 与 `price` 都是 **nullable**：后端是 `Option` —— 正常流恒有值
 *  （`uq_t_outsource_shipment_open_batch` 保证一个批次最多一张开口 shipment，
 *  `send_to_outsource` 在同一事务里 INSERT），但驱动 SQL 按契约用 `LEFT JOIN`
 *  （防御历史脏数据 / 手工改库），后端刻意不用空串兜底：空串会被前端当成「0 元 /
 *  格式错误的数」渲染，比 `null` 难排查。声明成非 nullable 会在真实响应上抛错。 */
export const outsourceQueueHeldBatchSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
  /** **当前余量**（`t_part_batch.quantity`），不是 shipment.quantity ——
   *  「部分接收」输入框的 max 值取它。 */
  quantity: z.number(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  name: z.string(),
  /** DB NULL ⇒ JSON null（列表渲染 '—'）。 */
  system_delivery_date: z.string().nullable(),
  planned_delivery_date: z.string().nullable(),
  is_urgent: z.boolean(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  applicant_name: z.string().nullable(),
  location: z.literal('OUTSOURCE_COMPANY'),
  note: z.string().nullable(),
  /** `t_part_batch.version` —— 接收时的 OCC 锚。 */
  version: z.number(),
  /** `t_outsource_shipment.sent_at`（naive datetime 字符串 / null）。 */
  sent_at: z.string().nullable(),
  /** `t_outsource_shipment.unit_price` 的 Decimal 字符串 / null。 */
  price: z.string().nullable(),
  /** 接收后批次的下一道工序 id；无下一 step 时为字符串 `"0"`（见文件头口径）。 */
  receive_next_process_id: z.string(),
  receive_next_process_name: z.string().nullable(),
  /** true = 工序链已知且指针未漂移（接收可免填工序）；false = 必须手填工序 + 货架。 */
  chain_resolvable: z.boolean(),
  has_cnc_program: z.boolean(),
});

export type OutsourceQueueHeldBatchData = z.infer<typeof outsourceQueueHeldBatchSchema>;

/** 看板右列的一列（后端 `OutsourceQueueCompany`）—— 4 字段。
 *
 *  `held_batches` 内联在列上（而不是另开一个「公司 × 工序」端点）：右列的持有集合是
 *  这一列自己的数据，多开一个端点就要为每列发一次请求、把 N+1 引进看板。
 *  **无在途批次的公司也在列内**（`held_count = 0`、`held_batches` 为空数组）—— 前端要
 *  渲染空公司列当拖拽目标。 */
export const outsourceQueueCompanySchema = z.object({
  company_id: z.string(),
  name: z.string(),
  /** `held_batches.length`（后端算好，前端不二次求和）。 */
  held_count: z.number(),
  held_batches: z.array(outsourceQueueHeldBatchSchema),
});

export type OutsourceQueueCompanyData = z.infer<typeof outsourceQueueCompanySchema>;

/** `GET /outsource-queue/snapshot` 的 `processes[]` 元素（后端
 * `OutsourceQueueProcess`）—— 7 字段。看板 tab 标题徽标的唯一数据源。
 *
 *  `color` / `category` 内联在快照里（不必与工序列表 join 就能给工序卡上色、标
 * 自产 / 外协）。只含 `sendable_count + in_flight_count > 0` 的工序，按 `process_id`
 * 升序。 */
export const outsourceQueueProcessSchema = z.object({
  process_id: z.string(),
  process_code: z.string(),
  process_name: z.string(),
  /** `t_process.color`（9 字符 `#RRGGBBAA` 含 alpha），未设置时 null；前端直接喂 CSS
   * `border-left-color`，不做字符串加工。 */
  color: z.string().nullable(),
  category: z.enum(['INHOUSE', 'OUTSOURCE']),
  sendable_count: z.number(),
  in_flight_count: z.number(),
});

export type OutsourceQueueProcessData = z.infer<typeof outsourceQueueProcessSchema>;

/** `GET /outsource-queue/snapshot` 顶层（后端 `OutsourceQueueSnapshot`）—— 4 字段。
 *
 *  **无 `total`**：两个分项总数已给全（`sendable_total` + `in_flight_total`），
 *  后端不再算一个合计字段，前端也不要自己相加后再当契约用。 */
export const outsourceQueueSnapshotSchema = z.object({
  processes: z.array(outsourceQueueProcessSchema),
  sendable_total: z.number(),
  in_flight_total: z.number(),
  /** 服务端生成快照时刻（RFC3339 带 `+08:00`）。前端不做 `new Date()` 解析 ——
   *  避免浏览器时区与服务端不一致把「新鲜度」算错。 */
  ts: z.string(),
});

export type OutsourceQueueSnapshotData = z.infer<typeof outsourceQueueSnapshotSchema>;

/** `GET /outsource-queue/processes/{process_id}` 的 `process`（后端
 * `OutsourceQueueProcessMeta`）—— 4 字段：工序元数据独立成对象（不是顶层三个平铺
 *  字段），与 `prod::queue` 的单工序看板同款。 */
const outsourceQueueProcessMetaSchema = z.object({
  process_id: z.string(),
  process_code: z.string(),
  process_name: z.string(),
  /** 同 outsourceQueueProcessSchema.color：9 字符含 alpha，未设置时 null。 */
  color: z.string().nullable(),
});

/** `GET /outsource-queue/processes/{process_id}` 顶层（后端
 * `OutsourceQueueProcessDetail`）—— 5 字段，**无分页信封**（一个 tab 一次全量）。
 *
 *  `total` 是候选批次数（`items.length`，不分页）；右列的在途批次走
 *  `companies[].held_batches`，不计入这个 total。 */
export const outsourceQueueProcessDetailSchema = z.object({
  process: outsourceQueueProcessMetaSchema,
  /** 该工序映射的**全部活跃外协公司**（含在途为 0 的空列）。 */
  companies: z.array(outsourceQueueCompanySchema),
  /** 左列：可发送候选批次。 */
  items: z.array(outsourceQueueCandidateSchema),
  total: z.number(),
  ts: z.string(),
});

export type OutsourceQueueProcessDetailData = z.infer<typeof outsourceQueueProcessDetailSchema>;

/** `POST /outsource-queue/move` 出参（后端 `OutsourceMoveResult`）—— 9 字段。
 *
 *  ⚠️ `shipment_id` / `new_process_id` 用 **`.nullish()`** 而非 `.nullable()`：后端两字段
 *  带 `#[serde(skip_serializing_if = "Option::is_none")]`，方向不满足时**整个键从 JSON
 *  消失**（不是 `null`）。写成 `.nullable()` 会在真实响应上抛错。
 *
 *  `from_kind` / `to_kind` 锁成三个 `t_part_batch.location` 枚举字面量；`new_location`
 *  则声明成 `z.string()` —— 它是 location 枚举的**完整值域**（比这三个移动 kind 宽，
 *  还含 PENDING / WORKER 等），收窄成同款联合会让后端返任何非移动态时整条 move 炸在
 *  守门上（而这恰恰是「移动前」合法存在的状态）。 */
export const outsourceMoveResultSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  /** 入参 `from.kind` 的字面回显。 */
  from_kind: z.enum(['PRODUCTION_SHELF', 'OUTSOURCE_COMPANY', 'INSPECTION_SHELF']),
  /** 入参 `to.kind` 的字面回显。 */
  to_kind: z.enum(['PRODUCTION_SHELF', 'OUTSOURCE_COMPANY', 'INSPECTION_SHELF']),
  /** 移动后 `batch.current_holder_id`（货架 id / 外协公司 id）。 */
  new_holder_id: z.string(),
  /** 移动后 `batch.location`（值域比上面两个 kind 宽，故不收窄）。 */
  new_location: z.string(),
  /** `batch.version + 1`。 */
  version: z.number(),
  /** 仅发送方向填；回收方向**整个键缺失**。 */
  shipment_id: z.string().nullish(),
  /** 回收生产时后端实际推进到的工序 id；发送 / 回收品检方向**整个键缺失**。 */
  new_process_id: z.string().nullish(),
});

export type OutsourceMoveResultData = z.infer<typeof outsourceMoveResultSchema>;
