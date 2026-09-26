// 2026-09-26 新增：基础数据查询返回值 Zod 校验。
//
// TanStack Query queryFn 在拿到响应后走 zod parse，验证后端返回结构
// 与前端契约一致；防止 backend-rust 字段漂移导致前端静默 fail。
//
// 设计：
//   - schemas 与 z.infer 派生的 TS 类型同文件内集中；
//   - 现有 TS 类型（@/api/customer Customer / @/types/process Process）保留不动，
//     schemas 独立存在；本文件内 z.infer 仅供 schemas 内部消费 + 备查。
//   - list 结果结构对齐 backend-rust ListOut：items / total / limit / offset。
//   - 链式顺序：trim 必须在 min 之前（项目 CLAUDE.md 2026-09-24 起 Zod 约定）。
//
// 校验级别：字段类型必填 + nullable 显式标注；不强制长度 / 范围（这些是表单层
// partEntrySchema 的职责，查询返回值的契约是「能解析就够了」）。

import { z } from 'zod';

/** 2026-09-26 新增：客户实体。字段对齐 @/api/customer Customer（雪花 id / name /
 *  parent_id / parent_name / serial_prefix）。serial_prefix 与 parent_name 一级客户
 *  必为 null，前端仅消费 nullable 不强制 None 语义。 */
export const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullable(),
  parent_name: z.string().nullable(),
  serial_prefix: z.string().nullable(),
});

export type CustomerSchema = z.infer<typeof customerSchema>;

/** 2026-09-26 新增：客户分页列表结果（结构对齐 backend-rust CustomerListOut）。 */
export const customerListResultSchema = z.object({
  items: z.array(customerSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type CustomerListResultSchema = z.infer<typeof customerListResultSchema>;

/** 2026-09-26 新增：工序实体。字段对齐 @/types/process Process（id / version / code /
 *  name / category / sort_order / description / requires_approval / color /
 *  created_at / updated_at）。category 用 z.enum 锁死 INHOUSE / OUTSOURCE；color 与
 *  description nullable；时间戳保持 string（与 API 字符串格式对齐）。 */
export const processSchema = z.object({
  id: z.string(),
  version: z.number(),
  code: z.string(),
  name: z.string(),
  category: z.enum(['INHOUSE', 'OUTSOURCE']),
  sort_order: z.number(),
  description: z.string().nullable(),
  requires_approval: z.boolean(),
  color: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProcessSchema = z.infer<typeof processSchema>;

/** 2026-09-26 新增：工序分页列表结果。 */
export const processListResultSchema = z.object({
  items: z.array(processSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type ProcessListResultSchema = z.infer<typeof processListResultSchema>;

// 2026-09-26 追加：part list schema（B 任务）。
//
// 字段对齐 @/types/parts PartListItem。注意点：
//   - status 是 OrderStatus 字面量联合，用 z.enum 锁死；
//   - row_type 可选 'PART' | 'ASSEMBLY'，老快照可能缺省（z.enum 须在 z.string 后链）；
//   - 后端 Rust 当前可能少返部分可选字段（如 batch_id / child_count / has_children），
//     schema 用 .optional() / .nullable() 全部容忍，避免 Zod parse 失败导致整表白屏。
//   - id 雪花 ID 字符串；version 是乐观锁 number。
//   - is_urgent / quantity / unit_price / total_price / sort 时出现 0 是合法值，
//     不能用 .min(0) / .nonnegative() 等严格限制（已是 number 即可）。
export const partSchema = z.object({
  id: z.string(),
  version: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  applicant_name: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.number(),
  total_price: z.number(),
  request_date: z.string(),
  planned_delivery_date: z.string(),
  is_urgent: z.boolean(),
  status: z.enum([
    'PENDING',
    'PROGRAMMING',
    'IN_PROCESS',
    'INSPECTION',
    'READY_TO_SHIP',
    'DELIVERED',
    'REPAIRING',
    'OUTSOURCE',
    'COMPLETED',
    'CANCELLED',
  ]),
  order_no: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  delivered_quantity: z.number().nullable().optional(),
  note: z.string().nullable(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  customer_path: z.string().nullable(),
  location: z.string().nullable(),
  holder_name: z.string().nullable().optional(),
  next_process_id: z.string().nullable(),
  next_process_name: z.string().nullable(),
  process_chain_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  batch_no: z.number().nullable().optional(),
  batch_quantity: z.number().nullable().optional(),
  row_type: z.enum(['PART', 'ASSEMBLY']).optional(),
  has_children: z.boolean().optional(),
  child_count: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
  matched_children: z.array(z.unknown()).nullable().optional(),
});

export type PartSchema = z.infer<typeof partSchema>;

/** 2026-09-26 追加：零件分页列表结果（结构对齐 backend-rust PartListOut + normalizeListResult）。 */
export const partListResultSchema = z.object({
  items: z.array(partSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type PartListResultSchema = z.infer<typeof partListResultSchema>;
