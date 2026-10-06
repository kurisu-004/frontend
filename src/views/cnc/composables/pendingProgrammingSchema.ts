// src/views/cnc/composables/pendingProgrammingSchema.ts
//
// 2026-10-07 新增：「待编程一览」页主查询的 Zod 守门 schema，搬进域内与 query hook 同居。
// 数据源是 prod 域 `GET /api/v2/prod/programming/pending`，出参对齐后端
// `ProgrammingItemOut`（行）/ `ProgrammingListOut`（分页信封 `{ items, total, limit,
// offset }`）。
//
// 为什么住域内而不是全局 schema 文件：守门点在 queryFn
// （usePendingProgrammingQuery），schema 跟 query hook 同居域内，守卫关系就近可读。
//
// ProgrammingItem 15 字段全声明（Zod 默认 strip 模式会让缺字段静默丢弃，
// 必填字段漏声明 = 整份校验形同虚设）：
//   id (雪花 ID string) / version (part 级乐观锁 i32) / serial_no (nullable) /
//   name / drawing_no / quantity (i32) / status (String，语义同 OrderStatus 但
//   不锁字面量，与 partBatchSchema.status 同约定) / is_urgent /
//   planned_delivery_date (string) / system_delivery_date (nullable) /
//   customer_name (nullable，L2) / parent_customer_name (nullable，L1) /
//   has_cnc_program (bool 必填 —— 本页 Tab 化的唯一依据) /
//   batch_id (nullable) / batch_version (nullable) —— 批次锚点，后端补齐的那两列。
//
// ⚠️ 客户字段名与 part 域**不同名**：本 schema 是 parent_customer_name(L1) /
// customer_name(L2)，而 PartListItem 是 l1_customer_name / customer_name。
// 两个端点的 rows 不能互相 cast（列渲染读的是 parent_customer_name，cast 过来
// 命不中 ⇒ 渲染出「—」）。
//
// ⚠️ 本 schema 是 strip 模式的 `z.object`（非 `.strict()`），所以**后端改字段名
// 不会被 Zod 报错**、只会被静默丢弃。批次锚点两个字段的改名义务双向登记在
// `src/views/cnc/pendingProgrammingColumnDefs.ts` 的 RELEASE_* 常量注释上，
// 后端换名时两处必须同批改。

import { z } from 'zod';

export const pendingProgrammingItemSchema = z.object({
  id: z.string(),
  version: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  quantity: z.number(),
  status: z.string(),
  is_urgent: z.boolean(),
  planned_delivery_date: z.string(),
  system_delivery_date: z.string().nullable(),
  /** L2 客户名（可空） */
  customer_name: z.string().nullable(),
  /** L1 客户名（可空） */
  parent_customer_name: z.string().nullable(),
  /** 是否已上传 G_CODE（后端 t_part_file EXISTS 派生）—— 必填 boolean，守门到位 */
  has_cnc_program: z.boolean(),
  /** 批次 id（雪花 ID 字符串，nullable）。取该 part 的 `status='PROGRAMMING' AND
   *  deleted_at IS NULL` 批次中 `id` 最大者（后端 `ProgrammingItemOut::batch_id`），
   *  无 PROGRAMMING 批次时为 null ⇒ 该行不可下发。只认 PROGRAMMING 是因为本行唯一
   *  写出口 release-from-programming 硬要求源状态是 PROGRAMMING，给别的状态等于给
   *  前端一个必然 20103 的锚点。
   *  ⚠️ 改名义务：本字段与下面 batch_version 一起被
   *  `src/views/cnc/pendingProgrammingColumnDefs.ts` 双向登记（strip 模式下后端换名
   *  只会静默丢字段、不会报错，换名时那侧的用户可见文案会同时失真）。
   *  ⚠️ 声明成**必填 + 可空**（不是 `.optional()`）：后端 `ProgrammingItemOut`
   *  的两字段都无 `skip_serializing_if`（`batch_id` 走 `serialize_i64_opt`、
   *  `batch_version` 只有 `#[serde(default)]`，后者只影响反序列化）⇒ 两 key 恒返。
   *  写成 `.optional()` 会让「后端哪天删掉这两个键」**静默通过**（Zod 不报错）⇒
   *  全表按钮恒 disabled，正是本字段要守门的症状。 */
  batch_id: z.string().nullable(),
  /** 批次乐观锁版本号（`t_part_batch.version`，nullable）。与 batch_id 同批下发、
   *  **同生共死**（batch_id 为 null 时后端也必为 null），作 release-from-programming
   *  的 OCC 版本回传 —— 后端 `PlaceOnShelfRequest.version` 是**必填** i32（无
   *  `#[serde(default)]`，缺字段 422），拿 part 级 version 顶替会打成版本冲突。
   *  同 batch_id：必填理由与改名义务同批。 */
  batch_version: z.number().nullable(),
});

export type PendingProgrammingItemData = z.infer<typeof pendingProgrammingItemSchema>;

/** 待编程列表分页结果（结构对齐后端 ProgrammingListOut：items / total / limit /
 *  offset 四字段，后端用 JSON **number** 返回计数）。 */
export const pendingProgrammingListResultSchema = z.object({
  items: z.array(pendingProgrammingItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type PendingProgrammingListResultData = z.infer<typeof pendingProgrammingListResultSchema>;
