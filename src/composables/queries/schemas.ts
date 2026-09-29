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

/** 2026-09-26 新增：客户实体。字段对齐 backend-rust `CustomerOut`
 * （`backend-rust/docs/api/customers.md:142-153`，8 字段）：雪花 id / name /
 * parent_id / parent_name / serial_prefix / version / created_at / updated_at。
 * serial_prefix 与 parent_name 一级客户必为 null，前端仅消费 nullable 不强制 None
 * 语义。version 是乐观锁 i32（每次写操作 +1）；created_at / updated_at 是
 * Asia/Shanghai naive datetime，前端按 string 处理（与项目 Zod 约定一致）。
 *
 * 2026-09-26（M-1 修复）：首轮漏列 version / created_at / updated_at 三字段。
 * zod 默认 `.object()` strip 模式会静默丢弃未声明字段，运行时不会报错，导致
 * Zod 校验守门失效。补齐与后端契约对齐。 */
export const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullable(),
  parent_name: z.string().nullable(),
  serial_prefix: z.string().nullable(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
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

/** 2026-09-26 新增：工序实体。字段对齐 backend-rust `ProcessOut`
 * （`backend-rust/docs/api/production/processes.md:159-173`，11 字段）：id /
 * code / name / category / sort_order / description / requires_approval / color /
 * version / created_at / updated_at。category 用 z.enum 锁死 INHOUSE / OUTSOURCE；
 * color 与 description nullable；时间戳保持 string（与 API 字符串格式对齐）。
 *
 * 2026-09-26（M-1 审计）：与 Process.ts 业务类型 + backend-rust ProcessOut 三方
 * 一致（id / version / code / name / category / sort_order / description /
 * requires_approval / color / created_at / updated_at 共 11 字段），无需补字段。 */
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
//   - is_urgent / quantity 出现 0 是合法值；unit_price / total_price 是 string
//     （rust_decimal::Decimal + serde-with-str 序列化），允许 '0' / '0.00' /
//     '100.50' 等任意金额字符串形态，不强制 .regex。
//
// 2026-09-27 前后端字段对齐：
//   - parent_customer_name rename → l1_customer_name（与后端 PartListOut 对齐）；
//   - 删 customer_path（前端派生 l1 + customer_name，schema 不声明）；
//   - 删 next_process_id / next_process_name（列表响应不返，schema 不声明）；
//   - unit_price / total_price：z.number() → z.string()（rust_decimal string）。
export const partSchema = z.object({
  id: z.string(),
  version: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  applicant_name: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.string(),
  total_price: z.string(),
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
  l1_customer_name: z.string().nullable(),
  location: z.string().nullable(),
  holder_name: z.string().nullable().optional(),
  process_chain_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  batch_no: z.number().nullable().optional(),
  batch_quantity: z.number().nullable().optional(),
  // 2026-09-28 修复：兼容 /parts/pending-programming 等不返 row_type 的端点（后端 modules/part/service/crud.rs::list_parts 真正合并后，GET /parts 始终返 'PART' | 'ASSEMBLY'；但 pending-programming / 工艺制定等旧端点仍可能缺该字段）
  row_type: z.enum(['PART', 'ASSEMBLY']).default('PART'),
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

/** 2026-09-29 新增：com/union-list 列表响应 schema 别名（与 partListResultSchema 同形）。
 *  union-list 端点返回 items 数组中行 row_type 已是 'PART' | 'ASSEMBLY'（partSchema 已
 *  用 z.enum 锁字面量 + default('PART') 兜底），所以同一 partListResultSchema 兼容。
 *  另起类型别名便于 useQuery 类型签名清晰表达「查询的是 com 域端点」。 */
export type UnionListResultSchema = PartListResultSchema;

/** 2026-09-29 新增：part-file 列表项 schema（与 backend-rust PartFileItem 对齐）。
 *  12 字段显式声明（Zod 默认 strip 模式缺字段会静默丢）：
 *  id / version / owner_id / kind / file_type / original_filename / file_size /
 *  content_type / upload_status / content_sha256 / created_at / paired_file_id。
 *  kind 锁 z.enum 与 backend-rust PartFileKind 字符串值对齐（DRAWING / 3D_MODEL /
 *  G_CODE / SETUP_SHEET / ASSEMBLY_MASTER / CAD_2D）；content_sha256 / paired_file_id
 *  nullable（NULL = 未计算 / 未配对）。 */
export const partFileSchema = z.object({
  id: z.string(),
  version: z.number(),
  owner_id: z.string(),
  kind: z.enum(['DRAWING', '3D_MODEL', 'G_CODE', 'SETUP_SHEET', 'ASSEMBLY_MASTER', 'CAD_2D']),
  file_type: z.string(),
  original_filename: z.string(),
  file_size: z.string(),
  content_type: z.string(),
  upload_status: z.string(),
  content_sha256: z.string().nullable(),
  created_at: z.string(),
  paired_file_id: z.string().nullable(),
});

export type PartFileSchema = z.infer<typeof partFileSchema>;

/** 2026-09-29 新增：part-file 列表分页结果。2026-09-29 修复 review 第 1 轮 schema
 *  mismatch：后端 backend-rust `src/modules/part_file/vo/part_file.rs:58-62`
 *  `PartFileListOut` 真契约只返回 `items` + `total` 2 字段，没有 limit/offset。
 *  原 schema 强校验 limit/offset → 运行时 100% ZodError 崩溃。
 *  现改为 optional —— 即使后端后续扩展 limit/offset 字段也不会破前端（向后兼容），
 *  Zod 默认 strip 模式会静默丢弃多余字段，前端不消费也无所谓。 */
export const partFileListResultSchema = z.object({
  items: z.array(partFileSchema),
  total: z.number(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export type PartFileListResultSchema = z.infer<typeof partFileListResultSchema>;

// ============================================================
// 2026-09-29 修复：装配件详情响应 schema（消化 backend-rust
// `#[serde(flatten)]` quirk）。
//
// 后端 `AssemblyDetail` 定义（backend-rust src/modules/assembly/vo/assembly.rs:113-119）：
//   #[derive(Serialize)]
//   pub struct AssemblyDetail {
//       #[serde(flatten)]
//       pub assembly: AssemblyOut,
//       pub children: Vec<AssemblyChildOut>,
//       pub files: Vec<AssemblyFileRef>,
//   }
//
// `#[serde(flatten)]` 把 AssemblyOut 全部字段平铺到顶层，**没有 `assembly` 嵌套键**。
// 旧 bug：前端 AssemblyDetail 类型契约是嵌套 `{assembly, children, files}` →
// detail.value.assembly === undefined → AssemblyInfoCard 不渲染 +
// canUploadTotalPdf/canAddChild computed 抛 TypeError → v-loading watcher 停摆。
//
// 本 commit 在 schema 层把后端真实 wire 形态锁死：
//   - assemblyOutSchema: AssemblyOut 19 字段
//   - assemblyChildOutSchema: AssemblyChildOut 13 字段
//   - assemblyFileRefSchema: AssemblyFileRef 3 字段
//   - assemblyDetailFlatSchema: 19 字段平铺 + children + files（实际 wire 形态）
//
// 注意：assemblyDetailFlatSchema 用 `.strict()` 而非默认 strip ——
// 若后端意外把 assembly 改回嵌套键（regression），Zod parse 会立刻抛错，
// 守门到位（M-1 同源问题：缺字段静默 strip = 校验形同虚设）。
// ============================================================

/** 装配件实体。字段集对齐 backend-rust `AssemblyOut`
 * （backend-rust src/modules/assembly/vo/assembly.rs:17-39），19 字段。 */
export const assemblyOutSchema = z.object({
  id: z.string(),
  version: z.number(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  name: z.string(),
  applicant_name: z.string().nullable(),
  customer_id: z.string(),
  request_date: z.string(),
  planned_delivery_date: z.string(),
  is_urgent: z.boolean(),
  status: z.enum([
    'PENDING',
    'IN_PROCESS',
    'INSPECTION',
    'READY_TO_SHIP',
    'DELIVERED',
    'COMPLETED',
    'CANCELLED',
  ]),
  quantity: z.number(),
  unit_price: z.string().nullable(),
  total_price: z.string().nullable(),
  order_no: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AssemblyOutSchema = z.infer<typeof assemblyOutSchema>;

/** 装配件子件出参。字段对齐 backend-rust `AssemblyChildOut`
 * （backend-rust src/modules/assembly/vo/assembly.rs:77-95），13 字段。
 *  注：后端 drawing_no 在 vo 层是 Option（model 层 NOT NULL），按 vo 契约 schema 声明 nullable。
 *  status 是 Part 业务枚举（10 态），与 partSchema 同源。 */
export const assemblyChildOutSchema = z.object({
  id: z.string(),
  version: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string().nullable(),
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
  quantity: z.number(),
  planned_delivery_date: z.string().nullable(),
  applicant_name: z.string(),
  request_date: z.string(),
  order_no: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  is_urgent: z.boolean(),
  note: z.string().nullable(),
  current_batch_id: z.string().nullable(),
});

export type AssemblyChildOutSchema = z.infer<typeof assemblyChildOutSchema>;

/** 装配件关联文件出参。字段对齐 backend-rust `AssemblyFileRef`
 * （backend-rust src/modules/assembly/vo/assembly.rs:101-107），3 字段。 */
export const assemblyFileRefSchema = z.object({
  id: z.string(),
  original_filename: z.string(),
  page_count: z.number().nullable(),
});

export type AssemblyFileRefSchema = z.infer<typeof assemblyFileRefSchema>;

/** 装配件详情（实际 wire 形态）。
 *
 * 后端用 `#[serde(flatten)]` 把 AssemblyOut 19 字段平铺到顶层 + children + files。
 * 这里**显式展开 19 字段**（不用 `.shape` spread，类型不安全），
 * 后续 mapper（api/assembly.ts::parseAssemblyDetail）把平铺转回嵌套。
 *
 * 用 `.strict()` 而非默认 strip：若后端意外把 assembly 改回嵌套键，parse 立刻抛错；
 * 守门到位（M-1 regression guard 同形态）。 */
export const assemblyDetailFlatSchema = z
  .object({
    // —— AssemblyOut 19 字段（字段集对齐 vo/assembly.rs:17-39）——
    id: z.string(),
    version: z.number(),
    serial_no: z.string().nullable(),
    drawing_no: z.string(),
    name: z.string(),
    applicant_name: z.string().nullable(),
    customer_id: z.string(),
    request_date: z.string(),
    planned_delivery_date: z.string(),
    is_urgent: z.boolean(),
    status: z.enum([
      'PENDING',
      'IN_PROCESS',
      'INSPECTION',
      'READY_TO_SHIP',
      'DELIVERED',
      'COMPLETED',
      'CANCELLED',
    ]),
    quantity: z.number(),
    unit_price: z.string().nullable(),
    total_price: z.string().nullable(),
    order_no: z.string().nullable(),
    system_delivery_date: z.string().nullable(),
    note: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    // —— 平铺之外的 children / files ——
    children: z.array(assemblyChildOutSchema),
    files: z.array(assemblyFileRefSchema),
  })
  .strict();

export type AssemblyDetailFlatSchema = z.infer<typeof assemblyDetailFlatSchema>;

/** 装配件文件出参数组（review 第 1 轮修复 C2）。
 *
 * 后端 uploadAssemblyPdf（POST /api/v2/assemblies/{id}/files）实际响应是
 * `R<Vec<AssemblyFileRef>>`（数组），不是 `R<AssemblyDetail>`。前端旧 bug
 * 走 parseAssemblyDetail 把数组塞进 z.object → ZodError。本 schema 锁死数组形态，
 * 让 mapper（api/assembly.ts::uploadAssemblyPdf）在 api 边界守门。 */
export const assemblyFileRefSchemaArray = z.array(assemblyFileRefSchema);

// ============================================================
// 2026-09-29 新增：待下发批次 schema（生产队列「待下发」Tab 共享基础数据层）。
//
// 字段对齐 backend-rust `PendingBatchItem` VO（src/modules/prod/batch/vo/pending_batch.rs），
// 17 字段全声明（缺字段 Zod 默认 strip 静默丢弃 = 守门失效 —— 沿 M-1 regression guard 同源原则）：
  //   id (batch_id) / part_id / batch_no (string) / quantity / serial_no / name /
  //   drawing_no / planned_delivery_date / system_delivery_date / customer_name /
  //   parent_customer_name / applicant_name / is_urgent / note / version /
  //   current_process_step_id / process_chain_id。
//
// batch_no 后端是 string（与 PoolBatchItemDto 的 number 区分），前端 UI 加 'B' 前缀；
// 日期字段 nullable；note / customer_name / parent_customer_name / applicant_name /
// serial_no 全部 nullable（与 HeldBatchItemDto 同形态）。
// ============================================================

export const pendingBatchItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.string(),
  quantity: z.number(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  planned_delivery_date: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  applicant_name: z.string().nullable(),
  is_urgent: z.boolean(),
  note: z.string().nullable(),
  version: z.number(),
  current_process_step_id: z.string().nullable(),
  process_chain_id: z.string().nullable(),
});

export type PendingBatchItemSchema = z.infer<typeof pendingBatchItemSchema>;

/** 2026-09-29 新增：待下发批次列表分页结果（结构对齐 backend-rust PendingBatchListOut）。 */
export const pendingBatchListResultSchema = z.object({
  items: z.array(pendingBatchItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type PendingBatchListResultSchema = z.infer<typeof pendingBatchListResultSchema>;
