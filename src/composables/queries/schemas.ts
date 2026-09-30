/** 2026-09-29 新增：生产统计 overview 出参 schema（守门 backend-rust OverviewOut VO）。
 *
 * 字段对齐 src/types/statistics.ts::OverviewOut：
 *   - 顶层 date_from / date_to：日期范围 string（'YYYY-MM-DD'，来自 caller）。
 *   - 8 个基础统计 number：created_count / completed_count / in_process_count /
 *     delivered_count / late_orange_count / late_red_count /
 *     overdue_undelivered_count / repair_part_count。
 *   - delivered_value：rust_decimal::Decimal + serde-with-str → string，
 *     与 unit_price / total_price 同形态（不强制 .regex）。
 *   - 4 个图表：daily_created / daily_completed / delivery_performance /
 *     status_distribution 数组。
 *
 * dashboard 域只消费 overdue_undelivered_count 字段（2026-09-29 重做后
 * DashboardKpiTiles「逾期未交」tile），但 schema 仍对齐全 VO 字段集（沿
 * 2026-09-26 约定 #4：基础数据 schema 与后端契约对齐，缺字段静默 strip =
 * 校验形同虚设 —— 见 M-1 regression guard）。
 *
 * 沿用 CLAUDE.md §M-4 strip 陷阱：所有非 Option 字段必填显式声明，调用方
 * 通过 overviewOutSchema.parse(response) 在 api 边界守门。 */
export const overviewOutSchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  created_count: z.number(),
  completed_count: z.number(),
  in_process_count: z.number(),
  delivered_count: z.number(),
  delivered_value: z.string(),
  late_orange_count: z.number(),
  late_red_count: z.number(),
  overdue_undelivered_count: z.number(),
  repair_part_count: z.number(),
  daily_created: z.array(
    z.object({
      date: z.string(),
      count: z.number(),
    }),
  ),
  daily_completed: z.array(
    z.object({
      date: z.string(),
      count: z.number(),
    }),
  ),
  delivery_performance: z.object({
    on_time: z.number(),
    orange: z.number(),
    red: z.number(),
  }),
  status_distribution: z.array(
    z.object({
      status_value: z.string(),
      count: z.number(),
    }),
  ),
});

export type OverviewOutSchema = z.infer<typeof overviewOutSchema>;

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
 * requires_approval / color / created_at / updated_at 共 11 字段），无需补字段。
 *
 * 2026-09-29 新增：is_cnc 字段（12 字段）。CNC 编程门控：是否参与「待编程一览」
 * Tab 化（GET /parts/pending-programming 出参 `PartListItem.has_cnc_program` 字段即
 * 按 chain 中是否含 is_cnc=true 的工序派生命中）。沿 CLAUDE.md §M-4 strip 陷阱
 * 必填 boolean 显式声明 —— 后端漏返 Zod parse 抛错守门。
 *
 * 2026-09-30 修复：description / color 加 `.optional()` 兼容后端 skip_serializing_if。
 * 后端 `ProcessOut` (backend-rust src/modules/prod/process/vo/process.rs:15-20) 对
 * description (line 15) 与 color (line 19) 两个 `Option<String>` 字段加了
 * `#[serde(skip_serializing_if = "Option::is_none")]` —— `None` 时整个字段从
 * JSON 响应中省略（不是序列化为 `null`）。原 schema 只用 `.nullable()` 不放宽
 * required，字段缺失时 Zod 抛 `Required` error → queryFn parse 失败 →
 * data === undefined → 整张 process 列表消费侧退化：ProcessTab.vue 表格空、
 * WorkerQueueBoard.vue 没有 INHOUSE 工序 tab、usePartDispatch 工序下拉空。
 * `.nullable()` 与 `.optional()` 是正交维度（前者放宽类型、后者放宽 required），
 * 必须并存才能同时接受 null 与字段缺失两种形态。3 处共用 cache 的 view caller
 * （数据层 1 处 parse 点 useProcessesQuery.ts:39 + 3 处 view caller：
 * ProcessTab.vue:255 + WorkerQueueBoard.vue:153 + usePartDispatch.ts:104 共用同一份 cache）
 * 因此受影响；另有 8 处 caller
 * （PendingProgrammingList.vue:413 / ShelfList.vue:324 /
 * ProcessPickerDialog.vue:180 / InspectionPending.vue:865 /
 * OutsourceQuoteList.vue:79 / OutsourceSendReceive.vue:75 /
 * OutsourceList.vue:341 / PartDetail.vue:579 / usePartProcessDesign.ts:220 /
 * ProcessWorkTypeMappingTab.vue:108 / RepairStartDialog.vue:87 等）走
 * `resp.items` 直接消费、不经 Zod，不受本回归影响。 */
export const processSchema = z.object({
  id: z.string(),
  version: z.number(),
  code: z.string(),
  name: z.string(),
  category: z.enum(['INHOUSE', 'OUTSOURCE']),
  sort_order: z.number(),
  // 2026-09-30 修复：加 .optional() 兼容后端 skip_serializing_if（None 时整个字段
  // 从 JSON 响应中省略，不是 null —— 见 processSchema 顶部注释）。
  description: z.string().nullable().optional(),
  requires_approval: z.boolean(),
  // 2026-09-30 修复：同上，加 .optional() 兼容后端 skip_serializing_if。
  color: z.string().nullable().optional(),
  is_cnc: z.boolean(),
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
  // 2026-09-29 新增：是否已上传 CNC 程序（z.boolean 必填；沿 CLAUDE.md §M-4 strip
  // 陷阱 —— 后端若漏返该字段 Zod parse 会抛错，守门到位）。仅 chain 含 CNC 工序
  // 的 part 才有非 false 值；其它 part 恒为 false（后端 service 层派生）。
  has_cnc_program: z.boolean(),
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
  // 2026-09-29 修复：后端 VO 实为 i32，但前端 contract 注释误标 string；走 union + transform
  // 归一成 string 守门（沿 2026-09-26 Zod 守门约定 §4，缺字段静默 strip = 校验失效）。
  batch_no: z.union([z.string(), z.number()]).transform((v) => String(v)),
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

// ============================================================
// 2026-09-29 修复 dispatch 契约漂移：4 个新 schema 守门 dispatch / bulkDispatch / autoDispatch。
//
// 历史教训（2026-09-29 explore 报告）：
//   1. `bulkDispatchBatches` 旧前端 payload `{ batch_ids, shelf_id, next_process_id }`
//      与 backend-rust `BulkDispatchRequest { targets: [{ batch_id, target_process_id }] }`
//      完全错位 —— 即便传 `nextProcessId` 也会被后端 422 拒。
//   2. `dispatchBatch` URL 漂移：前端 `/batches/{id}/dispatch` vs 后端 `/batches/dispatch`
//      （batch_id 走 body 不走 URL）；payload `shelf_id/next_process_id` vs `target_process_id/note`。
//   3. `autoDispatchBatches` 响应：前端读 `res.failed` 但 backend `AutoDispatchResult`
//      实际只有 `{ succeeded, skipped: [{batch_id, reason}] }` —— `res.failed` 为 undefined，
//      触发 `Cannot read properties of undefined (reading 'length')`。
//
// 字段对齐 backend-rust `src/modules/prod/batch/vo.rs:88-119`（DispatchResult 5 字段、
// BulkDispatchResult 2 字段、AutoDispatchResult 2 字段 + DispatchFailureItem /
// AutoDispatchSkippedItem 形态）。
//
// 注：DispatchFailureItem（{ batch_id, code, message }）与 AutoDispatchSkippedItem
// （{ batch_id, reason }）形态不同 —— 前者是业务码 + 抛出，后者是字符串 reason +
// soft-skip。bulk-dispatch 失败数组在事务回滚模式下恒空（auto-dispatch.md:124），
// 但保留 schema 以防 backend 后续改为 partial commit。
// ============================================================

/** `POST /api/v2/prod/batches/dispatch` 出参（rust DispatchResult）。
 *  5 字段：batch_id / current_process_step_id（Option<i64>，dispatch 路径不解析 step →
 *  null）/ target_process_id / shelf_id / version。 */
export const dispatchResultSchema = z.object({
  batch_id: z.string(),
  current_process_step_id: z.string().nullable(),
  target_process_id: z.string(),
  shelf_id: z.string(),
  version: z.number(),
});

export type DispatchResultSchema = z.infer<typeof dispatchResultSchema>;

/** `POST /api/v2/prod/batches/bulk-dispatch` 请求（rust BulkDispatchRequest）。
 *  targets 数组元素至少 1 条（空数组 → 40001，bulk-dispatch.md:124）。 */
export const bulkDispatchRequestSchema = z.object({
  targets: z.array(
    z.object({
      batch_id: z.string(),
      target_process_id: z.string(),
    }),
  ),
});

export type BulkDispatchRequestSchema = z.infer<typeof bulkDispatchRequestSchema>;

/** `POST /api/v2/prod/batches/bulk-dispatch` 出参（rust BulkDispatchResult）。
 *  succeeded / failed 分别记录成功与失败件；当前实现「任一失败 → 全回滚」，failed
 *  数组恒空 —— 但 schema 保留以防 backend 后续改为 partial commit。 */
export const bulkDispatchResultSchema = z.object({
  succeeded: z.array(dispatchResultSchema),
  failed: z.array(
    z.object({ batch_id: z.string(), code: z.number(), message: z.string() }),
  ),
});

export type BulkDispatchResultSchema = z.infer<typeof bulkDispatchResultSchema>;

/** `POST /api/v2/prod/batches/auto-dispatch` 出参（rust AutoDispatchResult）。
 *  succeeded / skipped —— 跳过不影响事务，reason 字符串区分 'NO_PROCESS_CHAIN' /
 *  'NO_PROCESS_STEP'（auto-dispatch.md:156-161）。旧前端读 `res.failed.length` 抛
 *  `Cannot read properties of undefined (reading 'length')`，根因即「field 漂移
 *  未守门」。 */
export const autoDispatchResultSchema = z.object({
  succeeded: z.array(dispatchResultSchema),
  skipped: z.array(z.object({ batch_id: z.string(), reason: z.string() })),
});

export type AutoDispatchResultSchema = z.infer<typeof autoDispatchResultSchema>;

// 2026-09-29 review 第 1 轮新增：worker 持有批次（held）schema（rust HeldBatchItem）。
//
// 字段对齐 backend-rust `HeldBatchItem` VO（src/modules/worker_pool/vo/worker_pool.rs
// HeldBatchItem 结构），与 HeldBatchItemDto 字段一一对应。held_batches 元素 17 字段
// 全声明（沿 CLAUDE.md §M-4 strip 陷阱 —— zod 默认 strip 模式缺字段会静默丢，
// 后端漏返字段不会触发 parse 报错，导致前端 UI 显示异常但 queryFn 不抛错）：
//   batch_id / part_id / batch_no (number) / quantity / serial_no / drawing_no /
//   name / system_delivery_date / planned_delivery_date / is_urgent /
//   customer_name / parent_customer_name / applicant_name / location /
//   shelf_code / note / has_cnc_program (review 第 1 轮新增) / version。
//
// 与 PoolBatchItemDto 区别：
//   - 包含 planned_delivery_date（held 是已下发的批次，期望有计划交期）
//   - 包含 shelf_code / note / parent_customer_name（held 展示字段更全）
//   - 没有 shelf_id / shelf_name / customer_path / current_process_step_id
//     （held 状态下 batch 已在 worker 手中，shelf 字段语义退化）
//   - 没有 batch_no 类型差异（held 用 number，与 PoolBatchItemDto 同形态）
//
// 数据流：`GET /api/v2/prod/worker-pool/state?worker_id=&shelf_id=` 响应中
// WorkerStateDto.held_batches 元素。本 schema 是 defensive parse 备用，当前
// queryFn 层未挂 zod 解析（held 数据流通过 useWorkerQueue 适配）；后续如需
// 在 api 边界挂 zod，可直接套用本 schema。
// ============================================================
export const heldBatchItemSchema = z.object({
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
  customer_name: z.string().nullable(),
  parent_customer_name: z.string().nullable(),
  applicant_name: z.string().nullable(),
  location: z.string(),
  shelf_code: z.string().nullable(),
  note: z.string().nullable(),
  // 2026-09-29 review 第 1 轮：与 partSchema.has_cnc_program 同源 regression
  // guard —— 后端若漏返该字段，Zod parse 立刻抛错。沿 chain 派生（service 层
  // t_part_file EXISTS），非 CNC 链 part 恒为 false。
  has_cnc_program: z.boolean(),
  version: z.number(),
});

export type HeldBatchItemSchema = z.infer<typeof heldBatchItemSchema>;

// ============================================================
// 2026-09-30 新增：worker-pool 域 4 个 schema（生产队列 Tab 懒加载 +
// 数据层 TanStack Query 化）。
//
// 字段对齐 backend-rust `src/modules/worker_pool/vo/worker_pool.rs`：
//   - WorkerBrief：4 字段（worker_id / name / work_type_id / work_type_code）
//   - WorkTypeMaxHeld：4 字段（work_type_id / code / name / max_held_batches nullable）
//   - PoolBatchItem：21 字段（含 current_process_step_id nullable、has_cnc_program
//     必填 —— 沿 CLAUDE.md §M-4 strip 陷阱 guard）
//   - ProcessPoolDetail（workerPoolByProcess）：6 顶层字段（process_id / code /
//     name / workers[] / work_types[] / items[]）+ total
//   - WorkerPoolCountsOut：counts[] + total（shelf_id）
//   - WorkerPoolState：8 字段（含 work_type_code nullable / pool_count_by_process[]
//     / held_batches[]）
//
// 所有非 Option 字段 schema 必填显式声明（沿 CLAUDE.md §M-4 strip 陷阱 ——
// Zod 默认 strip 模式会让缺字段静默丢失，导致校验形同虚设）。
// 引用 heldBatchItemSchema 校验 held_batches 元素（与 backend-rust HeldBatchItem
// 严格对齐）。
// ============================================================

/** 2026-09-30 新增：`GET /api/v2/prod/worker-pool/{process_id}` 内嵌的工人
 *  简短记录。4 字段全声明：worker_id / name / work_type_id / work_type_code。
 *  work_type_id 是雪花 ID string；work_type_code 是人类可读 code（如 'CNC'）。
 *  后端 WorkerBrief 结构。 */
export const workerBriefSchema = z.object({
  worker_id: z.string(),
  name: z.string(),
  work_type_id: z.string(),
  work_type_code: z.string(),
});

export type WorkerBriefSchema = z.infer<typeof workerBriefSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/worker-pool/{process_id}` 内嵌的工种
 *  + max_held 记录。4 字段：work_type_id / work_type_code / work_type_name /
 *  max_held_batches（nullable —— 未设置时前端渲染「工种 max_held 未设置」占位，
 *  后端 20904 错误语义对齐）。 */
export const workTypeMaxHeldSchema = z.object({
  work_type_id: z.string(),
  work_type_code: z.string(),
  work_type_name: z.string(),
  max_held_batches: z.number().nullable(),
});

export type WorkTypeMaxHeldSchema = z.infer<typeof workTypeMaxHeldSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/worker-pool/{process_id}` 内嵌的候选批次
 *  （PoolBatchItem，与 backend-rust PoolBatchItem VO 字段对齐 —— 21 字段）。
 *
 *  2026-09-29 review 第 1 轮新增字段：`has_cnc_program` 必填 boolean —— 沿
 *  CLAUDE.md §M-4 strip 陷阱守门，后端漏返该字段 Zod parse 立刻抛错。
 *
 *  字段含义（沿 backend-rust PoolBatchItem）：
 *    - batch_id / part_id / batch_no(number) / quantity / serial_no / drawing_no /
 *      name / system_delivery_date：基础展示字段；
 *    - customer_name / parent_customer_name / customer_path / applicant_name：
 *      客户 + 申请人；
 *    - location / shelf_id / shelf_code / shelf_name：候选池当前货架；
 *    - is_urgent / note / version：业务字段；
 *    - current_process_step_id：当前所在工艺链步骤 ID（nullable，与 PartBatch
 *      同语义）；
 *    - has_cnc_program：是否已上传 CNC 程序（沿 chain 派生，service 层
 *      t_part_file EXISTS 判定）。 */
export const poolBatchItemSchema = z.object({
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
  customer_path: z.string().nullable(),
  applicant_name: z.string().nullable(),
  location: z.string(),
  shelf_id: z.string(),
  shelf_code: z.string(),
  shelf_name: z.string(),
  is_urgent: z.boolean(),
  note: z.string().nullable(),
  // 2026-09-30 review 第 1 轮修复（M-1）：必填 nullable —— 与 partSchema 同源「缺字段必抛错」
  // 守门。原先 `.nullable().optional()` 让 strip 模式漏列 / 后端漏返时静默丢字段，违反
  // 「必填 nullable」契约（workerPool.contract.ts:165）。
  current_process_step_id: z.string().nullable(),
  // 2026-09-30 必填 boolean —— 与 partSchema.has_cnc_program 同源 regression guard。
  has_cnc_program: z.boolean(),
  version: z.number(),
});

export type PoolBatchItemSchema = z.infer<typeof poolBatchItemSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/worker-pool/{process_id}` 顶层出参
 *  （ProcessPoolDetail，与 backend-rust ProcessPoolDetail VO 字段对齐）。
 *  6 顶层字段 + total：process_id / process_code / process_name / workers[] /
 *  work_types[] / items[]。workers / work_types / items 三个数组必须全字段
 *  声明（M-1 strip 陷阱 —— 后端漏返任何数组字段会让整个 UI 退化为空）。 */
export const workerPoolByProcessSchema = z.object({
  process_id: z.string(),
  process_code: z.string(),
  process_name: z.string(),
  workers: z.array(workerBriefSchema),
  work_types: z.array(workTypeMaxHeldSchema),
  total: z.number(),
  items: z.array(poolBatchItemSchema),
});

export type WorkerPoolByProcessSchema = z.infer<typeof workerPoolByProcessSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/worker-pool/counts` 顶层出参
 *  （WorkerPoolCountsOut，与 backend-rust WorkerPoolCountsOut VO 字段对齐）。
 *  2 字段：counts[] + shelf_id。counts 元素（ProcessBatchCount）含 process_id /
 *  process_code / process_name / count。count 是 integer（仓库池中本次工序的
 *  候选 batch 总数）。 */
export const workerPoolCountsSchema = z.object({
  shelf_id: z.string().nullable(),
  counts: z.array(
    z.object({
      process_id: z.string(),
      process_code: z.string(),
      process_name: z.string(),
      count: z.number(),
    }),
  ),
  total: z.number(),
});

export type WorkerPoolCountsSchema = z.infer<typeof workerPoolCountsSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/worker-pool/state?worker_id=&shelf_id=`
 *  顶层出参（WorkerPoolState，与 backend-rust WorkerPoolState VO 字段对齐）。
 *  8 字段：worker_id / worker_name / work_type_code / max_held / current_held /
 *  capacity_remaining / pool_count_by_process[] / held_batches[]。
 *  held_batches 元素用 heldBatchItemSchema 复用（2026-09-29 已存在，与
 *  backend-rust HeldBatchItem 严格对齐）。
 *  work_type_code nullable —— 无工种时退化为空工种（worker 是 INACTIVE / 未指派
 *  工种的状态）。 */
export const workerStateSchema = z.object({
  worker_id: z.string(),
  worker_name: z.string(),
  work_type_code: z.string().nullable(),
  max_held: z.number(),
  current_held: z.number(),
  capacity_remaining: z.number(),
  pool_count_by_process: z.array(
    z.object({
      process_id: z.string(),
      pool_count: z.number(),
    }),
  ),
  held_batches: z.array(heldBatchItemSchema),
});

export type WorkerStateSchema = z.infer<typeof workerStateSchema>;
