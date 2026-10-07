// src/views/com/delivery/composables/deliveryScanTreeSchema.ts
//
// 2026-10-08 新增：扫码三层树（`GET /com/delivery/note/scan/{serial_no}`）的 Zod 守门 schema。
// 与消费它的 api 函数（`src/api/com/deliveryNote.ts::getDeliveryScanTree`）同居一域：
// **扫码取树走 useMutation（用户触发的单次拉取），没有 queryFn 承载 ⇒ 守门 parse
// 留在 api 层**，照 `src/api/inspection.ts` 扫码树的先例（CLAUDE.md「Zod schema-first」
// 的运行时边口径）。
//
// ⚠️ 所有字段显式声明；雪花 id 一律 `z.string()`（文件头口径同 deliveryNoteSchema）。
// 字段名 / 可空性与后端 `modules/com/delivery_note/vo/scan_tree.rs` 逐字对齐 ——
// 「多声明一个后端不发 / 不为空的字段」= 扫码弹窗当场 parse 抛（同 B1 那类故障）；
// 反向的「后端恒发 null 却声明成必填」同样当场抛，两条都有可执行断言守着，见
// `__tests__/deliveryNoteSchema.spec.ts` 的 `BACKEND_VO_SCAN_*` 与
// `BACKEND_VO_NULLABLE_FIELDS` 清单。
//
// 2026-10-08 修正：`ScanPartOut::serial_no` 曾声明成 `z.string()`（必填），而后端是
// `Option<String>` —— 「手工子件 / 终态工单没有序列号」是**常态**而非边缘情况：
// migration `007_serial_release` 把终态（COMPLETED / CANCELLED）行的 `serial_no`
// 主动置 NULL 且已对存量跑过，`repo/scan_tree.rs::list_parts_by_assembly` 也特意按
// `serial_no ASC NULLS LAST, id ASC` 排序（注释原文：「让没序列号的手工子件排在
// 末尾」）⇒ 扫码一棵无序列号子件的装配件，整棵树的 parse 当场抛，弹窗打不开。

import { z } from 'zod';

/** 已存在的 DRAFT 摘要（`draft: null` = 该 L1 下还没有草稿，本端点纯读不建单）。 */
export const deliveryScanDraftSchema = z.object({
  note_id: z.string(),
  note_no: z.string(),
  /** 乐观锁 version：`POST /scan` 的 `note_version` 锚。 */
  version: z.number(),
  status: z.string(),
});

export type DeliveryScanDraftData = z.infer<typeof deliveryScanDraftSchema>;

/** 每套用量（装配件「每套需 F1001-01 3 件」 tooltip 的数据源）。 */
export const deliveryScanPerSetPartSchema = z.object({
  part_id: z.string(),
  /** 整数除法向零截断。 */
  per_set_quantity: z.number(),
});

export type DeliveryScanPerSetPartData = z.infer<typeof deliveryScanPerSetPartSchema>;

/** 装配件节点（12 字段，无批次层）。 */
export const deliveryScanAssemblySchema = z.object({
  id: z.string(),
  /** `t_assembly.serial_no` 可空：migration 007 同样把终态装配件的序列号置 NULL。 */
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  status: z.string(),
  /** 装配件送套数（工单口径）。 */
  quantity: z.number(),
  is_urgent: z.boolean(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  /** 所属 L2 客户 id（入单闸门要用它核对单据 L1）。 */
  customer_id: z.string(),
  /** 本次可入单的最大套数（子件 READY_TO_SHIP 且未占用的批次按套折算）。 */
  entry_max_sets: z.number(),
  per_set_parts: z.array(deliveryScanPerSetPartSchema),
});

export type DeliveryScanAssemblyData = z.infer<typeof deliveryScanAssemblySchema>;

/** 批次节点（11 字段）。 */
export const deliveryScanBatchSchema = z.object({
  id: z.string(),
  /** 后端是**非 Option** 的 `i32`（键恒在、值不会是 null），这里 `.nullable()` 是
   *  有意识的超集：渲染侧 `#{{ row.batch_no }}` 一律走同一分支，给批次号留宽容侧。 */
  batch_no: z.number().nullable(),
  quantity: z.number(),
  status: z.string(),
  /** OCC 锚（仅展示；入单不传批次 version，分配在服务端事务内做）。 */
  version: z.number(),
  is_repairing: z.boolean(),
  location: z.string().nullable(),
  current_holder_display: z.string().nullable(),
  process_name: z.string().nullable(),
  is_scanned: z.boolean(),
  /** 非空 = 已被某张送货单占用（`dn.deleted_at IS NULL` 口径），该行不可入单。 */
  occupied_by_note_no: z.string().nullable(),
});

export type DeliveryScanBatchData = z.infer<typeof deliveryScanBatchSchema>;

/** 零件节点（13 字段）。独立件树里它是顶层，装配件树里它是子件。 */
export const deliveryScanPartSchema = z.object({
  id: z.string(),
  /** `Option<String>`：`t_part.serial_no` 可空且现网已有大量 NULL（见文件头口径）。 */
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  status: z.string(),
  quantity: z.number(),
  is_urgent: z.boolean(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  /** 仅展示（入单不传）。 */
  version: z.number(),
  customer_id: z.string(),
  /** 本次可入单的最大件数（Σ READY_TO_SHIP 且未占用的批次数量）。 */
  entry_max_quantity: z.number(),
  children: z.array(deliveryScanBatchSchema),
});

export type DeliveryScanPartData = z.infer<typeof deliveryScanPartSchema>;

/** 三层树响应（5 字段）。 */
export const deliveryScanTreeSchema = z.object({
  /** 'ASSEMBLY' | 'PART'。 */
  hit_kind: z.string(),
  /** trim 后的扫码串回显。 */
  scanned_serial_no: z.string(),
  draft: deliveryScanDraftSchema.nullable(),
  assembly: deliveryScanAssemblySchema.nullable(),
  /** 装配件树 = 全部子件；独立件树 = [该件]。 */
  children: z.array(deliveryScanPartSchema),
});

export type DeliveryScanTreeData = z.infer<typeof deliveryScanTreeSchema>;