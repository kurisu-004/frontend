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

import { z } from 'zod';

// ============================================================
// 送货单本体（列表行 / 详情头共用）
// ============================================================

/** `DeliveryNoteOut`：列表行与详情头共用的 13 个字段。 */
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

/** `DeliveryNoteLineItem`：26 字段。
 *  - `batch_no` / `batch_label` 后端可空（批次化改造前的历史行）⇒ `.nullable()`；
 *  - `assembly_quantity` / `shippable_sets` 后端带 `skip_serializing_if` ⇒ `.nullish()`
 *    （缺键 = 后端整字段没上线，与「值为 null」业务含义不同）。 */
export const deliveryNoteLineItemSchema = z.object({
  /** 批次 id（行身份；拆批后同 part 多行，靠它区分）。 */
  id: z.string(),
  part_id: z.string(),
  /** 批次乐观锁版本（= t_part_batch.version，**不是** part.version）。 */
  version: z.number(),
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
  /** L2 客户名。 */
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  customer_path: z.string().nullable(),
  // —— 装配件父行字段（仅子件行填；散件全 null）——
  assembly_id: z.string().nullable(),
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

/** `DeliveryNoteDetailOut`：本体 13 字段 + `line_items`。
 *
 *  ⚠️ 本体字段是**逐个重复声明**而不是 `deliveryNoteItemSchema.extend({...})`：
 *  后端 VO 是 `#[serde(flatten)]`（line_items 与本体字段同层），写成 extend 会在
 *  读代码时给出「本体是另一个可复用对象」的错误暗示 —— 两者是**同一次序列化**的
 *  结果，改本体字段时必须同步改这里。字段集合的一致性由
 *  `composables/__tests__/deliveryNoteSchema.spec.ts` 的形状断言守住。 */
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