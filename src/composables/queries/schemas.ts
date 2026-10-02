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
 * Tab 化（2026-10-01 起出参是 prod 域 `GET /prod/programming/pending` 的
 * `ProgrammingItem.has_cnc_program` 字段，即按 chain 中是否含 is_cnc=true 的工序
 * 派生命中；旧 part 域 `GET /parts/pending-programming` 出参
 * `PartListItem.has_cnc_program` 同语义）。沿 CLAUDE.md §M-4 strip 陷阱
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
  // 2026-09-28 修复：兼容不返 row_type 的端点（后端 modules/part/service/crud.rs::list_parts 真正合并后，GET /parts 始终返 'PART' | 'ASSEMBLY'；但工艺制定等旧端点仍可能缺该字段）。2026-10-01 备注：唯一曾缺该字段的 pending-programming 端点已下线（「待编程一览」数据源迁到 prod 域 GET /prod/programming/pending，其出参走独立的 pendingProgrammingItemSchema，不复用 partSchema），本 default 保留兼容其余历史端点。
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
// 2026-09-30 新增：part-batch（PartBatch）schema —— 供 dashboard
// PartPreviewDialog「该工单批次」列表用。
//
// 字段对齐 backend-rust `PartBatch` VO（src/api/parts/batch.ts:206-228），17 字段
// 全声明（沿 CLAUDE.md §M-4 strip 陷阱 —— Zod 默认 strip 模式会让缺字段静默
// 丢弃，必填字段必须显式声明）。
//
// 字段语义：
//   - id / version / part_id / batch_no / batch_label / quantity：基础标识 + 数量；
//   - status: string（不锁 enum —— 沿 backend-rust PartBatch.status 类型为 String
//     与 OrderStatus 语义对齐但前端不强制 lock 字面量集合；后续若收紧再加
//     z.enum(ORDER_STATUS_VALUES) 转换层）；
//   - location / current_holder_id / current_holder_display / next_process_name
//     / delivery_note_id / delivery_note_no / parent_batch_id：nullable 展示字段；
//   - current_process_step_id: optional + nullable（PR-3 新增，部分老接口可能未
//     带；新接口必带，前端 display 走 next_process_name 兜底）；
//   - created_at / updated_at: string 必填（沿 schemas 统一约定）。
// ============================================================

export const partBatchSchema = z.object({
  id: z.string(),
  version: z.number(),
  part_id: z.string(),
  batch_no: z.number(),
  batch_label: z.string(),
  quantity: z.number(),
  // 2026-09-30：status 用 z.string() 不锁 enum（与 backend-rust PartBatch.status
  // String 类型对齐；前端消费走 ORDER_STATUS_LABEL cast OrderStatus，不在 schema
  // 层强制字面量集合，避免后端扩展时整张 schema 失守）。
  status: z.string(),
  // 2026-10-02 契约对齐：后端 `PartBatchListItemOut`
  // （backend-rust src/modules/part/vo/part.rs:327，migration 005 起恒输出）新增
  // `is_repairing: bool` —— `REPAIRING` 状态已从 `PartStatus` 枚举降级为
  // `t_part_batch.is_repairing` 标记列，返修中的批次 `status` 恒为 `IN_PROCESS`。
  // 本 schema **不是** `.strict()`，此前正是「Zod 默认 strip 模式让缺字段静默丢弃」
  // 这个坑的活样本：后端已返回的该键被静默 strip 掉，下游拿不到「是否返修中」。
  is_repairing: z.boolean(),
  location: z.string().nullable(),
  current_holder_id: z.string().nullable(),
  current_holder_display: z.string().nullable(),
  // 2026-09-30：PR-3 新增 optional + nullable 兼容老接口（沿 backend-rust 注释）。
  current_process_step_id: z.string().nullable().optional(),
  next_process_name: z.string().nullable(),
  delivery_note_id: z.string().nullable(),
  delivery_note_no: z.string().nullable(),
  parent_batch_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type PartBatchSchema = z.infer<typeof partBatchSchema>;

/** 2026-09-30 新增：part-batch 列表分页结果（结构对齐 backend-rust PartBatchListOut，
 *  items + total 必填，limit/offset optional —— 与 partFileListResultSchema 同形）。
 *  2026-09-30 注：listPartBatches(partId) 当前 api wrapper 返回 raw PartBatch[]，
 *  queryFn 内手动 map 成 { items, total } → schema 守门；schema 形态与 api 形态
 *  解耦，便于后续后端返回 list out 时 queryFn 零改动（仅去掉 map）。 */
export const partBatchListResultSchema = z.object({
  items: z.array(partBatchSchema),
  total: z.number(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export type PartBatchListResultSchema = z.infer<typeof partBatchListResultSchema>;

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
// 字段对齐 backend-rust `PendingBatchItem` VO（src/modules/prod/batch/vo.rs），
// 17 字段全声明（缺字段 Zod 默认 strip 静默丢弃 = 守门失效 —— 沿 M-1 regression guard 同源原则）：
//   id (batch_id) / part_id / batch_no / quantity / serial_no / name /
//   drawing_no / planned_delivery_date / system_delivery_date / customer_name /
//   parent_customer_name / applicant_name / is_urgent / note / version /
//   current_process_step_id / process_chain_id。
//
// batch_no 后端是 i32（前端 UI 加 'B' 前缀展示）；日期字段 nullable；note /
// customer_name / parent_customer_name / applicant_name / serial_no 全部 nullable
// （与 HeldBatchItemDto 同形态）。
//
// 2026-09-30 契约校正（对齐 batch/vo.rs 实际 serde 声明）：
//   - `batch_no`：后端是 `pub batch_no: i32`（**非 String**）。旧 schema 走
//     union + transform 归一成 string 是基于「contract 注释误标」的误修，害得
//     `PendingBatchItemDto.batch_no` 被迫声明为 string，与后端真实类型不符。
//     现直接 `z.number()`，contract 侧同步改回 number。
//   - `current_process_step_id` / `process_chain_id`：后端是 `i64` +
//     `serialize_i64`（DB NULL 走 `.unwrap_or(0)` 兜底，见 vo.rs 字段注释），
//     **永不返 null**，语义为 "0" = 未设。旧 schema 写 `.nullable()` 是错的。
// ============================================================

export const pendingBatchItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
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
  // "0" 语义 = 未设 step（DB NULL 已被后端 unwrap_or(0) 兜底）
  current_process_step_id: z.string(),
  // "0" 语义 = 工单未挂工艺链
  process_chain_id: z.string(),
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
// 2026-10-01 新增：待编程一览（prod 域 programming）schema —— 守门
// `GET /api/v2/prod/programming/pending`。
//
// 端点迁移背景：「待编程一览」页数据源从 part 域
// `GET /parts/pending-programming`（恒返空，2026-10-01 已删前端 wrapper）切到 prod 域
// `GET /prod/programming/pending`（后端同期新增，backend-rust
// src/modules/prod/programming/mod.rs）。出参从 PartListItem 换成 ProgrammingItem。
//
// ProgrammingItem 13 字段全声明（沿 CLAUDE.md §M-4 strip 陷阱 —— Zod 默认 strip
// 模式会让缺字段静默丢弃，必填字段漏声明 = 整份校验形同虚设）：
//   id (雪花 ID string) / version (乐观锁 i32) / serial_no (nullable) /
//   name / drawing_no / quantity (i32) / status (String，语义同 OrderStatus 但
//   不锁字面量，与 partBatchSchema.status 同约定) / is_urgent /
//   planned_delivery_date (string) / system_delivery_date (nullable) /
//   customer_name (nullable，L2) / parent_customer_name (nullable，L1) /
//   has_cnc_program (bool 必填 —— 本页 Tab 化关键字段)。
//
// ⚠️ 客户字段名与 part 域**不同名**：这里是 parent_customer_name(L1) /
// customer_name(L2)，而 PartListItem 是 l1_customer_name / customer_name。
// 两个端点的 rows 不能互相 cast（列渲染已按本页 schema 读 parent_customer_name）。
// ============================================================

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
});

export type PendingProgrammingItemSchema = z.infer<typeof pendingProgrammingItemSchema>;

/** 2026-10-01 新增：待编程列表分页结果（结构对齐 backend-rust ProgrammingListOut：
 *  items / total / limit / offset 四字段，后端用 JSON number 返回计数
 *  ——与 inspectionBatchListResultSchema 的「string 计数」形态不同，本页按 number 声明）。 */
export const pendingProgrammingListResultSchema = z.object({
  items: z.array(pendingProgrammingItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type PendingProgrammingListResultSchema = z.infer<typeof pendingProgrammingListResultSchema>;

// ============================================================
// 2026-10-01 新增：货架实体 + 货架列表分页结果 schema（共享基础数据层
// useProductionShelvesQuery 守门）。
//
// 字段对齐 @/types/shelf.ts::Shelf 的 10 字段：id / version / code / name / zone
// （PRODUCTION | INSPECTION，string 不锁 enum）/ location (nullable) / is_active /
// display_order / created_at / updated_at。10 字段全声明
// （沿 §M-4 strip 陷阱 guard）。入参形态见 @/api/shelves::ListShelvesParams。
//
// 2026-10-02 摘除 account_count：**用户决定货架列表页不再展示账号数**（决策理由
// 与 @/types/shelf::Shelf 处的说明一致）。此前它是被显式声明的必填字段，后端一删
// 这个 schema 会对真实响应直接抛 ZodError —— 摘字段必须同步改 schema，否则是
// 「修一个崩一片」。
// 注意因果方向：后端 ShelfOut 在同 PR 已删该字段，但那是另一次独立决策，不是
// 「后端删了所以前端跟着删」；写成后者会让下一个读者误以为前端摘字段是被动响应。
// ============================================================

export const shelfSchema = z.object({
  id: z.string(),
  version: z.number(),
  code: z.string(),
  name: z.string(),
  zone: z.string(),
  location: z.string().nullable(),
  is_active: z.boolean(),
  display_order: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ShelfSchema = z.infer<typeof shelfSchema>;

/** 货架列表分页结果（结构对齐 ShelfListResult：items / total / limit / offset）。 */
export const shelfListResultSchema = z.object({
  items: z.array(shelfSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type ShelfListResultSchema = z.infer<typeof shelfListResultSchema>;

// ============================================================
// 2026-10-02 新增：货架↔工序映射全集 schema（共享基础数据层
// useShelfProcessMappingsQuery 守门）。
//
// 字段对齐 backend-rust `AllShelfProcessMappingItem`
// （src/modules/prod/shelf_process/vo.rs:43-50 —— :43 是 `pub struct`，它上面
// 36-41 行是文档注释、42 行是 `#[derive]`），4 字段：
//   - shelf_id / process_id：`i64` + `serialize_i64` ⇒ 前端收 string（雪花 ID）；
//   - shelf_code / process_code：非 Option String。
//
// ⚠️ 与 `ShelfProcessMappingItem`（单架 VO，5 字段）只差 `sort_order` —— 全集接口
// **不返** sort_order（排序由 service 层 ORDER BY 保证）。守门时**不要**把 sort_order
// 声明进来：那会让 parse 在真实响应上 100% 抛错（漏声明的必填字段 = 校验形同虚设，
// 误声明的多余必填字段 = 校验过严把好数据打死，两者都是契约没对齐）。
//
// ⚠️ 4 个字段必须**全部显式声明**（沿 §M-4 strip 陷阱）：Zod 默认 strip 模式下漏声明的
// 字段会被静默丢弃、parse 不报错。其中 shelf_code / process_code 漏声明的后果最隐蔽
// —— regroup 出来的 mapping（只读 shelf_id / process_id）在守卫失效时仍然「看起来正常」，
// 漂移要到 UI 上渲染出空白 chip 才暴露。守门是 BUG-3（把扁平行当「一架子集一行」读 →
// new Set(undefined) → 8 个页面的货架/工序下拉被静默清空）能长期潜伏的根因对策。
// ============================================================

export const shelfProcessMappingItemSchema = z.object({
  shelf_id: z.string(),
  shelf_code: z.string(),
  process_id: z.string(),
  process_code: z.string(),
});

export type ShelfProcessMappingItemSchema = z.infer<typeof shelfProcessMappingItemSchema>;

/** `GET /api/v2/prod/shelf-processes` 顶层出参（rust AllShelfProcessMappingOut）
 *  —— 只有 items 一个字段，**没有** total / limit / offset（与 shelfListResultSchema
 *  那种分页结果不同形）。 */
export const shelfProcessMappingsResultSchema = z.object({
  items: z.array(shelfProcessMappingItemSchema),
});

export type ShelfProcessMappingsResultSchema = z.infer<typeof shelfProcessMappingsResultSchema>;

// ============================================================
// dispatch / auto-dispatch 契约守门 schema。
//
// 2026-09-30 重写（后端 batch 域重构，见
// backend-rust/src/modules/prod/batch/{mod.rs,dto.rs,vo.rs,service.rs} 与
// docs/api/production/batches.md）：
//   1. **dispatch 统一 bulk-only**：请求 `{targets: [{batch_id, target_process_id}], note?}`，
//      单条下发即 `targets.length == 1`；旧 `DispatchRequest { batch_id, target_process_id }`
//      单体形态已删。
//   2. **bulk-dispatch 端点删除**（router 层不再挂载 ⇒ 404）：批量下发复用
//      dispatch 的 targets 数组。故 `bulkDispatchRequestSchema` /
//      `bulkDispatchResultSchema` 一并删除。
//   3. **dispatch 出参改列表形态**：`DispatchResult { succeeded[], failed[] }`
//      （旧前端 schema 描述的是单个 `DispatchSuccessItem`，与真实响应错位）。
//      `failed` 当前恒空（任一失败 → service 抛 AppError 全回滚），且 rust 侧
//      带 `skip_serializing_if = "Vec::is_empty"` ⇒ 字段会被**整个省略**，
//      故 schema 用 `.default([])` 兜底。
//   4. **auto-dispatch 改为只读 preview**：出参由旧 `{succeeded, skipped}` 改为
//      `{items: [AutoDispatchItem]}`，不再写库。`AutoDispatchItem` 9 字段中
//      `process_chain_id` / `first_process_id` / `first_shelf_id` 走
//      `serialize_i64_opt`（None → JSON null），`first_process_code` /
//      `first_process_name` 是非 Option String（后端 `unwrap_or_default()` 兜空串，
//      见 service.rs:289-290 / 310），`skip_reason` 非 Option 但可为空串。
//
// 历史教训（2026-09-29 首轮漂移）：旧前端读 `res.failed.length` 抛
// `Cannot read properties of undefined (reading 'length')`，根因即「字段漂移 +
// 未守门」。本次所有形态变更都同步更新 schema 并补 spec 用例。
// ============================================================

/** `POST /api/v2/prod/batches/dispatch` 请求（rust DispatchRequest）。
 *  targets 至少 1 条（空数组 → 40001 VALIDATION_ERROR / HTTP 422）。 */
export const dispatchRequestSchema = z.object({
  targets: z
    .array(
      z.object({
        batch_id: z.string(),
        target_process_id: z.string(),
      }),
    )
    .min(1),
  note: z.string().optional(),
});

export type DispatchRequestSchema = z.infer<typeof dispatchRequestSchema>;

/** `DispatchResult.succeeded[]` 单条（rust DispatchSuccessItem，vo.rs）。 */
export const dispatchSuccessItemSchema = z.object({
  batch_id: z.string(),
  /** Option<i64>（dispatch 路径不解析 step → None → JSON null） */
  current_process_step_id: z.string().nullable(),
  target_process_id: z.string(),
  /** service 按 target_process_id 在 t_shelf_process 解析出的货架（sort_order ASC LIMIT 1） */
  shelf_id: z.string(),
  version: z.number(),
});

export type DispatchSuccessItemSchema = z.infer<typeof dispatchSuccessItemSchema>;

/** `DispatchResult.failed[]` 单条（rust DispatchFailureItem）。
 *  当前实现「任一失败 → 全回滚」，该数组恒空（vo.rs 注释：预留 partial commit
 *  未来扩展），schema 保留以防后端启用 partial commit。 */
export const dispatchFailureItemSchema = z.object({
  batch_id: z.string(),
  code: z.number(),
  message: z.string(),
});

export type DispatchFailureItemSchema = z.infer<typeof dispatchFailureItemSchema>;

/** `POST /api/v2/prod/batches/dispatch` 出参（rust DispatchResult）。
 *  `failed` 用 `.default([])`：rust 侧 `skip_serializing_if = "Vec::is_empty"`
 *  会把空数组整个从 JSON 中省略。 */
export const dispatchResultSchema = z.object({
  /** 成功下发的 batch 列表（顺序与 req.targets 一致） */
  succeeded: z.array(dispatchSuccessItemSchema),
  failed: z.array(dispatchFailureItemSchema).default([]),
});

export type DispatchResultSchema = z.infer<typeof dispatchResultSchema>;

/** `POST /api/v2/prod/batches/auto-dispatch` 请求（rust AutoDispatchRequest）。
 *  后端是 `Option<Vec<i64>>` + `deserialize_i64_vec_opt`：缺省 / null / 空数组
 *  三种形态都返 40001，故 schema 锁死非空。 */
export const autoDispatchRequestSchema = z.object({
  batch_ids: z.array(z.string()).min(1),
});

export type AutoDispatchRequestSchema = z.infer<typeof autoDispatchRequestSchema>;

/** `AutoDispatchResult.items[]` 单条（rust AutoDispatchItem，vo.rs）。 */
export const autoDispatchItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  /** Option<i64>：skip_reason = NO_PROCESS_CHAIN 时为 null */
  process_chain_id: z.string().nullable(),
  /** Option<i64>：skip_reason = NO_PROCESS_CHAIN / NO_PROCESS_STEP 时为 null；
   *  NO_SHELF 时仍 Some（首道工序存在但未映射货架） */
  first_process_id: z.string().nullable(),
  /** 非 Option String：取不到时后端 `unwrap_or_default()` 兜空串 */
  first_process_code: z.string(),
  /** 非 Option String：同上 */
  first_process_name: z.string(),
  /** Option<i64>：skip_reason 非 null 时通常为 null */
  first_shelf_id: z.string().nullable(),
  /** NOT_FOUND / NO_PROCESS_CHAIN / NO_PROCESS_STEP / NO_SHELF 之一；
   *  null = 可下发。中文文案映射见 api/pendingBatches.ts::AUTO_DISPATCH_SKIP_REASON_LABELS */
  skip_reason: z.string().nullable(),
});

export type AutoDispatchItemSchema = z.infer<typeof autoDispatchItemSchema>;

/** `POST /api/v2/prod/batches/auto-dispatch` 出参（rust AutoDispatchResult）。
 *  **只读预览**：不写库、不发 WS。`items` 按 req.batch_ids 入参顺序稳定排序。
 *  可下发项 = `skip_reason === null` 且 `first_process_id !== null`。 */
export const autoDispatchResultSchema = z.object({
  items: z.array(autoDispatchItemSchema),
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
// 数据流：`GET /api/v2/prod/pool/state?worker_id=&shelf_id=` 响应中
// WorkerPoolState.held_batches 元素。本 schema 由 `workerStateSchema.held_batches`
// 消费（useWorkerStateByWorkerQuery 挂 zod 解析）。
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

/** 2026-09-30 新增：`GET /api/v2/prod/pool/{process_id}` 内嵌的工人
 *  简短记录（rust WorkerBrief，vo/worker_pool.rs）。4 字段全声明：
 *  worker_id / name / work_type_id / work_type_code。 */
export const workerBriefSchema = z.object({
  worker_id: z.string(),
  name: z.string(),
  work_type_id: z.string(),
  work_type_code: z.string(),
});

export type WorkerBriefSchema = z.infer<typeof workerBriefSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/pool/{process_id}` 内嵌的工种
 *  + max_held 记录（rust WorkTypeMaxHeld）。4 字段：work_type_id / work_type_code /
 *  work_type_name / max_held_batches（nullable —— 未设置时前端渲染「工种 max_held
 *  未设置」占位，与后端 20904 BIZ_WORK_TYPE_MAX_HELD_NOT_SET 语义对齐）。 */
export const workTypeMaxHeldSchema = z.object({
  work_type_id: z.string(),
  work_type_code: z.string(),
  work_type_name: z.string(),
  max_held_batches: z.number().nullable(),
});

export type WorkTypeMaxHeldSchema = z.infer<typeof workTypeMaxHeldSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/pool/{process_id}` 内嵌的候选批次
 *  （rust PoolBatchItem，vo/worker_pool.rs:14-50 —— 20 字段）。
 *
 *  字段含义（沿 backend-rust PoolBatchItem）：
 *    - batch_id / part_id / batch_no(i32) / quantity / serial_no / drawing_no /
 *      name / system_delivery_date：基础展示字段；
 *    - customer_name / parent_customer_name / customer_path / applicant_name：
 *      客户 + 申请人；
 *    - location / shelf_id / shelf_code / shelf_name：候选池当前货架
 *      （`shelf_id` = t_part_batch.current_holder_id，**POOL → WORKER move 的
 *      `from.shelf_id` 必须取此值**，候选池跨货架，不能拿用户当前激活货架凑）；
 *    - is_urgent / note / version：业务字段；
 *    - has_cnc_program：是否已上传 CNC 程序（service 层 t_part_file EXISTS 判定）——
 *      必填 boolean，沿 CLAUDE.md §M-4 strip 陷阱守门。
 *
 *  2026-09-30 契约漂移修复：**删 `current_process_step_id`**。后端 `PoolBatchItem`
 *  没有这个字段，此前前端 contract + schema 都声明了它（required nullable），
 *  导致 `workerPoolByProcessSchema.parse` **永远失败** → WorkerPoolTab 永久
 *  「加载失败」、拖拽 pool → worker 链路整体不可用。 */
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
  // 2026-09-30 必填 boolean —— 与 partSchema.has_cnc_program 同源 regression guard。
  has_cnc_program: z.boolean(),
  version: z.number(),
});

export type PoolBatchItemSchema = z.infer<typeof poolBatchItemSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/pool/{process_id}` 顶层出参
 *  （rust ProcessPoolDetail，vo/worker_pool.rs:72-84）。6 顶层字段 + total：
 *  process_id / process_code / process_name / workers[] / work_types[] / items[]。
 *  workers / work_types / items 三个数组必须全字段声明（M-1 strip 陷阱 —— 后端漏返
 *  任何数组字段会让整个 UI 退化为空）。 */
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

/** 2026-09-30 新增：`GET /api/v2/prod/pool/counts` 顶层出参
 *  （rust WorkerPoolCountsOut，worker_pool/dto.rs —— **只有 2 字段**）。
 *  counts 元素（ProcessBatchCount）含 process_id / process_code / process_name /
 *  count；total = counts 求和。含 0 候选批次的工序不出现在 counts 中
 *  （SQL GROUP BY 不输出 0 行）。
 *
 *  2026-09-30 契约漂移修复：**删 `shelf_id`**。后端 `pool_counts` handler
 *  （handler.rs:146-153）只有 `State` + `CurrentUser`，不接 Query extractor；
 *  `WorkerPoolCountsOut` 也没有 shelf_id 字段。此前 schema 声明
 *  `shelf_id: z.string().nullable()` 必填，导致 `workerPoolCountsSchema.parse`
 *  **永远失败** → 生产队列 tab 徽标恒 0、「待下发」工序卡 badge 恒空。 */
export const workerPoolCountsSchema = z.object({
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

/** `TakenItem`（rust worker_pool/model.rs:13-30）—— 既是 `RefillResult.taken[]`
 *  元素，也是 `MoveResult.taken`（仅 POOL→WORKER 时填）元素。
 *  声明在 refillResultSchema / moveResultSchema 之前（z.array(takenItemSchema)
 *  在模块求值期就要取到该 const，提前声明避免 TDZ）。 */
export const takenItemSchema = z.object({
  batch_id: z.string(),
  part_id: z.string(),
  batch_no: z.number(),
  quantity: z.number(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  system_delivery_date: z.string().nullable(),
  planned_delivery_date: z.string().nullable(),
  is_urgent: z.boolean(),
  version: z.number(),
  // 2026-09-29 后端新增（model.rs:26-29）；serde default 兜底 false。
  has_cnc_program: z.boolean(),
});

export type TakenItemSchema = z.infer<typeof takenItemSchema>;

/** 2026-09-30 新增：`POST /api/v2/prod/pool/refill` 出参
 *  （rust RefillResult，worker_pool/model.rs:101-107）。 */
export const refillResultSchema = z.object({
  worker_id: z.string(),
  shelf_id: z.string(),
  taken: z.array(takenItemSchema),
  pool_empty: z.boolean(),
});

export type RefillResultSchema = z.infer<typeof refillResultSchema>;

/** `POST /api/v2/prod/pool/move` 请求（rust MoveRequest）—— 出入参守门。
 *  `from` / `to` 是 tagged enum：`{"kind":"POOL","shelf_id"}` /
 *  `{"kind":"WORKER","worker_id"}`。
 *
 *  2026-09-30：旧 `assign`（POOL→WORKER 单边，`{worker_id,batch_id,shelf_id,process_id?}`）
 *  与 `remove`（WORKER→POOL 单边，`{worker_id,batch_id,shelf_id,next_process_id}`）
 *  已合并为通用移动端点。`process_id` / `next_process_id` **不再是入参** ——
 *  service 从 `batch.current_process_step.process_id` 自行推导。 */
export const moveRequestSchema = z.object({
  batch_id: z.string(),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('POOL'), shelf_id: z.string() }),
    z.object({ kind: z.literal('WORKER'), worker_id: z.string() }),
  ]),
  to: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('POOL'), shelf_id: z.string() }),
    z.object({ kind: z.literal('WORKER'), worker_id: z.string() }),
  ]),
  note: z.string().optional(),
});

export type MoveRequestSchema = z.infer<typeof moveRequestSchema>;

/** `POST /api/v2/prod/pool/move` 出参（rust MoveResult，vo/worker_pool.rs:126-152）。
 *  取代旧 `AssignResult`（2026-09-14 引入，仅 POOL→WORKER）。
 *
 *  `current_held` / `max_held` / `shelf_id` / `taken` 四个字段在 rust 侧全部带
 *  `#[serde(skip_serializing_if = "Option::is_none")]` ⇒ 条件不满足时**整个字段
 *  从 JSON 中省略**（不是 null）。故 schema 用 `.nullish()`（同时接受
 *  undefined 与 null），不是 `.nullable()`。 */
export const moveResultSchema = z.object({
  batch_id: z.string(),
  from_kind: z.enum(['POOL', 'WORKER']),
  to_kind: z.enum(['POOL', 'WORKER']),
  /** 移动后 batch.current_holder_id（POOL 时=shelf_id；WORKER 时=worker_id） */
  new_holder_id: z.string(),
  /** 移动后 batch.location（"PRODUCTION_SHELF" / "WORKER"） */
  new_location: z.string(),
  version: z.number(),
  /** 仅 to_kind=WORKER 时填：目标 worker 移动后持有数（含本批次） */
  current_held: z.number().nullish(),
  /** 仅 to_kind=WORKER 时填：目标 worker 工种的 max_held_batches */
  max_held: z.number().nullish(),
  /** 仅 to_kind=POOL 时填：候选池货架 id */
  shelf_id: z.string().nullish(),
  /** 仅 POOL→WORKER 移动时填：从 pool 取出的 batch 详情 */
  taken: takenItemSchema.nullish(),
});

export type MoveResultSchema = z.infer<typeof moveResultSchema>;

/** 2026-09-30 新增：`GET /api/v2/prod/pool/state?worker_id=&shelf_id=`
 *  顶层出参（rust WorkerPoolState，worker_pool/model.rs:118-133 —— 8 字段）：
 *  worker_id / worker_name / work_type_code / max_held / current_held /
 *  capacity_remaining / pool_count_by_process[] / held_batches[]。
 *  held_batches 元素用 heldBatchItemSchema 复用（与 backend-rust HeldBatchItem
 *  严格对齐）。
 *
 *  2026-09-30 契约漂移修复：`work_type_code` 由 `.nullable()` 收紧为 `z.string()`
 *  —— 后端是 `pub work_type_code: String`（非 Option），无工种时退化为**空串**而非
 *  null（见 worker-pool.md:52「前端应展示『工种未设置』占位」）。 */
export const workerStateSchema = z.object({
  worker_id: z.string(),
  worker_name: z.string(),
  work_type_code: z.string(),
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

// ============================================================
// 2026-09-30 新增：品检待办行 + 列表 schema（守门 backend-rust
// `InspectionBatchListItemOut` / `InspectionBatchListOut`）。
//
// 字段对齐 backend-rust docs/api/parts/inspection.md 第 511 行起的
// `InspectionBatchListItemOut` 字段表：
//   - 批次字段段（t_part_batch）：batch_id / batch_no / quantity / status /
//     is_repairing / location / version / current_process_step_id / parent_batch_id
//   - holder 解析段：current_holder_id / holder_name / next_process_id /
//     next_process_name
//   - delivery_note 解析段：delivery_note_id / delivery_note_no
//   - 工单字段段（t_part）：part_id / serial_no / drawing_no / name /
//     order_no / planned_delivery_date / is_urgent / part_version /
//     created_at / updated_at
//   - 客户解析段：customer_id / customer_name / l1_customer_name
//
// status 字段后端 Rust VO 是 String 类型（端点语义锁死 'INSPECTION'），沿
// schemas 统一约定用 z.string()（与 partBatchSchema.status 同形态），不锁字面量。
// part_version（= t_part.version）必填；version（= t_part_batch.version）是 caller
// 调 API 时 OCC 锚点，两个值不同源 schema 必须显式区分。
//
// 2026-10-02 补 `is_repairing`（契约漂移修复 —「待品检」整页白屏的根因）：
//   后端 migration 005 把 `REPAIRING` 从 `PartStatus` 枚举降级为
//   `t_part_batch.is_repairing` 标记列，Rust VO `src/modules/part/vo/inspection.rs:44`
//   恒定输出 `is_repairing: bool`（**无 Option / 无 serde(default) / 无
//   skip_serializing_if** ⇒ 任何端点响应都必带该键）。本 schema 当时是
//   `.strict()` 且未声明该键 ⇒ zod 抛 `unrecognized_keys: is_repairing`；
//   zod 的数组元素校验会把一页内所有失败项汇成单个 ZodError，所以**任一行**是
//   返修批次就导致整页不可用（useInspectionList fetcher 不 catch，
//   ListShell 的 safeFetcher 又把原始 Zod 消息当空态文案渲染 + total 打成 0）。
//   ⚠️ 后端 doc（inspection.md:552-559）截至 2026-10-02 仍写「本 VO 的 3 个共用
//   端点**都不新增** is_repairing 字段」——**该段文档与 VO 源码不一致**，以
//   `vo/inspection.rs:44` 为准（doc 待后端补齐，不在本前端仓范围内）。
//   **保留 `.strict()`**：去掉它会退回「缺字段静默 strip 静默失效」这个
//   .strict() 当初要防的失败模式（仓内 CLAUDE.md 明列的 strip 陷阱）。
//
// 2026-09-30 守门（M-1 同形态）：item schema 用 `.strict()` —— 后端若误把 `id`
// 字段加进 inspection 响应（regression），Zod 立刻抛错而不是默认 strip 静默
// 丢弃（与 assemblyDetailFlatSchema 同形态 guard）。listResult schema 仍走默认
// strip（多 items 数组，每 item 各自守门）。
// ============================================================

export const inspectionBatchListItemSchema = z
  .object({
    // 批次字段段
    batch_id: z.string(),
    batch_no: z.number(),
    quantity: z.number(),
    status: z.string(),
    // 2026-10-02 契约对齐：后端 vo/inspection.rs:44 恒输出该键（REPAIRING 状态
    // 已降级为 boolean 标记列）。漏声明 ⇒ .strict() 抛 unrecognized_keys ⇒ 整页
    // 白屏。用 z.boolean() 不锁字面量 false：返修中批次本身就是 true。
    is_repairing: z.boolean(),
    location: z.string().nullable(),
    version: z.number(),
    current_process_step_id: z.string().nullable().optional(),
    parent_batch_id: z.string().nullable(),
    // holder 解析段
    current_holder_id: z.string().nullable(),
    holder_name: z.string().nullable(),
    next_process_id: z.string().nullable(),
    next_process_name: z.string().nullable(),
    // delivery_note 解析段
    delivery_note_id: z.string().nullable(),
    delivery_note_no: z.string().nullable(),
    // 工单字段段（t_part）
    part_id: z.string(),
    serial_no: z.string().nullable(),
    drawing_no: z.string(),
    name: z.string(),
    order_no: z.string().nullable(),
    planned_delivery_date: z.string(),
    is_urgent: z.boolean(),
    part_version: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    // 客户解析段
    customer_id: z.string(),
    customer_name: z.string().nullable(),
    l1_customer_name: z.string().nullable(),
  })
  .strict();

export type InspectionBatchListItemSchema = z.infer<typeof inspectionBatchListItemSchema>;

/** 品检待办列表分页结果（结构对齐 backend-rust InspectionBatchListOut）。
 *
 * 2026-09-30 review 第 1 轮修复：后端 total / limit / offset 字段用
 * `serialize_i64` 序列化为 JSON string（与雪花 ID 一致的设计），前端 schema
 * 必须按 wire-format 用 z.string() 接收；下游 useInspectionList 在边界
 * `Number(resp.total)` 转 number 才能塞进 PageResult.total。
 */
export const inspectionBatchListResultSchema = z.object({
  items: z.array(inspectionBatchListItemSchema),
  total: z.string(),
  limit: z.string(),
  offset: z.string(),
});

export type InspectionBatchListResultSchema = z.infer<typeof inspectionBatchListResultSchema>;
