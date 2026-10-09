// src/views/statistics/composables/statisticsSchema.ts
//
// statistics 域三个只读端点的 Zod 守门 schema（2026-10-12 新建，与本目录的三个
// query hook 同居）。
//
// 与 query hook 同居本目录（CLAUDE.md「Zod schema-first」的「域 schema 与 query hook 同居」
// 条目）：`useStatisticsOverviewQuery` / `useStatisticsWorkersQuery` /
// `useStatisticsWorkerDetailQuery` 的 queryFn 直接
// `xxxSchema.parse(await fetchXxx())`。api 层（`src/api/statistics.ts`）只发请求 +
// 用本文件派生的 `*Data` 类型标注返回类型（`import type`，编译期擦除），**不 parse**
// —— parse 会返回深拷贝，多一层等于每屏数据被校验并克隆两遍。
//
// 为什么这组 schema 不在 `src/composables/queries/schemas.ts`：那是跨域共用的基础数据层
// schema（货架 / 客户 / 工序 / 工种 / 零件 …），statistics 域只服务生产统计页三个 tab。
//
// 三条 wire 序列化约定（写这组 schema 时最容易搞错，逐条对着后端 VO 看）：
//   1. **雪花 ID 一律 JSON string**（后端 `serialize_i64` / `serialize_i64_opt`）——
//      `worker_id` / `work_type_id` / `id` / `part_id` / `process_id` 全是 string。
//      声明成 `z.number()` 会在 19 位 ID 上丢精度。
//   2. **计数与工时一律 JSON number**（裸 `i64`，无 `serialize_with`）——
//      `pickup_count` / `participated_part_count` / `effective_minutes` /
//      `step_count` / `worked_process_count` / `worked_batch_count` 全是 number。
//      ⚠️ `effective_minutes` **不是** string：它不是雪花 ID，是分钟整数。
//   3. **Decimal 一律 JSON string**（`rust_decimal::Decimal` 的 serde-with-str）——
//      本域只有 `delivered_value` 一个。
//
// 必填字段**逐个显式声明**（CLAUDE.md「TanStack Query」的 Zod 守门条目）：Zod 默认
// `z.object()` 是 strip 模式，未声明的键被**静默丢弃且不报错** ⇒ 必填字段漏声明 =
// 「后端漏发」一路流到视图层而无人发现。本域的后端 VO 均**无** `skip_serializing_if`，
// 所以可空的键是「键恒在、值为 null」，声明成 `.nullable()` 而非 `.optional()`。

import { z } from 'zod';

// ============================================================
// 公共原子
// ============================================================

/** 日期 + 计数（`daily_created` / `daily_completed` / `daily_pickups` 共用）。
 *  后端 `overview::DayCount`：`date` 是 `NaiveDate` 原生序列化（'YYYY-MM-DD'）、
 *  `count` 是裸 i64。 */
const dayCountSchema = z.object({
  date: z.string(),
  count: z.number(),
});

/** 交期表现三分（后端 `overview::DeliveryPerformance`）：`on_time` / `orange` / `red`
 *  三者互斥，且 `on_time + orange + red === delivered_count`。 */
const deliveryPerformanceSchema = z.object({
  on_time: z.number(),
  orange: z.number(),
  red: z.number(),
});

/** 当前各状态零件数（后端 `overview::StatusCount`）。键名是 `status_value` 而不是
 *  `status`，与后端 VO 逐字对齐。`CANCELLED` 也含在内。 */
const statusCountSchema = z.object({
  status_value: z.string(),
  count: z.number(),
});

// ============================================================
// GET /api/v2/statistics/overview
// ============================================================

/** 车间生产总览（后端 `statistics::vo::overview::OverviewOut`，
 *  契约文档 `backend-rust/docs/api/statistics.md` §2）。
 *
 *  15 字段全部必填：2 个回显日期 + 9 个基础统计（其中 `delivered_value` 是 Decimal
 *  string）+ 4 个图表段。**跨域字段**：`status_distribution` 的行 VO 用的
 *  `status_value` 取自 `t_part.status`（part 域的 `PartStatus` 枚举字面量集合），
 *  `daily_created` / `daily_completed` 的计数也来自 part 域的 `t_part` /
 *  `t_part_event` —— 本 schema 不锁 `status_value` 的字面量集合，沿用
 *  `composables/queries/schemas.ts::partSchema` 同款取舍（后端扩展状态时不被
 *  本 schema 打死）。
 *
 *  生产消费方：`views/statistics/OverviewTab.vue`（经 `useStatisticsOverviewQuery`）。 */
export const overviewOutSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  created_count: z.number(),
  completed_count: z.number(),
  in_process_count: z.number(),
  delivered_count: z.number(),
  /** 期内总产值 sum(total_price)；Decimal → JSON string（与 `unit_price` /
   *  `total_price` 同形态，不强制 .regex）。 */
  delivered_value: z.string(),
  late_orange_count: z.number(),
  late_red_count: z.number(),
  overdue_undelivered_count: z.number(),
  repair_part_count: z.number(),
  daily_created: z.array(dayCountSchema),
  daily_completed: z.array(dayCountSchema),
  delivery_performance: deliveryPerformanceSchema,
  status_distribution: z.array(statusCountSchema),
});

export type OverviewOutData = z.infer<typeof overviewOutSchema>;

// ============================================================
// GET /api/v2/statistics/workers
// ============================================================

/** 单个工人的贡献度统计（后端 `statistics::vo::worker::WorkerStatsItem`，
 *  契约文档 `backend-rust/docs/api/statistics.md` §3.1）。
 *
 *  ⚠️ **行单位是「工人」不是事件**：一个工人一行（无论他做了多少事件），未软删工人
 *  **全部列出**，区间内无任何事件的工人下面三个新字段都是 0（零填充，不是缺行）。
 *
 *  **跨域字段**：`work_type_id` / `work_type_name` 来自 `t_work_type`（prod 域
 *  `WorkTypeOut`），`is_active` 来自 `t_worker`。
 *
 *  三个工时维度字段（`effective_minutes` / `worked_process_count` /
 *  `worked_batch_count`，后端 2026-10-12 加）**都是裸 i64 ⇒ JSON number**，不是 string：
 *   - `effective_minutes`：该工人期内**有效工时总额（分钟整数）**。口径 = 完成一道工序
 *     的次数 × 该工序在工单锚链上配的 `estimated_minutes` 求和；只认
 *     `RETURNED_TO_SHELF` / `SENT_TO_INSPECTION` 两种事件（「一进一出只认出」）。
 *     **链外工序计 0 分钟而不是丢弃该行**（事件没记工序 / 工单没配链 / 链内找不到
 *     该工序 step 三种情形都算），且数据覆盖受工序链配置率限制 —— 看到大面积 0 是
 *     口径的必然结果，不是回归；
 *   - `worked_process_count`：`COUNT(DISTINCT e.process_id)`，天然忽略
 *     `process_id IS NULL` 的行（与上一条的「计 0」是两件事）；
 *   - `worked_batch_count`：`COUNT(DISTINCT e.batch_id)`，同样忽略 NULL。
 *
 *  生产消费方：`views/statistics/WorkerStatsTab.vue` 的工人表 与
 *  `WorkerDetailTab.vue` 的工人下拉（均经 `useStatisticsWorkersQuery`）。 */
export const workerStatsItemSchema = z.object({
  worker_id: z.string(),
  worker_name: z.string(),
  badge_code: z.string(),
  /** `serialize_i64_opt` ⇒ JSON string | null；null = 未分配工种。 */
  work_type_id: z.string().nullable(),
  work_type_name: z.string().nullable(),
  is_active: z.boolean(),
  pickup_count: z.number(),
  pickup_quantity: z.number(),
  participated_part_count: z.number(),
  /** 贡献度百分比 0-100；无工种或 0 总量 → null。 */
  contribution_pct: z.number().nullable(),
  /** 有效工时（分钟整数），非 string。 */
  effective_minutes: z.number(),
  /** 期内完成过的不同工序数。 */
  worked_process_count: z.number(),
  /** 期内作业过的不同批次数。 */
  worked_batch_count: z.number(),
});

/** 工人贡献度列表信封（后端 `WorkerStatsListOut`）—— **只有 `items` 一个键，没有
 *  分页信封**（端点一次性返全部，前端自管筛选与分页）。 */
export const workerStatsListOutSchema = z.object({
  items: z.array(workerStatsItemSchema),
});

export type WorkerStatsListOutData = z.infer<typeof workerStatsListOutSchema>;

// ============================================================
// GET /api/v2/statistics/workers/{worker_id}
// ============================================================

/** 工人概览（后端 `WorkerBrief`）。⚠️ **不含 `work_type_id`** —— 详情页只展示名称，
 *  后端 VO 就没有这个键。 */
const workerBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  badge_code: z.string(),
  work_type_name: z.string().nullable(),
  is_active: z.boolean(),
});

/** 该工人参与过的工单（后端 `WorkerPartItem`），按 `last_pickup_at DESC`。
 *  **跨域字段**：整行来自 part 域（`part_id` / `serial_no` / `name` / `drawing_no` /
 *  `status` / `pickup_count` 全部是 `t_part` / `t_part_event` 的列）。
 *  ⚠️ `status` 用 `z.string()` 不锁字面量集合（沿仓内同款取舍）；
 *  ⚠️ `serial_no` 可空 = 流水号已被释放（如 COMPLETED / CANCELLED 回池）。 */
const workerPartItemSchema = z.object({
  part_id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  status: z.string(),
  pickup_count: z.number(),
  last_pickup_at: z.string(),
});

/** 一行 = 一道工序在该工人区间内的作业汇总（后端 `WorkerProcessBreakdown`，
 *  契约文档 `backend-rust/docs/api/statistics.md` §3.3）。
 *
 *  ⚠️ **两种不同的「无名」，schema 里如实分开声明，UI 占位文案不要混用**：
 *   - `process_id === null` = 「这条作业事件没记工序」。写侧只在 `prod::scan` 的 4 个
 *     构造点落 `process_id`，其余 `t_part_event` 构造点恒为 `NULL`，这类事件在按工序
 *     分组时汇成一个「无工序」组，**对工时总额的贡献恒为 0**；
 *   - `process_name === '(已删除)'` = 「记了工序 id，但工序行物理缺失（LEFT JOIN
 *     `t_process` 取不到名）」。这是后端给的**兜底字符串**，不是本 schema 造的值。
 *
 *  ⚠️ **服务端已排序**（`effective_minutes DESC, step_count DESC, process_id ASC`），
 *  前端不要再排一遍。 */
export const workerProcessBreakdownSchema = z.object({
  /** `serialize_i64_opt` ⇒ JSON string | null（雪花 ID 字符串化，null = 无工序）。 */
  process_id: z.string().nullable(),
  /** 工序显示名；取不到时后端已退化成 `'(已删除)'` 字符串（**不是 null**）。 */
  process_name: z.string(),
  /** 该工序在该区间内被「完成」的**次数**（`COUNT(*)`，不是 distinct）。 */
  step_count: z.number(),
  /** 该工序贡献的有效工时（分钟整数，非 string）。 */
  effective_minutes: z.number(),
});

/** 单工人详情（后端 `WorkerDetailOut`，契约文档 §3.2）。
 *
 *  ⚠️ `return_count` 的口径是 `RETURNED_TO_SHELF` 事件条数。**跨域字段**：
 *  `daily_pickups` / `parts` / `participated_part_count` 都来自 part 域的
 *  `t_part` / `t_part_event`；⚠️ `participated_part_count` **即便 part 已软删也计数**，
 *  与 `parts[]` 只列未软删件是两条不同口径。
 *
 *  `effective_minutes` 等于下方 `process_breakdown[]` 各行 `effective_minutes` 之和
 *  （同源 SQL、同一组事件）。
 *
 *  生产消费方：`views/statistics/WorkerDetailTab.vue`（经
 *  `useStatisticsWorkerDetailQuery`）。 */
export const workerDetailOutSchema = z.object({
  worker: workerBriefSchema,
  pickup_count: z.number(),
  pickup_quantity: z.number(),
  participated_part_count: z.number(),
  return_count: z.number(),
  /** 每日领取次数（零填充到 [date_from, date_to]）。 */
  daily_pickups: z.array(dayCountSchema),
  parts: z.array(workerPartItemSchema),
  /** 有效工时总额（分钟整数，非 string）。 */
  effective_minutes: z.number(),
  /** 按工序拆分（服务端已排序，前端不要重排）。 */
  process_breakdown: z.array(workerProcessBreakdownSchema),
});

export type WorkerDetailOutData = z.infer<typeof workerDetailOutSchema>;
