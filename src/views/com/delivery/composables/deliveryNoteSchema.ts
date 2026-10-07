// src/views/com/delivery/composables/deliveryNoteSchema.ts
//
// 2026-10-08 新增：送货单域的 **Zod 守门 schema**（后端 VO 的前端镜像）。
// 与 query hook（useDeliveryNotesQuery / useDeliveryNoteDetailQuery / …）同居 composables/
// 目录 —— api 层只 `import type` 本文件派生的 `*Data` 类型标注返回值，运行时守门在
// queryFn 内做一次（parse 返回深拷贝，多一层等于每屏数据被校验并克隆两遍）。
//
// ⚠️ **所有字段都显式声明**（Zod 默认 strip 会静默丢掉没声明的键）。
//   - 雪花 id 一律 `z.string()`：后端 i64 序列化成 string，前端转 number 会丢精度；
//   - 计数 / version / quantity 是 **JSON integer**，`z.number()`；
//   - `status` 不锁字面量（与 `composables/queries/schemas.ts::partBatchSchema.status`
//     同约定：后端新增枚举时前端不炸，锁死反而是升级负担）；
//   - 可空字段一律 `.nullable()` 且**不给默认值**；后端带 `skip_serializing_if` 的
//     字段用 `.nullish()`（缺键与 null 是两种语义，不能合并）；
//   - 类型导出统一 `z.infer` + `*Data` 后缀（CLAUDE.md Zod schema-first）。
//
// ⚠️ **本文件的字段名 / 键存在性必须与后端 VO 逐字对齐**，而 Zod 守门是**运行时**闸门：
// 多声明一个后端从不发的必填字段，整个域的详情页 / 草稿看板会当场 parse 抛（页面空白）。
// ⇒ 「多声明」与「该 nullish 写成 nullable」的护栏见
// `__tests__/deliveryNoteSchema.spec.ts` 末尾的「后端 VO 字段名清单」段
// （`BACKEND_VO_LINE_ITEM` / `BACKEND_VO_SKIPPED_FIELDS`，锁的是后端 VO，不是另一个
// schema —— schema 对 schema 的比对结构上发现不了与后端的偏差）。

import { z } from 'zod';

// ============================================================
// 送货单本体（列表行 / 详情头共用）
// ============================================================

/** `DeliveryNoteOut` 的前端消费字段（后端 VO 另有 `created_at`，本仓零读，被 strip
 *  掉无害 —— 见 api/com/deliveryNote.ts 的字段级备注）。 */
export const deliveryNoteItemSchema = z.object({
  /** 雪花 id（string，见文件头）。 */
  id: z.string(),
  /** 乐观锁版本；所有写端点的 OCC 锚。 */
  version: z.number(),
  delivery_note_no: z.string(),
  /** 单据归属的 L1 客户 id（行项的 `customer_id` 是 L2 叶子，两者不同层）。 */
  customer_id: z.string(),
  customer_name: z.string().nullable(),
  /** L1 / L2 路径，与零件一览同格式。 */
  customer_path: z.string().nullable(),
  /** DRAFT / SUBMITTED / PICKED_UP / ARCHIVED（不锁字面量，见文件头）。 */
  status: z.string(),
  submitted_at: z.string().nullable(),
  picked_up_at: z.string().nullable(),
  /** 司机名；打印前的「是否已指定司机」判据（后端不再发 driver_worker_id）。 */
  driver_worker_name: z.string().nullable(),
  /** 行项条数（非件数）。 */
  part_count: z.number(),
  note: z.string().nullable(),
  /** YYYY-MM-DD；创建时默认当天，DRAFT / SUBMITTED 可改。 */
  delivery_date: z.string().nullable(),
});

/** `DeliveryNoteItem` 的派生类型。 */
export type DeliveryNoteItemData = z.infer<typeof deliveryNoteItemSchema>;

// ============================================================
// 送货单行项（详情页树形表格 + 打印行整形的唯一数据源）
// ============================================================

/** `DeliveryNoteLineItem`：行项投影（字段集合同 spec 的 `BACKEND_VO_LINE_ITEM` ——
 *  那张清单手抄自后端 VO，改动必须两边同改）。
 *
 *  键存在性三条口径（**逐字段核对后端 serde 属性**，写错就是运行时 parse 抛）：
 *  - `assembly_id` 后端是 `serialize_i64_opt` + `skip_serializing_if = "Option::is_none"`
 *    ⇒ 散件行（装配 `None`）**整个键消失** ⇒ 必须 `.nullish()`；
 *  - `assembly_quantity` / `shippable_sets` 后端是裸 `Option<i32>`，**没有** serde 属性
 *    ⇒ 恒序列化成 `null`，键不会消失。这里用 `.nullish()` 是**超集**（也接 undefined），
 *    行为不变，只是「键在不在都不炸」；⚠️ 旧注释说过它们带 `skip_serializing_if`，那是
 *    错的 —— 按后端 VO 的写法它们不带，别再照那条旧注释推断键存在性；
 *  - `batch_no` / `batch_label` 后端是非 Option（`i32` / `String`）⇒ 键恒在；
 *    `.nullable()` 是给「批次化改造前的历史行」留的宽容侧，不影响键存在性。
 *
 *  - `customer_id`：该行项所属的 **L2 叶子客户 id**（与 `t_customer.id` 对应，雪花 id ⇒
 *    JSON string）。2026-10-08 后端本轮给 `DeliveryNoteLineItem` 补该字段，供打印分组
 *    按 id 查表（客户**名**允许重名，按名分组会把两个收货单位并进同一张 sheet）。
 *    过渡期用 `.nullish()`：字段尚未上线的后端返回里没有它，此时打印分组退化为按
 *    `customer_name` 兜底（见 utils/deliveryNotePrintRows.ts::groupRefOf）。 */
export const deliveryNoteLineItemSchema = z.object({
  /** 批次 id（行身份；拆批后同 part 多行，靠它区分）。 */
  id: z.string(),
  part_id: z.string(),
  batch_no: z.number().nullable(),
  batch_label: z.string().nullable(),
  serial_no: z.string(),
  drawing_no: z.string(),
  name: z.string(),
  quantity: z.number(),
  status: z.string(),
  applicant_name: z.string().nullable(),
  request_date: z.string().nullable(),
  planned_delivery_date: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  order_no: z.string().nullable(),
  note: z.string().nullable(),
  /** L2 客户名（展示列）。**不是**分组键 —— 分组键是 `customer_id`，见文件内说明。 */
  customer_name: z.string().nullable(),
  /** L2 客户 id（分组键；过渡期可能缺失，见文件内说明）。 */
  customer_id: z.string().nullish(),
  parent_customer_name: z.string().nullable(),
  customer_path: z.string().nullable(),
  // —— 装配件父行字段（仅子件行填；散件行**整个键都可能被后端 skip**）——
  assembly_id: z.string().nullish(),
  assembly_serial_no: z.string().nullable(),
  assembly_drawing_no: z.string().nullable(),
  assembly_name: z.string().nullable(),
  assembly_order_no: z.string().nullable(),
  /** 装配件工单总套数（该装配体整单要做的套数，与本单无关）。 */
  assembly_quantity: z.number().nullish(),
  /** 该装配件在本单可出货的套数（note 级聚合值，组内各行同值）。 */
  shippable_sets: z.number().nullish(),
});

/** `DeliveryNoteLineItem` 的派生类型。 */
export type DeliveryNoteLineItemData = z.infer<typeof deliveryNoteLineItemSchema>;

// ============================================================
// 详情
// ============================================================

/** `DeliveryNoteDetailOut`：本体 = `DeliveryNoteOut` 的全部前端消费字段 + `line_items`
 *（后端 VO 里 `scanned_serials` 恒为空数组且前端零读，2026-10-08 后端已删）。
 *
 *  ⚠️ 本体字段是**逐个重复声明**而不是 `deliveryNoteItemSchema.extend({...})`：
 *  后端 VO 是 `#[serde(flatten)]`（line_items 与本体字段同层），写成 extend 会在
 *  读代码时给出「本体是另一个可复用对象」的错误暗示 —— 两者是**同一次序列化**的
 *  结果，改本体字段时必须同步改这里。字段集合的一致性由
 *  `composables/__tests__/deliveryNoteSchema.spec.ts` 的两条断言守住：① 本体 key 集合
 *  === `deliveryNoteItemSchema` 的 key 集合；② 两者的必填字段都 ∈ 后端 VO 清单。 */
export const deliveryNoteDetailSchema = z.object({
  id: z.string(),
  version: z.number(),
  delivery_note_no: z.string(),
  customer_id: z.string(),
  customer_name: z.string().nullable(),
  customer_path: z.string().nullable(),
  status: z.string(),
  submitted_at: z.string().nullable(),
  picked_up_at: z.string().nullable(),
  driver_worker_name: z.string().nullable(),
  part_count: z.number(),
  note: z.string().nullable(),
  delivery_date: z.string().nullable(),
  line_items: z.array(deliveryNoteLineItemSchema),
});

/** `DeliveryNoteDetail` 的派生类型。 */
export type DeliveryNoteDetailData = z.infer<typeof deliveryNoteDetailSchema>;

// ============================================================
// 列表 / 批量详情 信封
// ============================================================

/** `DeliveryNoteListOut`：`items` / `total` / `limit` / `offset` 四字段全 JSON number。 */
export const deliveryNoteListResultSchema = z.object({
  items: z.array(deliveryNoteItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type DeliveryNoteListResultData = z.infer<typeof deliveryNoteListResultSchema>;

/** `GET /batch-detail?ids=` 响应载体 `{ items: DeliveryNoteDetail[] }`。
 *  items 按入参 ids 顺序装配，缺失 id 静默跳过；入参限制 1..=200 项。 */
export const deliveryNoteBatchDetailResultSchema = z.object({
  items: z.array(deliveryNoteDetailSchema),
});

export type DeliveryNoteBatchDetailResultData = z.infer<
  typeof deliveryNoteBatchDetailResultSchema
>;

// ============================================================
// 写端点的请求体
// ============================================================

/** 只带 version 的请求体（recall / submit / soft-delete / pickup 共用）。 */
export const deliveryNoteVersionPayloadSchema = z.object({
  version: z.number(),
});

export type DeliveryNoteVersionPayload = z.infer<typeof deliveryNoteVersionPayloadSchema>;

/** 部分更新：`delivery_date` / `note` 都是「不传 = 不改」，故用 `.nullish()` 之外的可选语义。 */
export const deliveryNoteUpdatePayloadSchema = z.object({
  version: z.number(),
  delivery_date: z.string().nullish(),
  note: z.string().nullish(),
});

export type DeliveryNoteUpdatePayload = z.infer<typeof deliveryNoteUpdatePayloadSchema>;

/** 移除批次（`POST /{id}/remove-batches`，由旧 `remove-parts` 改名）。 */
export const deliveryNoteRemoveBatchesPayloadSchema = z.object({
  batch_ids: z.array(z.string()),
  version: z.number(),
});

export type DeliveryNoteRemoveBatchesPayload = z.infer<
  typeof deliveryNoteRemoveBatchesPayloadSchema
>;

/** 指定司机（`POST /{id}/driver`）：version 是 OCC 锚，driver 是雪花 id 字符串。 */
export const deliveryNoteDriverRequestSchema = z.object({
  version: z.number(),
  driver_worker_id: z.string(),
});

export type DeliveryNoteDriverRequest = z.infer<typeof deliveryNoteDriverRequestSchema>;

// ============================================================
// 入单请求体（`POST /com/delivery/note/scan`）
// ============================================================

/** 单条入单条目：PART 传 `quantity`（件数），ASSEMBLY 传 `sets`（套数）。
 *  客户端**不传批次 version** —— 分配在服务端事务内完成，读到的就是最新。 */
export const deliveryScanEntrySchema = z.object({
  node_kind: z.enum(['ASSEMBLY', 'PART']),
  node_id: z.string(),
  sets: z.number().int().nullish(),
  quantity: z.number().int().nullish(),
});

export type DeliveryScanEntry = z.infer<typeof deliveryScanEntrySchema>;

/** `POST /scan` 请求体。`note_version` 在命中既有 DRAFT 时必填（OCC 锚）。 */
export const deliveryScanEntryRequestSchema = z.object({
  serial_no: z.string(),
  note_version: z.number().int().nullish(),
  entries: z.array(deliveryScanEntrySchema),
});

export type DeliveryScanEntryRequest = z.infer<typeof deliveryScanEntryRequestSchema>;

// ============================================================
// 司机候选
// ============================================================

/** `DeliveryDriverOption`：`GET /com/delivery/drivers` 的行。 */
export const deliveryDriverSchema = z.object({
  id: z.string(),
  name: z.string(),
  badge_code: z.string(),
});

export type DeliveryDriverData = z.infer<typeof deliveryDriverSchema>;

export const deliveryDriverListResultSchema = z.object({
  items: z.array(deliveryDriverSchema),
});

export type DeliveryDriverListResultData = z.infer<typeof deliveryDriverListResultSchema>;