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
 * 生产消费方：**仅生产统计页**（views/statistics/OverviewTab.vue）。dashboard 域
 * 已在 2026-10-07 改读 `GET /dashboard/snapshot` 的 `overdue_count`，不再消费本 schema。
 *
 * 所有非 Option 字段必填显式声明（见 CLAUDE.md「TanStack Query」的 Zod 守门条目；
 * `__tests__/schemas.spec.ts` 的 S4 系列用例是这条的回归保护），调用方通过
 * overviewOutSchema.parse(response) 在 api 边界守门。 */
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
import { ORDER_STATUSES } from '@/types/parts';

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
 * （契约见 `backend-rust/docs/api/production/processes.md`）：id / code / name /
 * category / sort_order / description / requires_approval / color / is_cnc /
 * version / created_at / updated_at（**12 字段**）。category 用 z.enum 锁死 INHOUSE /
 * OUTSOURCE；color 与 description nullable；时间戳保持 string（与 API 字符串格式
 * 对齐）。
 *
 * 2026-09-26（M-1 审计）：与 Process.ts 业务类型 + backend-rust ProcessOut 三方
 * 一致（is_cnc 落地后共 12 字段），无需补字段。
 *
 * 2026-09-29 新增：is_cnc 字段（12 字段）。CNC 编程门控：是否参与「待编程一览」
 * Tab 化（2026-10-01 起出参是 prod 域 `GET /prod/programming/pending` 的
 * `ProgrammingItem.has_cnc_program` 字段，即按 chain 中是否含 is_cnc=true 的工序
 * 派生命中；旧 part 域 `GET /parts/pending-programming` 出参
 * `PartListItem.has_cnc_program` 同语义）。沿 CLAUDE.md §M-4 strip 陷阱
 * 必填 boolean 显式声明 —— 后端漏返 Zod parse 抛错守门。
 *
 * 2026-09-30 修复：description / color 加 `.optional()` 兼容后端 skip_serializing_if。
 * 后端 `ProcessOut` 对 description 与 color 两个 `Option<String>` 字段加了
 * `#[serde(skip_serializing_if = "Option::is_none")]` —— `None` 时整个字段从 JSON 响应中
 * 省略（不是序列化为 `null`）。只写 `.nullable()` 不放宽 required 时，字段缺失会让 Zod 抛
 * `Required` error → queryFn parse 失败 → data === undefined ⇒ 整份工序列表在**所有共用
 * `useProcessesQuery` 缓存**的消费侧一起退化（表格空 / 工序 tab 消失 / 工序下拉空）。
 * `.nullable()` 与 `.optional()` 是正交维度（前者放宽类型、后者放宽 required），必须并存
 * 才能同时接受 null 与字段缺失两种形态。
 * 仍走 `listProcesses` 裸调、**不**经 Zod 的视图（RepairStartDialog / ShelfList /
 * OutsourceQuoteList / OutsourceList / ProcessPickerDialog）
 * 不受本 schema 变更影响。 */
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
  // 2026-10-07：状态字面量改为引用 types/parts.ts 的 ORDER_STATUSES（单一来源），
  // 取舍登记见该常量注释。
  status: z.enum(ORDER_STATUSES),
  order_no: z.string().nullable(),
  system_delivery_date: z.string().nullable(),
  // 2026-10-03：已送数量。复用同一 VO 的 7 个端点里只有 com/union-list 与
  // GET /parts 填（装配件行也填，语义是已送「套数」，公式与两条边界见
  // types/parts.ts::PartListItem.delivered_quantity），其余 5 个端点恒 null ⇒ 必须
  // nullable + optional（不能改成必填，否则那 5 个端点的响应 parse 当场抛错）。
  delivered_quantity: z.number().nullable().optional(),
  note: z.string().nullable(),
  customer_name: z.string().nullable(),
  l1_customer_name: z.string().nullable(),
  location: z.string().nullable(),
  holder_name: z.string().nullable().optional(),
  process_chain_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  /** 2026-10-03 后端新增：批次 OCC 版本（t_part_batch.version），与上面的 batch_id 同源。
   *
   *  **本 schema 不服务扫码台。** 它的生产消费方是 `partListResultSchema`（下方）→
   *  `usePartsListQuery`（零件一览，`GET /com/union-list`）。这些行的单位是
   *  part、后端**刻意不填**批次锚点（一个 part 的活跃批次可能不止一个，填任一都是
   *  错锚点）⇒ batch_id / batch_version 在本 schema 上**恒为 null**（后端 VO 无
   *  `skip_serializing_if`，键在、值为 null，不是 undefined）。保留声明只为类型与
   *  后端 VO 对齐，不承担任何扫码台职责。
   *
   *  ⚠️ 已知不对称：本 VO 同样恒返两键（`PartListItem` 的两个字段也都没有
   *  `skip_serializing_if`），按
   *  `src/views/cnc/composables/pendingProgrammingSchema.ts::pendingProgrammingItemSchema`
   *  的同款理由本该
   *  也声明成必填 + 可空。**当前未改**：改必填会让 `schemas.spec.ts` /
   *  `usePartsListStore.spec.ts` 等共用 fixture 的用例变红，fixture 是跨 spec 共享
   *  对象，改动面超出注释订正的合理半径。补齐留待单独一轮。
   *
   *  这个失守的**症状边界要说清**（别误读成「无读点」）：`batch_id` 在本 schema 上
   *  **有**前端读点 —— `usePartDispatch.ts:353`（批量下发的 targets）与 `:421`
   *  （单件召回）读 union-list 行的 `batch_id`。但后端刻意不填 ⇒ 读到的**恒为
   *  null** ⇒ 这两处恒走 `PLACE_ON_SHELF_NO_BATCH_HINT` / `RECALL_NO_BATCH_HINT`
   *  显式报错分支（2026-10-02 登记的已知缺口，见 usePartDispatch 文件头）。所以
   *  缺键与否**不改变运行时行为**，`.optional()` 真正丢掉的是「后端删键时报错」
   *  这一层契约守门（区别于
   *  src/views/cnc/composables/pendingProgrammingSchema.ts::pendingProgrammingItemSchema：
   *  那边的读点是**按钮可用性判据**，缺键会静默让全表下发按钮恒 disabled，是真症状）。
   *
   *  扫码台 PICK_UP 的数据源 `listPartsByWorkTypeAllShelves` **不过本 schema**：它的行
   *  由后端填了批次锚点，走本文件末尾的 `scanPartRowSchema`（那边 `batch_id` /
   *  `batch_version` 是必填 + 可空）。两条路径的改名义务都登记在
   *  `src/api/parts/crud.ts` 的 `PartItem.batch_id` / `batch_version` 注释上，
   *  本条注释只描述本 schema 的取值现状。 */
  batch_version: z.number().nullable().optional(),
  batch_no: z.number().nullable().optional(),
  batch_quantity: z.number().nullable().optional(),
  // 2026-09-28 修复：兼容不返 row_type 的端点（后端 modules/part/service/crud.rs::list_parts 真正合并后，GET /parts 始终返 'PART' | 'ASSEMBLY'；但工艺制定等旧端点仍可能缺该字段）。2026-10-01 备注：唯一曾缺该字段的 pending-programming 端点已下线（「待编程一览」数据源迁到 prod 域 GET /prod/programming/pending，其出参走 src/views/cnc/composables/pendingProgrammingSchema.ts 的独立 schema，不复用 partSchema），本 default 保留兼容其余历史端点。
  row_type: z.enum(['PART', 'ASSEMBLY']).default('PART'),
  // 2026-10-05 新增：所属装配件 id（雪花 ID 字符串）。`GET /com/union-list` 的
  // PART / PART_FLAT 段恒返该键：t_part 行的值 = 父装配件 id，独立零件行为 null
  // （后端 VO 无 skip_serializing_if，键在、值为 null，不是 undefined）。与 batch_id
  // 同理**必须显式声明** —— zod 默认 strip 会静默丢弃它，让后续消费者（装配件子件
  // 归组等）以为「所有行都没有父装配件」。声明成 nullable + optional：复用同一 VO
  // 的其余端点（GET /parts 家族）不填该列。声明只为不让后续消费者踩 strip 坑。
  assembly_id: z.string().nullable().optional(),
  has_children: z.boolean().optional(),
  child_count: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
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

/** part-file 列表分页结果。
 *
 * limit / offset 声明成 optional 的原因（后端契约对齐）：backend-rust
 * `src/modules/part_file/vo/part_file.rs:58-62` 的 `PartFileListOut` 真契约只返回
 * `items` + `total` 2 字段，没有 limit/offset。
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

/** 装配件文件出参数组。
 *
 * 后端 uploadAssemblyPdf（POST /api/v2/assemblies/{id}/files）实际响应是
 * `R<Vec<AssemblyFileRef>>`（数组），不是 `R<AssemblyDetail>`。前端旧 bug
 * 走 parseAssemblyDetail 把数组塞进 z.object → ZodError。本 schema 锁死数组形态，
 * 让 mapper（api/assembly.ts::uploadAssemblyPdf）在 api 边界守门。 */
export const assemblyFileRefSchemaArray = z.array(assemblyFileRefSchema);

/** 装配件创建响应（`POST /api/v2/assemblies` 的 201 body）：顶层实体 + 刚建出的子件。
 *
 * 2026-10-05 补：此前 `createAssembly` 只做类型断言、无守门，而建单结果直接决定
 * 「哪些本地行算已建出」（`usePartBatchPdf` 的 createdTargets 记账）⇒ 响应形状不对时
 * 会在**没有任何报错**的情况下把子件挂错行 / 记不上账。守门与 `uploadAssemblyPdf` /
 * `getAssembly` 同款（api 边界 parse）。
 *
 * 外层 `.strict()`：本域已经吃过一次键名回归的亏（`AssemblyCreateResult` 的子件键是
 * `created_children`，而 `AssemblyDetail` 那边叫 `children`）。两个键名同时存在或被
 * 改名时，parse 立刻抛错，而不是让 `.map(c => c.id)` 静默跑出空数组。
 * 内层沿用 `assemblyOutSchema` / `assemblyChildOutSchema`（非 strict，额外字段 strip）。 */
export const assemblyCreateResultSchema = z
  .object({
    assembly: assemblyOutSchema,
    created_children: z.array(assemblyChildOutSchema),
  })
  .strict();

export type AssemblyCreateResultSchema = z.infer<typeof assemblyCreateResultSchema>;

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
// 2026-09-30 新增：返修集合读行 + 列表 schema（守门 backend-rust
// `InspectionBatchListItemOut` / `InspectionBatchListOut`）。
//
// 本 schema 组的消费者是**仅** `GET /prod/batches/repair` 与 `GET /prod/batches/repairing`
// 两条返修端点；待品检队列（`GET /prod/inspection/queue`）用 13 字段精简 VO，schema 在域内
// `src/views/inspection/composables/inspectionSchema.ts::inspectionQueueListItemSchema`。
//
// 字段对齐后端 VO `InspectionBatchListItemOut` / `InspectionBatchListOut`：
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
// status 字段后端 Rust VO 是 String 类型（repair 端点语义锁死 'DELIVERED'、
// repairing 端点恒为 'IN_PROCESS'，见 backend-rust docs/api/parts/lifecycle.md），
// 沿 schemas 统一约定用 z.string()（与 partBatchSchema.status 同形态），不锁字面量。
// part_version（= t_part.version）必填；version（= t_part_batch.version）是 caller
// 调 API 时 OCC 锚点，两个值不同源 schema 必须显式区分。
//
// is_repairing 必填显式声明（契约漂移的历史教训）：后端 migration 005 把 `REPAIRING`
//   从 `PartStatus` 枚举降级为 `t_part_batch.is_repairing` 标记列，Rust VO
//   恒定输出该键（**无 Option / 无 serde(default) / 无 skip_serializing_if**）。
//   本 schema 是 `.strict()` 且当时漏声明该键 ⇒ zod 抛 `unrecognized_keys:
//   is_repairing`；zod 的数组元素校验会把一页内所有失败项汇成单个 ZodError，
//   所以**任一行**是返修批次就导致整页不可用。**保留 `.strict()`**：去掉它会退回
//   「缺字段静默 strip ⇒ 校验形同虚设」这个 .strict() 当初要防的失败模式
//   （仓内 CLAUDE.md 明列的 strip 陷阱）。
//
// 2026-09-30 守门（M-1 同形态）：item schema 用 `.strict()` —— 后端若误把 `id`
// 字段加进返修响应（regression），Zod 立刻抛错而不是默认 strip 静默丢弃（与
// assemblyDetailFlatSchema 同形态 guard）。listResult schema 仍走默认 strip
// （多 items 数组，每 item 各自守门）。
// ============================================================

export const repairBatchListItemSchema = z
  .object({
    // 批次字段段
    batch_id: z.string(),
    batch_no: z.number(),
    quantity: z.number(),
    status: z.string(),
    // REPAIRING 状态已降级为 boolean 标记列（migration 005），后端 VO 恒输出该键。
    // 漏声明 ⇒ .strict() 抛 unrecognized_keys ⇒ 整页白屏。用 z.boolean() 不锁字面量
    // false：返修中批次本身就是 true。
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

export type RepairBatchListItemSchema = z.infer<typeof repairBatchListItemSchema>;

/** 返修集合读分页结果（结构对齐 backend-rust InspectionBatchListOut）。
 *
 * 后端 total / limit / offset 用 `serialize_i64` 序列化为 JSON string（与雪花 ID
 * 一致的设计），前端 schema 必须按 wire-format 用 z.string() 接收；消费方
 * （`src/views/repair/RepairReceive.vue`）在边界 `Number(resp.total)` 转 number
 * 才能塞进分页组件的 total。
 */
export const repairBatchListResultSchema = z.object({
  items: z.array(repairBatchListItemSchema),
  total: z.string(),
  limit: z.string(),
  offset: z.string(),
});

export type RepairBatchListResultSchema = z.infer<typeof repairBatchListResultSchema>;

// ============================================================
// 2026-10-02 新增：工种 + 工种↔工序映射 schema（守门 backend-rust
// `WorkTypeOut` / `WorkTypeListOut` / `WorkTypeProcessMappingItem` /
// `WorkTypeProcessMappingOut`）。
//
// 契约依据：
//   - backend-rust `src/modules/prod/work_type/vo/work_type.rs`（WorkTypeOut /
//     WorkTypeListOut）；
//   - backend-rust `src/modules/prod/work_type/vo/process_mapping.rs`
//     （WorkTypeProcessMappingItem / WorkTypeProcessMappingOut）；
//   - 契约文档 `docs/api/production/work-type-process-mapping.md`（映射两个端点）
//     与 `docs/api/production/work-types.md`（工种 CRUD）。
//
// 为什么现在才加守门：ProcessWorkTypeMappingTab.vue 此前**零 schema、零 queryKey**
// 直接裸调 listWorkTypes / getWorkTypeProcesses，于是 v1 影子类型
// （`WorkTypeWithProcesses.processes`）的错误读法与错误 payload 都能编译通过并
// 上线 —— 线上症状是「点工种报 undefined.map」+「保存发 {process_ids} 静默清空
// 整组映射」。本次把「响应形态」与「请求形态」两侧都钉死。
//
// ⚠️ 陷阱对照（写这个域时容易照抄错）：`WorkTypeListOut.total` / `limit` /
// `offset` 在 Rust 里是**裸 `i64`，没有 `#[serde(serialize_with = "serialize_i64")]`**
// ⇒ wire 形态是 **JSON number**，必须用 `z.number()`。这与
// `repairBatchListResultSchema`（那边**有** serialize_i64 ⇒ 必须 `z.string()`）
// **方向相反**，不要照抄那一个。
// ============================================================

/** 工种条目（对齐 backend-rust `WorkTypeOut` **10 字段**，**全部显式声明**）。
 *
 * 逐条依据 `vo/work_type.rs`：
 *   - id：i64 + `serialize_i64` ⇒ JSON string（雪花 ID 不可用 JS Number，会丢精度）；
 *   - code / name：String；
 *   - description：Option<String>，**无** skip_serializing_if ⇒ 键恒在，null 即空；
 *   - sort_order：i32（数字）；
 *   - max_held_batches：Option<i32>（null = 不限）；
 *   - process_ids：Vec<String>（该工种已映射的工序 id，**已映射**的字符串数组，
 *     空数组 = 未映射任何工序）。由 service 层用单条 SQL 批量补全（防 N+1），
 *     list / detail 两个端点都带。**显式声明是必须的**：Zod 默认 strip 模式下漏声明
 *     ⇒ 静默丢弃（本域此前就在 @/types/workType.ts 漏了它，types 与 VO 不同步）。
 *   - version：i32（乐观锁）；
 *   - created_at / updated_at：NaiveDateTime ⇒ JSON string。
 *
 * 不加 `.strict()`：与 partBatchSchema / customerSchema 等列表行 schema 同策略 ——
 * 行级 .strict() 会在后端加**任何一个**新字段时把整表打挂（inspection 域
 * `is_repairing` 事故就是这个形状），而本域的写点全在本仓内、契约漂移由本注释 +
 * 单测守着。
 */
export const workTypeSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: z.number(),
  max_held_batches: z.number().nullable(),
  process_ids: z.array(z.string()),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WorkTypeSchema = z.infer<typeof workTypeSchema>;

/** 工种列表分页结果（对齐 backend-rust `WorkTypeListOut`）。
 *  ⚠️ total / limit / offset 是**裸 i64**（无 serialize_i64）⇒ `z.number()`，
 *  与 repairBatchListResultSchema 的 `z.string()` 方向相反，见文件头警告。 */
export const workTypeListResultSchema = z.object({
  items: z.array(workTypeSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type WorkTypeListResultSchema = z.infer<typeof workTypeListResultSchema>;

/** 工种↔工序映射行（对齐 backend-rust `WorkTypeProcessMappingItem`）。
 *  4 字段**全必填**：
 *   - work_type_id：i64 + serialize_i64 ⇒ JSON string；
 *   - process_id：i64 + serialize_i64 ⇒ JSON string；
 *   - process_code：String，JOIN t_process 取；
 *   - sort_order：i32（非空；后端 SQL `ORDER BY sp.sort_order ASC, sp.id ASC`）。
 *
 * 不声明 `process_name`：后端不返该键（旧 `WorkTypeProcessLink.process_name` 是
 * v1 影子字段）。 */
export const workTypeProcessMappingItemSchema = z.object({
  work_type_id: z.string(),
  process_id: z.string(),
  process_code: z.string(),
  sort_order: z.number(),
});

export type WorkTypeProcessMappingItemSchema = z.infer<typeof workTypeProcessMappingItemSchema>;

/** `GET /prod/work-types/{id}/processes` 的响应（对齐 `WorkTypeProcessMappingOut`）。
 *  **只有 `items` 一个键，无分页信封** —— 该端点不接 limit/offset，一次返全部。
 *  （读形态的还原逻辑收口在 `toWorkTypeProcessIds`，见 src/api/workType.ts。） */
export const workTypeProcessesResultSchema = z.object({
  items: z.array(workTypeProcessMappingItemSchema),
});

export type WorkTypeProcessesResultSchema = z.infer<typeof workTypeProcessesResultSchema>;

// ============================================================
// 2026-10-03 新增：外协域的 Zod 守门 schema。
//
// 为什么最初补这一段：外协域此前是全仓少数**没有** Zod 守门的模块 —— api helper 把
// `api.get` 的结果原样喂给 `el-table`，形状不符时收不到数组就**静默空白**而不是报错。
// 3 个线上故障都是这么悄悄上线的（对账页 404、quotable-parts 400、收发两 tab 全空白）。
//
// 共同的 strip 陷阱约定（沿 CLAUDE.md §M-4）：每个 item schema **逐字段显式声明**，
// 一条不漏。Zod 默认 `z.object()` 是 strip 模式，漏声明的字段会被静默丢弃、parse
// 不报错 —— 守门形同虚设。雪花 id 一律 `z.string()`（后端 `serialize_i64`），
// 不用 `z.coerce.string()` / `z.number()` 掩盖类型漂移；Decimal 一律 `z.string()`；
// datetime 一律 `z.string()`。
//
// 2026-10-09 归位：对账列表（`sent-parts`）与公司选项两个 schema 迁到域内
// `views/outsource/composables/outsourceListSchema.ts`（与三个 query hook 同居）。
// 理由：它们只被本域自己的 query hook 消费，守门点也在 queryFn，本文件是
// 「跨域共享基础数据」的 schema 集，留着会让同一条契约出现两个真相源。
// 本段**只剩** `quotable-parts` 一个端点 —— 它是外协域唯一守门留在 api 层的读端点：
// 由报价一览 shell 的 `loadLookups()` 裸调，没有 queryFn 承载（CLAUDE.md：
// 守门留在 api 层的只允许「没有 queryFn 承载」的调用）。
// ============================================================

/** `GET /api/v2/outsource-quotes/quotable-parts` 单行（后端 `QuotablePart`）—— 10 字段。
 *
 *  ⚠️ 行粒度 = **一个零件一行**，筛选条件是「有活跃 `status='PENDING'` 批次的零件」
 *  （报价是给还没下发的在制件提前锁价），不再按 OUTSOURCE 工序货架展开，故 VO 删掉
 *  `shelf_id` / `shelf_code` / `next_process_id` / `next_process_name`。
 *  ⚠️ 正因为不再携带工序，picker 侧**没有**「选中零件 → 自动填工序」这条数据通路，
 *  新建报价的工序必须由操作员在独立的工序下拉里选。 */
export const quotablePartSchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  name: z.string(),
  is_urgent: z.boolean(),
  /** Decimal 字符串（客户下单单价） */
  unit_price: z.string(),
  customer_id: z.string(),
  customer_name: z.string().nullable(),
  l1_customer_name: z.string().nullable(),
  customer_path: z.string().nullable(),
});

export type QuotablePartSchema = z.infer<typeof quotablePartSchema>;

/** `GET /api/v2/outsource-quotes/quotable-parts` 顶层（后端 `QuotablePartListOut`）。
 *  ⚠️ 2026-10-03 起是**分页信封**，不再是裸数组 —— 报价一览页的 picker 恒空故障
 *  （端点不存在 ⇒ 请求被 `quote_router` 的 `/{id}` 吞成 400）就是拿信封当数组用的直接后果。 */
export const outsourceQuotablePartListResultSchema = z.object({
  items: z.array(quotablePartSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type OutsourceQuotablePartListResultSchema = z.infer<
  typeof outsourceQuotablePartListResultSchema
>;

// ============================================================
// 2026-10-04 新增：报工台三页（取件 / 放回 / 送检）列表行的 Zod 守门 schema。
//
// 这两个端点返回的是**分页信封**（`items` / `total` / `limit` / `offset`），
// **不是裸数组**：后端 handler 签名是 `Result<Json<R<PartListOut>>, AppError>`，
// `PartListOut` 定义在 backend-rust `src/modules/part/vo/part.rs`。
// 把信封当数组消费（`parts.value = await listX()` 然后 `parts.length`）会连锁炸三处：
//   1. `parts.value` 变成对象，`{{ parts.length }}` 渲染成 undefined（计数恒空）；
//   2. `src/views/scan/composables/useScanPartsSort.ts` 里的 `[...list].sort()` 抛
//      `TypeError: list is not iterable` —— 抛点在 computed 内，模板
//      `v-for="p in sortedParts"` 随之渲染失败，**取件 / 放回 / 送检三页同时白屏**；
//   3. `HeldPartsBadge.vue` 的 `v-for="p in parts"` 迭代对象值，同样坏。
// 本 schema 存在的理由就是把这个形状钉死：形状不符立即抛 ZodError，而不是静默空屏。
//
// 行 VO = `PartListItem`（**不是** `PartDetailOut`）。字段清单逐条镜像
// backend-rust `src/modules/part/vo/part.rs` 的 `pub struct PartListItem`：
//   - 全部字段声明为**必填**，可空的一律 `.nullable()`：该 VO 的字段没有挂
//     `skip_serializing_if`（`#[serde(default)]` 只影响反序列化），键恒在。写成
//     `.optional()` 会让「后端漏发字段」静默通过（Zod 默认 strip 模式）——
//     这正是 §M-4 strip 陷阱要求必填显式声明的原因。
//   - 雪花 id 一律 `z.string()`（后端 `serialize_i64` / `serialize_i64_opt` → JSON
//     string），禁止 `z.number()` / `Number()`（会丢精度）。
//   - `unit_price` / `total_price` 是 `z.string()`：后端 `rust_decimal::Decimal` +
//     `serde-with-str`，不锁字面量形态。
//   - **不声明** `next_process_id`（后端列表刻意不给，见 VO 内该字段的注释）、
//     `customer_path` / `shelf_code` / `next_process_name` / `last_inspection_fail_note` /
//     `current_holder_*` / `worker_name` / `outsource_company_name` —— VO 里根本没有这些键。
//   - **不声明** `batch_no` / `batch_label`（2026-10-04 补登记）：后端 `PartListItem`
//     没有这两个键（2026-10-04 采集的报工台响应样本里同样没有；样本里哪部分是实测转录、
//     哪部分是按契约手写，见 `src/api/parts/__tests__/scan-list.contract.spec.ts` 的 W 组
//     说明），所以 `BatchPickerDialog` 模板的 `v-for="b in sortedRows"` 行内
//     `批次{{ b.batch_no ?? 1 }}` 对报工台三域恒显「批次 1」、`sortedRows` 的批次号升序
//     对这三域是恒等操作。
//     ⚠️ 这**不是「后端 VO 一贯如此」**：另两域的行 VO 都有批次号
//     （`DeliveryNoteCandidatePart.batch_no` / `InspectionQueueItem.batch_no`），
//     报工台是唯一缺的。**要显示批次号必须后端先给 `PartListItem` 补字段**；补了之后
//     本 schema 不改，键仍会被 strip 掉、UI 仍不显示 —— 这是「不声明」清单的登记意义。
//   - `location` 必须显式声明（`z.string().nullable()`）：`BatchPickerDialog.holderText`
//     的判据是「键在不在」(`'location' in p`)，Zod strip 会把未声明的键删掉 ⇒
//     报工台卡片静默少掉 holder 那一行。
//   - `planned_delivery_date` / `request_date` 用字段级 transform 把后端占位符
//     `'1970-01-01'` 归一成 `null`（见下方两个字段的注释）。
//   - `chain_state` / `chain_next_process_id` / `chain_next_process_name` /
//     `chain_current_process_name` 是**工序链派生四件套**，报工台两个端点都填
//     （见各字段处的注释）；放回页的放回分流只读它们。四件套按「带默认值的必输出键」
//     声明（缺键降级而非抛错），理由见字段注释。
//
// ⚠️ 与同文件 `partSchema` 的分工：`partSchema` 服务 `GET /com/union-list` 等
// part 级行（后端刻意不填批次锚点）；本 schema 服务报工台两个端点，两者的行单位都是
// 批次、`batch_id` / `batch_version` 都有值。两者不可互换。
// ============================================================

/**
 * 2026-10-04：报工台三页的列表行（后端 `PartListItem`，38 字段全声明）。
 *
 * 它是**分页信封里的 items 元素**（外层见 `scanPartListResultSchema`），不是裸数组：
 * 把信封当数组消费时 `parts.length` 恒 undefined，`useScanPartsSort` 的 `[...list]`
 * 抛 `TypeError: list is not iterable`（抛点在 computed 内）⇒ 取件 / 放回 / 送检
 * 三页的 `v-for` 同时渲染失败。
 */
export const scanPartRowSchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  /** 报工台两个端点的 service 把该字段写死空串（取行 SQL 不投影申请人） */
  applicant_name: z.string(),
  quantity: z.number(),
  /**
   * 2026-10-04：后端 service 构造行时把 `request_date` 硬编码成 `1970-01-01`
   * （占位，取行 SQL 不投影该列）。归一成 `null`，避免这个哨兵值被下游当成
   * 「1970 年下单」的真日期消费。只在**恰好等于** `'1970-01-01'` 时归一，
   * 其它日期字符串原样透传（后端将来补上真投影就自动恢复）。
   */
  request_date: z
    .string()
    .transform((v) => (v === '1970-01-01' ? null : v))
    .nullable(),
  /**
   * 2026-10-04：同上，`planned_delivery_date` 恒为占位符 `1970-01-01`。归一成
   * `null` 的直接收益：报工台三页的 `DeliveryDateChip` 不再显示
   * 「01/01 · 已逾期 2 万多天」的红色错值（`formatDeliveryDate` / `deliveryUrgencyClass`
   * 拿到 null 后返空串 / 空 class）。2026-10-04 起 chip 在三页**恒渲染**、无值时日期位
   * 显示 `-`，空外壳这件事由组件自己保证，不再由调用方加 `v-if`（见
   * `views/scan/components/DeliveryDateChip.vue`）。
   */
  planned_delivery_date: z
    .string()
    .transform((v) => (v === '1970-01-01' ? null : v))
    .nullable(),
  /** ⚠️ 报工台两个 service 写死 0（占位）；声明成 string 是因为 wire 上是雪花 ID 字符串 */
  customer_id: z.string(),
  assembly_id: z.string().nullable(),
  /** ⚠️ 两个 service 写死 `'IN_PROCESS'`；用 `z.string()` 不锁字面量（同 partBatchSchema 约定） */
  status: z.string(),
  /** ⚠️ 两个 service 写死 false（取行 SQL 不投影该列）；保留字段，将来后端补投影即自动生效 */
  is_urgent: z.boolean(),
  order_no: z.string().nullable(),
  /** 两个 service 写死 None */
  system_delivery_date: z.string().nullable(),
  note: z.string().nullable(),
  /** Decimal 字符串；报工台两个 service 写死 `"0"` */
  unit_price: z.string(),
  /** Decimal 字符串；同上 */
  total_price: z.string(),
  /**
   * ⚠️ **part 级** `t_part.version`，不是批次 OCC 版本；报工台两个 service 写死 0
   * （取行 SQL 不投影 `p.version`）。批次乐观锁只认下面的 `batch_version`。
   */
  version: z.number(),
  /** 两个 service 写死 epoch（`from_timestamp_opt(0, 0)`） */
  created_at: z.string(),
  created_by: z.string().nullable(),
  updated_at: z.string(),
  updated_by: z.string().nullable(),
  deleted_at: z.string().nullable(),
  /**
   * 2026-10-04：取件端点（`pickable-by-work-type`）的取行 SQL 不投影该列，恒为 null；
   * 放回端点（`by-worker`）会投影 `t_part.process_chain_id` —— 工序链四件套正是后端沿
   * 它解析链后派生的，未制定工序时为 null。
   * 行级的**链位置**语义一律读下面 `chain_state` 四件套，不要直接用本字段判「是不是最后
   * 一道」：本字段只回答「这个件有没有链」，不回答「链上的下一步是谁」。
   */
  process_chain_id: z.string().nullable(),
  /**
   * 2026-10-04 工序链派生四件套（后端 service 沿 `t_part_process` 链解析后派生，
   * **前端不推导链位置**，也不自己判「是不是最后一道」）：
   *
   * - `chain_state` 三值：
   *     `'NONE'` = 无链 / 链已软删 / 当前工序不在链内（指针漂移）；
   *     `'NEXT'` = 当前工序在链内且**有下一道**；
   *     `'TAIL'` = 当前工序是链内**最后一道**。
   *   放回页据此分流：`NEXT` 免去工序选择 + 货架点选（直接单确认），`TAIL` 在工序选择
   *   弹窗内常驻提示「加工完成后请送检」再让工人手选，`NONE` 走原三步路径。
   * - `chain_next_process_id`：**非可空字符串**（雪花 id 经 serialize_i64 → JSON
   *   string）。`'0'` 是 `NONE` / `TAIL` 的兜底值、**不是**真 id —— 消费侧见到 `'0'`
   *   必须短路，不发给 `/shelves/for-return`（发过去必得空列表，白跑一趟）。
   * - `chain_next_process_name`：`NEXT` 时为下一道工序名，`NONE` / `TAIL` 恒 null。
   * - `chain_current_process_name`：当前工序名，解析不出时为 null（`TAIL` 分支用它
   *   点名「该去送检的是哪一道」，无值时退通用文案）。
   *
   * ⚠️ **四件套一律声明成「带默认值的必输出键」，缺键降级而不抛**（本仓同题先例：
   * `src/types/shelf.ts::ShelfForInspection.current_load` 处理「两仓并行、后端可能
   * 尚未上线」用的就是这条路 —— 声明成可选 + 消费侧守卫，注释写明「后端补不补都不会
   * 渲染出坏值」）。取舍理由是**失败模式的严重性不对称**：
   *   · 声明成必填（`z.enum` / 非空 `z.string`）时，后端先上线就是
   *     `scanPartListResultSchema.parse()` 在 API 边界抛错 ⇒ `listPartsHeldByWorker` /
   *     `listPartsByWorkTypeAllShelves` 全部 reject ⇒ 取件 / 放回 / 送检三页列表空 +
   *     `HeldPartsBadge` 抽屉空 = **报工台整体停工**；而后端将来新增第四个 chain_state
   *     取值（哪怕只是加个 `'SKIP'`）是**纯后端单方面改动**就能触发的同类事故。
   *   · 降级后的失败只是「链提示不弹，工人多点两下选工序」—— NONE 旧路径依然正确，
   *     仅 UX 降级。HMI 场景必须选后者。
   *
   * `chain_state` 声明成 `z.string().nullish()`（不是 `z.enum`、也不是 `.default('NONE')`）：
   *   · 不锁枚举 ⇒ 后端加取值只是降级，不会让报工台停工；
   *   · 不用 `.default('NONE')` ⇒ 保留「键缺失 ⇒ undefined」这个信号。若用 default，
   *     「后端漏发」与「后端真返 NONE」被抹平成同一个值，缺可观测性（下面的一次性
   *     `console.warn` 就再也发不出来）。消费侧（放回页 `enterReturnFlow`）统一窄化：
   *     `'NEXT'` / `'TAIL'` 走链分支，其余（含 undefined / null / 未知字面量）一律按
   *     `'NONE'` 处理并 `console.warn` 一次。
   * 另外三个键的默认值对齐后端的兜底口径（`'0'` / null），让消费侧的「不是真 id 就
   * 短路」判据在漏发时同样成立。
   */
  chain_state: z.string().nullish(),
  chain_next_process_id: z.string().default('0'),
  chain_next_process_name: z.string().nullable().default(null),
  chain_current_process_name: z.string().nullable().default(null),
  customer_name: z.string().nullable(),
  l1_customer_name: z.string().nullable(),
  /**
   * 必填 + 可空（不是 `.optional()`）：`PartListItem.location` 没挂
   * `skip_serializing_if` ⇒ 键恒在。`BatchPickerDialog.holderText` 用
   * `'location' in p` 判「这个 VO 有没有 holder 信息」，strip 掉该键会让报工台
   * 卡片静默少一行。值仍恒为 null（这两个 service 不做 batch enrichment）。
   */
  location: z.string().nullable(),
  /** 派生持有人名；这两个 service 不 enrich ⇒ 恒 null */
  holder_name: z.string().nullable(),
  /** `From<TPart>` 派生为 `Some("PART")`；显式声明避免被 strip 掉影响行类型判别 */
  row_type: z.string().nullable(),
  has_children: z.boolean(),
  child_count: z.number().nullable(),
  has_cnc_program: z.boolean(),
  /**
   * 批次雪花 id（`serialize_i64_opt` → JSON string）。**报工台两个端点都填**：
   * `GET /parts/pickable-by-work-type/{work_type_id}` 用它发
   * `POST /prod/batches/{batch_id}/pick-up` 的路径参数 + OCC 锚；
   * `GET /parts/by-worker/{worker_id}` 用它做放回 / 送检的批次锚（worker-scan 的
   * `batch_id` 入参，见 ScanReturnParts.submitReturn）。其余复用本 VO 的端点仍恒 null。
   *
   * 声明成**必填 + 可空**（不是 `.optional()`）：该字段无 `skip_serializing_if`
   * ⇒ 键恒在。写成 `.optional()` 会让「后端某天删掉这两个键」静默通过，取件时
   * 才在 `ScanPickParts` 的批次锚点守卫上炸出一句与真因不匹配的提示。
   */
  batch_id: z.string().nullable(),
  /**
   * 批次乐观锁版本号（`t_part_batch.version`），作 pick-up 的 `version` 入参。
   * 报工台两个端点都填；必填理由与改名义务同 `batch_id`。
   */
  batch_version: z.number().nullable(),
});

export type ScanPartRowSchema = z.infer<typeof scanPartRowSchema>;

/**
 * 2026-10-04：报工台两个列表端点（`GET /parts/pickable-by-work-type/{work_type_id}`、
 * `GET /parts/by-worker/{worker_id}`）的出参 —— **分页信封，不是裸数组**（后端
 * `PartListOut`，`envelopeResponseInterceptor` 之后 `resp.data` 就是这个对象）。
 *
 * 消费形态：调用方必须取 `.items` 当数组用。把信封当数组用的症状是
 * `parts.length` 恒 undefined（计数恒空）+ `useScanPartsSort` 的 `[...list]` 抛
 * `TypeError: list is not iterable` ⇒ 报工台三页（取件 / 放回 / 送检）渲染全崩。
 *
 * ⚠️ `total` / `limit` / `offset` 是裸 i64 ⇒ JSON **number**（后端 2026-09-27
 * part 域对齐时改的，与 `repairBatchListResultSchema` 的 string 计数方向相反）。
 *
 * 后端两个 service 都是 `limit.unwrap_or(50).clamp(1, 200)`：不传 limit 时**默认只返
 * 50 条**，而调用方若把它当「全部」就会静默截断。报工台三页 + HeldPartsBadge 统一
 * 显式传 `limit: 200`（clamp 上限）取全。
 */
export const scanPartListResultSchema = z.object({
  items: z.array(scanPartRowSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type ScanPartListResultSchema = z.infer<typeof scanPartListResultSchema>;

// ============================================================
// 2026-10-05 新增：「制定工序」页零件列表（`GET /api/v2/prod/process-design/parts`）的
// Zod 守门 schema。契约见 backend-rust `docs/api/production/process-design.md`。
//
// 为什么是独立端点 / 独立 VO：此前本页读 part 域 `GET /api/v2/parts?status=PENDING`，
// 而该端点在 repo SQL 里硬置 `AND assembly_id IS NULL`（part 域口径是「装配件子件
// 由 service 内存合并、不独立成行」），把**装配件的子零件全部排除** —— 而子件同样
// 需要定工序。本页只做「选零件 → 定工序」，展示信息够用即可，故端点把字段集收窄到
// 7 个（part 域 PartListOut 有 20 余个：客户 / 交期 / 数量 / 价格 / 状态 …）。
//
// 两条序列化约定（与本文件既有行 VO 逐字一致，方向**相反**别看错）：
//   - 雪花 ID（`id` / `process_chain_id` / `assembly_id`）是 `serialize_i64` /
//     `serialize_i64_opt` ⇒ JSON **string**，声明 `z.string()`（禁 `z.number()`，
//     19 位 ID 在 JS Number 下会丢精度）；
//   - 分页计数（`total` / `limit` / `offset`）是**裸 i64** ⇒ JSON **number**
//     （与 inspection 域的 string 计数方向相反）。
//
// 必填字段**逐个显式声明**（Zod strip 陷阱，见 CLAUDE.md「TanStack Query」条目）：
// 7 个行字段 + 3 个计数字段全部显式写出；后端 VO 的这 7 列都没有挂
// `skip_serializing_if` ⇒ 键恒在（可空的一律 `.nullable()` 而非 `.optional()`，
// 写成 `.optional()` 会让「后端漏发 assembly_id」静默通过，UI 的子件标记就整列失效）。
// ============================================================

/** 2026-10-05：「制定工序」页零件行（后端 `ProcessDesignPartItemOut`）—— 7 字段。 */
export const processDesignPartSchema = z.object({
  /** `t_part.id`（`serialize_i64` → JSON string）。全链路按 string 用，禁止 `Number()` */
  id: z.string(),
  /**
   * ⚠️ **`t_part.version`**，与 `t_part_process_chain.version`（工艺链自己的乐观锁）
   * 是**两个独立计数器**，互不相干。
   *
   * 本页保存工艺链走 `POST /prod/process-chains/by-part/{part_id}`，其请求体里的
   * OCC 锚是 `ProcessChainOut.version`（**链自己的**版本号，由 upsert 响应带回），
   * **绝不是**本字段。**严禁**把 `part.version` 塞进那个请求体 —— 两者取值互不相关，
   * 混用会打出莫名其妙的 409 冲突。
   *
   * 本字段**当前无消费方**：本页不在列表上改零件。保留它是因为它是 `t_part` 的
   * 一列（非领域概念），后端 VO 明确带上，预留给将来「在本页改零件」时做 OCC 回传；
   * 显式声明同时能守住「后端哪天不投影这一列」的契约漂移。
   */
  version: z.number(),
  /** `varchar(15)` 可空：手工工单没序列号 ⇒ JSON `null`（**不是空串**）。排序键 */
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  /** `serialize_i64_opt`：`null` = 未制定工序（本页「待制定 / 已制定」分组依据） */
  process_chain_id: z.string().nullable(),
  /** `serialize_i64_opt`：`null` = 独立零件；非 `null` = 装配件的子零件。
   *  ⚠️ 该字段**不是**过滤条件（后端刻意不加 `AND assembly_id IS NULL`），
   *  只供前端标注归属。 */
  assembly_id: z.string().nullable(),
});

export type ProcessDesignPartSchema = z.infer<typeof processDesignPartSchema>;

/** 2026-10-05：`GET /prod/process-design/parts` 顶层（后端 `ProcessDesignPartListOut`）——
 *  分页信封 `{ items, total, limit, offset }`。三个计数是裸 i64 ⇒ `z.number()`。 */
export const processDesignPartListResultSchema = z.object({
  items: z.array(processDesignPartSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type ProcessDesignPartListResultSchema = z.infer<typeof processDesignPartListResultSchema>;
