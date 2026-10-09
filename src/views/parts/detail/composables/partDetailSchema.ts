// src/views/parts/detail/composables/partDetailSchema.ts
//
// 2026-10-10 新增：零件详情页的 Zod 守门 schema，与该页的取数 composable 同居。
// 守三个后端出参：
//   1. `GET /api/v2/parts/{part_id}`          → `PartDetailOut`（25 列 TPart flatten + 3 注入字段）
//   2. `GET /api/v2/parts/{part_id}/events`   → `Vec<PartEventOut>`（**裸数组**，无分页信封）
//   3. `GET /api/v2/prod/process-chains/{id}` → `ProcessChainOut`（header + steps[]）
//
// 字段集一律以 backend-rust 的 VO 为准（`src/modules/part/vo/part.rs`、
// `src/modules/prod/process_chain/vo/process_chain.rs`），不是以「前端以前声明了什么」
// 为准 —— 前端那份 `PartItem` 曾经是三个不同后端 VO 的联合类型，声明了十几个后端
// 一个都不返的字段（customer_path / current_holder_display / location / batch_no …），
// 消费侧据此渲染出的界面恒为空或恒为兜底文案。这类「字段是假的」只能靠
// 「以 VO 为准的 schema」当场炸出来，靠人工读类型看不出来。
//
// 守门点：2026-10-10 详情页取数迁 TanStack Query，本文件的前两个 schema 分别接在
// `usePartDetailQuery.ts` / `usePartEventsQuery.ts` 的 **queryFn** 上（api 层仍只发
// 请求 + `import type` 标注返回类型，不 parse —— CLAUDE.md「守门点随分层搬家」）。
// 第三个（工序链）目前由 `useProcessChain.ts` 直接调 api，尚无 queryFn 承载。

import { z } from 'zod';
import { ORDER_STATUSES } from '@/types/parts';

// ============================================================
// 1. 零件详情（`GET /api/v2/parts/{part_id}` 的 `PartDetailOut`，28 字段）。
//
// VO 形态是 `#[serde(flatten)] part: TPart` + 3 个注入字段：
//   - TPart 25 列（id / serial_no / name / drawing_no / applicant_name / quantity /
//     request_date / planned_delivery_date / customer_id / assembly_id / status /
//     is_urgent / next_process_id / order_no / system_delivery_date / note /
//     unit_price / total_price / version / created_at / created_by / updated_at /
//     updated_by / deleted_at / process_chain_id）；
//   - service 注入 customer_name / l1_customer_name（客户两级名）与 current_batch_id
//     （当前 INSPECTION 批次 id，null = 不在品检中）。
//
// key 集合**恰为 28 个**且用 `.strict()`：多一个键即抛 `unrecognized_keys`。这条守卫的
// 价值在于「后端加字段 / 前端字段名写错」当场炸，而不是 Zod strip 把多出来的键静默
// 丢掉、页面照常渲染、只是某一列永远是空的。
//
// 契约要点：
//   - 雪花 ID（id / customer_id / assembly_id / next_process_id / current_batch_id /
//     process_chain_id / created_by / updated_by）走 `serialize_i64(_opt)` ⇒ JSON
//     **string**，声明 `z.string()`，禁 `z.number()` 与 `Number()`（19 位 ID 在
//     JS Number 下丢精度）。
//   - `unit_price` / `total_price` 是 `rust_decimal::Decimal` +
//     `serde-with-str` ⇒ JSON **string**。声明 `z.string()`；前端表单侧也一直按
//     string 提交（见 `PartCreatePayload.unit_price`），两边方向一致。
//   - `deleted_at` 在本端点恒 null（SQL WHERE 已过滤软删行），但键恒在
//     （后端无 `skip_serializing_if`），故声明成必填可空而不是 `.optional()`。
//   - `request_date` / `planned_delivery_date` / `system_delivery_date` 是
//     `NaiveDate` ⇒ JSON `YYYY-MM-DD` 字符串；前两个 DB NOT NULL、第三个可空。
//   - `version` 是 **part 级 `t_part.version`**（OCC 锚，`updatePart` / `softDeletePart`
//     的必填入参取自它），**不是**批次版本。批次 OCC 只认 `t_part_batch.version`。
// ============================================================

export const partDetailSchema = z
  .object({
    id: z.string(),
    serial_no: z.string().nullable(),
    name: z.string(),
    drawing_no: z.string(),
    applicant_name: z.string(),
    quantity: z.number(),
    request_date: z.string(),
    planned_delivery_date: z.string(),
    customer_id: z.string(),
    assembly_id: z.string().nullable(),
    /** 工单 10 态枚举。用 `z.enum(ORDER_STATUSES)` 守门（而非 `z.string()`）：10 个
     *  字面量的单一来源是 `types/parts::ORDER_STATUSES`，`ORDER_STATUS_LABEL` /
     *  `ORDER_STATUS_TAG_TYPE` 都由它派生 —— 写 `z.string()` 的话，视图层 `statusLabel()`
     *  就得为了接住未知值而处处断言，dashboard 域的 status VO 也是走 enum 的。 */
    status: z.enum(ORDER_STATUSES),
    is_urgent: z.boolean(),
    next_process_id: z.string().nullable(),
    order_no: z.string().nullable(),
    system_delivery_date: z.string().nullable(),
    note: z.string().nullable(),
    /** 单价，`Decimal` + `serde-with-str` ⇒ JSON **string**。 */
    unit_price: z.string(),
    /** 总价，同上。注意后端**不**按 quantity × unit_price 重算，改数量/单价时
     *  得由前端算好一并提交（见 `PartUpdatePayload` 的注释）。 */
    total_price: z.string(),
    /** part 级 OCC 锚（`t_part.version`）。 */
    version: z.number(),
    created_at: z.string(),
    created_by: z.string().nullable(),
    updated_at: z.string(),
    updated_by: z.string().nullable(),
    /** 本端点恒 null（SQL 已过滤软删行），键恒在。 */
    deleted_at: z.string().nullable(),
    /** 工艺链 id（`t_part.process_chain_id`，逻辑 FK → `t_part_process_chain.id`）；
     *  null = 该工单未制定工序链。 */
    process_chain_id: z.string().nullable(),
    /** 二级（直接）客户名，service 注入。 */
    customer_name: z.string().nullable(),
    /** 一级客户名，service 注入；客户自身就是 L1 时与 `customer_name` 相等。
     *  ⚠️ 前端详情卡的「客户」行读的是本字段（`PartInfoCard`），**不是**
     *  `customer_path` —— 后端从来没返过 `customer_path`。 */
    l1_customer_name: z.string().nullable(),
    /** 当前 INSPECTION 批次 id；null = 不在品检中。 */
    current_batch_id: z.string().nullable(),
  })
  .strict();

export type PartDetailData = z.infer<typeof partDetailSchema>;

// ============================================================
// 2. 零件事件历史（`GET /api/v2/parts/{part_id}/events` 的 `PartEventOut`，11 + 4 字段）。
//
// 端点**无分页、无 limit**，出参是**裸数组**（不是 `{items,total}` 信封），
// api 层 `listPartEvents` 的返回类型就是 `PartEvent[]`。
//
// `PartEventOut` 的 11 个核心字段（后端 master 与 `feat/part-detail-contract` 分支
// 共有）由 `.nullable()` 守门；下面四个字段由后端**随零件详情重构一并加入**
// （2026-10-10）：`batch_no` 是**工单内批次序号**（i32 ⇒ 裸 JSON **number**，不是雪花
// ID 字符串，也不是字符串），另三个是人名字符串、可空。
//
// ⚠️ **这四个键声明成 `.nullish()` 而不是 `.nullable()`**：它们只存在于后端分支
// （commit `feat(part): events 出参补 batch_no / worker_name / operator_name 四字段`，
// **未进 master**）的 `PartEventOut` 上。若声明成必填，后端未先行上线时
// `GET /parts/{id}/events` **100% 失败**（ZodError，不是 4xx）⇒ 历史卡整块空白 +
// 每次进页/回页一条 `ElMessage.error`，而详情 query 正常（其余卡不受影响，排障时
// 容易误查权限 / 网络）。`.nullish()` 让两仓能各自独立上线与回滚：键缺失时
// `PartHistoryCard` 的三处 `v-if` 恒假，那三段展示**静默不渲染**，这正是缺键时的
// 正确降级。代价是这四个展示性字段失去「后端漏发就炸」的守门能力 —— 可接受。
//
// ⚠️ 部署顺序（与 CLAUDE.md「货架自动选择」一节同款警示）：本 schema **不挑版本**，
// 两个版本都能解析；但要拿到批次标签 / 工人名 / 操作者三段展示，**后端必须先上**。
//
// 与前端旧 `PartEvent` 接口的差异（那份是按「t_part_event 表有这些列」臆想的，
// 后端 VO 一个都没返）：删掉 `part_id` / `worker_id`。`part_id` 由 URL 路径参数
// 承担（同一响应里的事件同属一个 part），`worker_id` 后端 VO 不投影。
// ============================================================

export const partEventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  /** 事件归属批次；null = 工单级事件（如 CREATED）。 */
  batch_id: z.string().nullable(),
  /** 工单内批次序号（i32 ⇒ JSON number），null = 工单级事件。
   *  ⚠️ `.nullish()`：键只存在于后端 `feat/part-detail-contract` 分支，未进 master，
   *  声明必填会让「后端未先上」时整条 events 响应 parse 失败（见本节文件级警示）。 */
  batch_no: z.number().nullish(),
  /** 本次事件涉及的数量。 */
  quantity: z.number().nullable(),
  drawing_code: z.string().nullable(),
  badge_code: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  /** 工人姓名（扫码类事件）。⚠️ `.nullish()`，理由同 `batch_no`。 */
  worker_name: z.string().nullish(),
  /** 操作者姓名（display_name），事件卡默认用它展示。⚠️ `.nullish()`，理由同 `batch_no`。 */
  operator_name: z.string().nullish(),
  /** 操作者登录名，仅在 `operator_name` 为空时作 fallback。⚠️ `.nullish()`，理由同 `batch_no`。 */
  operator_username: z.string().nullish(),
});

export type PartEventData = z.infer<typeof partEventSchema>;

/** 2026-10-10 新增：事件列表的**裸数组**守门（端点无分页、无 limit/offset ⇒ 出参是
 *  数组本身，不是 `{items,total}` 信封）。组合放在 schema 文件里而不是 query hook 里：
 *  「这份响应是什么形状」是契约问题，与谁发请求无关；query hook 只负责把结果交给它。 */
export const partEventListSchema = z.array(partEventSchema);

export type PartEventListData = z.infer<typeof partEventListSchema>;

// ============================================================
// 3. 工序链（`GET /api/v2/prod/process-chains/{chain_id}` 的 `ProcessChainOut`）。
//
// 由 `part.process_chain_id` 指过来，**一个 part 至多一条链**（后端
// `uq_t_part_process_chain` 保证 1:1）。无链 / 链已软删时后端返 404 +
// 20701 BIZ_PROCESS_CHAIN_NOT_FOUND，消费侧（`useProcessChain`）按「空链」兜底，
// 不弹错误提示 —— 这条行为不变。
//
// steps 由后端按 `sort_order ASC, id ASC` 排好，前端不二次排序。
//
// ⚠️ **step 的 `note` 是 `skip_serializing_if = "Option::is_none"`**：为空时键
// 直接不出现在 JSON 里，而不是出现成 `null`。所以本字段必须 `.nullish()`
// （string | null | undefined），声明成 `.nullable()` 会在「工单链里有一步没写备注」
// 时整条响应 parse 失败。链级 `note` 没有 skip_serializing_if，是恒在的 `.nullable()`。
//
// 本 schema 不接 `.strict()`：这条链的字段集不在本次重构的重点守卫范围内，
// 多余键（后端将来加派生列）不应让零件详情页直接白屏。
// ============================================================

export const processChainStepSchema = z.object({
  id: z.string(),
  /** 0-based 顺序。 */
  sort_order: z.number(),
  /** FK → `t_process.id`（雪花 ID 字符串）。 */
  process_id: z.string(),
  estimated_minutes: z.number(),
  /** 单步备注；后端 None 时**键不存在**（skip_serializing_if），故 nullish。 */
  note: z.string().nullish(),
  version: z.number(),
});

export type ProcessChainStepData = z.infer<typeof processChainStepSchema>;

export const processChainSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 链级备注；空串在 upsert 语义下表示「显式清空」，故恒在、可空。 */
  note: z.string().nullable(),
  /** 乐观锁；upsert 整组替换 +1。 */
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  steps: z.array(processChainStepSchema),
});

export type ProcessChainData = z.infer<typeof processChainSchema>;
