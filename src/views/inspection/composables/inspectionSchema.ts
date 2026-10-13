// src/views/inspection/composables/inspectionSchema.ts
//
// 2026-10-07 新增：品检域的 Zod 守门 schema 搬进域内，与 query hook 同居。
// 「待品检一览」域的 Zod 守门 schema，两组：
//   1. 待品检队列（守门 `GET /api/v2/prod/inspection/queue` 的**精简 13 字段
//      VO**）—— 守门点是列表 query 的 queryFn（useInspectionQueueQuery）；
//   2. 品检扫码树（守门 `GET /api/v2/prod/inspection/scan/{serial_no}`）。
//
// 为什么住域内而不是全局 schema 文件：守门点（queryFn / 扫码 mutation）都在本域，
// schema 跟着消费点走免得跨目录找。

import { z } from 'zod';

// ============================================================
// 待品检队列行 + 列表（`GET /api/v2/prod/inspection/queue` 的精简 13 字段 VO）。
//
// 为什么与返修 VO（composables/queries/schemas.ts::repairBatchListItemSchema，
// 28 字段）分家：待品检页最终只显示 7 个数据列（序列号 / 图号 / 名称 / 批次 / 数量 /
// 系统交期 / 客户），后端为本端点新建了只覆盖这些列 + 3 个写端点锚字段的精简 VO。
// `GET /prod/batches/repair` 与 `GET /prod/batches/repairing` 继续用那套 28 字段 VO，
// 两端点的行对象**不可互相 cast** —— 少了 status / location / holder_name 等键。
//
// key 集合**恰为 14 个**，且用 `.strict()`：多一个键即抛 `unrecognized_keys`。
//   1. 列表页的 7 个数据列：batch_no / serial_no / drawing_no / name / quantity /
//      system_delivery_date / customer_name（+ l1_customer_name 客户列次行 +
//      customer_path 主行，后两个都是 2026-10-17 客户无限层级后加的）；
//   2. 写端点与跳转锚：batch_id（`POST /prod/batches/{batch_id}/…` 路径参数 +
//      扫码选行标识）、part_id（`/parts/{part_id}` 详情跳转）、version
//      （`t_part_batch.version`，OCC 锚）、customer_id（客户表头筛选）、is_urgent
//      （加急红底）。
//
// 契约要点：
//   - `system_delivery_date` 是本 VO 列表页用到的交付日期列，wire 上是 `YYYY-MM-DD`
//     字符串，DB NULL → JSON null，故 `z.string().nullable()`，不锁字面量。
//   - batch_id / part_id / customer_id 是**雪花 ID 字符串**（`serialize_i64`，禁止
//     Number() —— 会丢精度）；batch_no / quantity / version 是 i32 → `z.number()`。
//   - `total` / `limit` / `offset` 同样是 `serialize_i64` ⇒ JSON **string**，与
//     `pendingProgrammingListResultSchema`（裸 i64 ⇒ number）方向相反，别照抄。
//     消费方在边界 `Number(resp.total)` 转 number 才能塞进分页组件的 total。
// ============================================================

export const inspectionQueueListItemSchema = z
  .object({
    batch_id: z.string(),
    batch_no: z.number(),
    quantity: z.number(),
    version: z.number(),
    part_id: z.string(),
    serial_no: z.string().nullable(),
    drawing_no: z.string(),
    name: z.string(),
    system_delivery_date: z.string().nullable(),
    is_urgent: z.boolean(),
    customer_id: z.string(),
    customer_name: z.string().nullable(),
    /** 根（L1）客户名，客户列**次行**。⚠️ 2026-10-17 客户无限层级后语义从「直接父名」
     *  改成「根名」。 */
    l1_customer_name: z.string().nullable(),
    /** 第 2 层到叶子的客户名，` / ` 拼接（**不含 L1**），客户列**主行**。
     *  2026-10-17 新增（客户无限层级改造）。⚠️ 部署顺序：后端必须先上 —— 本 schema 是
     *  `.strict()` 且键集合写死 14 个，声明成必填键之后旧后端不返它 ⇒ parse 抛 ⇒ 本页
     *  整表空白。空串是合法值（客户软删 / 父链成环）⇒ 展示层兜底退回 `customer_name`。 */
    customer_path: z.string().nullable(),
  })
  .strict();

export type InspectionQueueListItemData = z.infer<typeof inspectionQueueListItemSchema>;

/** 待品检队列分页结果（items / total / limit / offset 四字段，计数为 JSON string）。 */
export const inspectionQueueListResultSchema = z.object({
  items: z.array(inspectionQueueListItemSchema),
  total: z.string(),
  limit: z.string(),
  offset: z.string(),
});

export type InspectionQueueListResultData = z.infer<typeof inspectionQueueListResultSchema>;

// ============================================================
// 品检扫码树（`GET /api/v2/prod/inspection/scan/{serial_no}`）的 Zod 守门 schema。
//
// 响应是**一层套一层**的树：顶层 `hit_kind` 判条码是装配件还是零件；`assembly` 在
// 扫到装配件条码**或**扫中的零件是某个装配件的子件时带出装配件节点（它**没有批次**，
// 批次挂在零件节点下）—— 即「assembly 非空」不等价于「hit_kind='ASSEMBLY'」，前端
// 分形态时两个信息都要看；
// `children` 恒是零件数组（装配件树 = 全部子件；独立件树 = `[被扫中的那个 part]`），
// 每个零件的 `children` 是它的**全部**批次（含终态批次 —— 终态行要在表上显示为
// 不可操作，而不是从树上消失，否则用户会以为批次不存在）。
//
// 必填字段**逐个显式声明**（Zod strip 陷阱：漏声明 = 后端漏发该键时前端仍「通过」
// 校验、那一列整列失效）：
//   - 雪花 ID（`assembly.id` / 各 part / batch 的 `id`）是 `serialize_i64` ⇒ JSON
//     **string**，声明 `z.string()`（禁 `z.number()`，19 位 ID 在 JS Number 下丢精度）；
//   - 后端这些 VO 字段都没挂 `skip_serializing_if` ⇒ 键恒在，可空的一律
//     `.nullable()` 而非 `.optional()`（写成 `.optional()` 会让「后端漏发某个键」静默
//     通过，UI 的那一列整列失效）；
//   - `system_delivery_date` 是 `YYYY-MM-DD` 字符串，DB NULL → JSON null，不锁字面量。
//
// ⚠️ 两处版本号是**互不相关的两个计数器**，混用必 409：
//   - `ScanPartOut.version` = `t_part.version`，本页只作展示；
//   - `ScanBatchOut.version` = `t_part_batch.version`，三个写端点（to-inspection /
//     to-ship / to-process）的 OCC 锚，取错就是「版本冲突」的用户可见症状。
// ============================================================

/** 批次节点（`ScanBatchOut`）—— 三个写端点的锚都在这一层。 */
export const inspectionScanBatchSchema = z.object({
  id: z.string(),
  batch_no: z.number(),
  quantity: z.number(),
  /** 批次 `status` 原文（8 态枚举字符串），前端按它决定操作列的按钮矩阵。 */
  status: z.string(),
  /** `t_part_batch.version`（OCC 锚）。**不是** `t_part.version`。 */
  version: z.number(),
  /** 返修标记（后端不再产生 REPAIRING 状态，返修语义由该布尔列承载）。 */
  is_repairing: z.boolean(),
  /** `t_part_batch.location` 枚举原文。 */
  location: z.string().nullable(),
  /** 派生持有人名（货架编码 / 工人姓名）。 */
  current_holder_display: z.string().nullable(),
  /** 当前工序名；INSPECTION 批次恒 null（出池时后端清 `current_process_id`）。 */
  process_name: z.string().nullable(),
  /** 该批次所属零件就是被扫中的那个 → 前端高亮用。 */
  is_scanned: z.boolean(),
});

export type InspectionScanBatchData = z.infer<typeof inspectionScanBatchSchema>;

/** 零件节点（`ScanPartOut`）—— 装配件的子件，或独立件本身。 */
export const inspectionScanPartSchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  status: z.string(),
  quantity: z.number(),
  is_urgent: z.boolean(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  /** `t_part.version`（仅展示；写端点的 OCC 锚是 `children[].version`）。 */
  version: z.number(),
  children: z.array(inspectionScanBatchSchema),
});

export type InspectionScanPartData = z.infer<typeof inspectionScanPartSchema>;

/** 装配件节点（`ScanAssemblyOut`）—— 本身没有批次。 */
export const inspectionScanAssemblySchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  status: z.string(),
  quantity: z.number(),
  is_urgent: z.boolean(),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
});

export type InspectionScanAssemblyData = z.infer<typeof inspectionScanAssemblySchema>;

/** 扫码树顶层（`ScanTreeOut`）。 */
export const inspectionScanTreeSchema = z.object({
  /** `"ASSEMBLY"` = 扫到装配件条码；`"PART"` = 扫到子件 / 独立件条码。
   *  用 enum 守门（后端只有这两个字面量）：写成 z.string() 会让「后端改了命中口径」
   *  这类契约漂移一路溜到渲染层，靠人工看标签文案才发现。 */
  hit_kind: z.enum(['ASSEMBLY', 'PART']),
  scanned_serial_no: z.string(),
  /** 扫装配件条码、或扫中的是某个装配件的子件时有值；独立件 / 父装配件已软删时为 null。 */
  assembly: inspectionScanAssemblySchema.nullable(),
  children: z.array(inspectionScanPartSchema),
});

export type InspectionScanTreeData = z.infer<typeof inspectionScanTreeSchema>;
