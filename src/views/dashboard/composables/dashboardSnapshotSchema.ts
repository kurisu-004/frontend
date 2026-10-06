// 2026-10-07 重写：dashboard 域三个只读端点的 Zod schema。
//
// 契约来源：backend-rust `docs/api/dashboard.md`（唯一权威来源，勿翻后端源码反推）。
// 三个端点各一组 schema：
//   - GET /dashboard/snapshot          → dashboardSnapshotSchema（及其两个行 schema）
//   - GET /dashboard/upcoming-delivery → upcomingBucketsSchema
//   - GET /dashboard/delivery-orders   → deliveryOrderDetailOutSchema
//
// 关键约束（沿 2026-09-26 约定的 queryFn Zod 守门 + 2026-09-24 Zod schema-first）：
//   - 所有字段显式声明。Zod 默认 strip 模式会静默丢弃未声明字段，缺一个字段声明
//     守门就形同虚设（与 customerSchema S4 / partSchema S12 同形态）；
//   - 数值类 i64（COUNT(*)::bigint 等）保留 JSON integer，前端 z.number()；
//     仅 snowflake ID（> Number.MAX_SAFE_INTEGER = 2^53-1）走 serde-i64 → string；
//   - 可空字段一律 nullable()，**不给默认值**：后端显式返 null 与「字段缺失」是两种
//     状态，混起来会让下游的 `?? '—'` 把缺字段也渲染成「无值」而不是暴露契约漂移；
//   - 链式 trim 在前（沿 2026-09-24 约定）—— 本文件无 string trim 需求，仅在
//     后期如新增字符串字段校验时遵循；
//   - 不强制长度 / 范围（与 composables/queries/schemas.ts 注释一致：基础数据
//     schema 只验证「能解析就够了」，DDL 边界是表单 schema 职责）。

import { z } from 'zod';
import { ORDER_STATUSES } from '@/types/parts';
import { DELIVERY_BASES } from '@/types/dashboard';

/** 2026-10-07：工人在手加工批次（WorkerHeldBatch VO，7 字段）。
 *  `snapshot.in_process[]` 的行类型。语义由后端 SQL 硬约束钉死：
 *  `status = 'IN_PROCESS' AND location = 'WORKER'` —— 是「已从货架 / 品检区出池、
 *  压在工人手上」，故文案是「在加工」而非「在制」。
 *  quantity 取**批次量**（t_part_batch.quantity），不是工单总量。
 *  batch_id 必须保留：前端列表以它做 :key（t_part 无唯一约束，同一工单的多个
 *  IN_PROCESS 批次会产生多行，只用 part_id 会重复 key）。 */
export const workerHeldBatchSchema = z.object({
  id: z.string(),
  batch_id: z.string().nullable(),
  serial_no: z.string().nullable(),
  quantity: z.number(),
  is_urgent: z.boolean(),
  current_holder_id: z.string().nullable(),
  worker_name: z.string().nullable(),
});

export type WorkerHeldBatchData = z.infer<typeof workerHeldBatchSchema>;

/** 2026-10-07：右栏交期面板的行（SystemDeliveryOrder VO，9 字段）。
 *  `snapshot.system_delivery_orders.{urgent,partial}[]` 的行类型。
 *  两个桶由后端按 `delivered_quantity` 分好（urgent = 一件没交过，partial = 已交过
 *  一部分），窗口过滤与每桶截断也都在服务端，前端不再判口径。
 *  delivered_quantity 是**必填非 null**：语义是 0（没交过），缺失会被误读成「有交过」。 */
export const systemDeliveryOrderSchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  name: z.string(),
  quantity: z.number(),
  status: z.enum(ORDER_STATUSES),
  system_delivery_date: z.string().nullable(),
  customer_name: z.string().nullable(),
  is_urgent: z.boolean(),
  delivered_quantity: z.number(),
});

export type SystemDeliveryOrderData = z.infer<typeof systemDeliveryOrderSchema>;

/** 2026-10-07：大屏快照顶层（DashboardSnapshot VO，5 顶层字段）。
 *  无口径概念（交期分桶已拆到 /dashboard/upcoming-delivery），也不接受任何 query 参数。
 *  overdue_count 是工单级计数（装配件算 1 条），与本 VO 里件级的
 *  in_process / system_delivery_orders 行单位不同 —— 两者时间窗口不重叠
 *  （逾期窗口 < today，面板 / 柱状图窗口 >= today），故不冲突。 */
export const dashboardSnapshotSchema = z.object({
  overdue_count: z.number(),
  in_inspection_count: z.number(),
  in_process: z.array(workerHeldBatchSchema),
  system_delivery_orders: z.object({
    urgent: z.array(systemDeliveryOrderSchema),
    partial: z.array(systemDeliveryOrderSchema),
  }),
  ts: z.string(),
});

export type DashboardSnapshotData = z.infer<typeof dashboardSnapshotSchema>;

/** 2026-10-07：未来 N 天交付分桶的单桶（UpcomingDeliveryBucket VO，3 字段）。
 *  count 是 COUNT(*)::bigint → JSON integer，前端 z.number() 接收。
 *  by_status：柱状图按状态分层堆叠需要每个桶提供 OrderStatus → 件数明细，
 *  后端按 (date, status) 二维聚合后序列化输出。空 map = 当日 0 件。 */
export const upcomingDeliveryBucketSchema = z.object({
  date: z.string(),
  count: z.number().int().nonnegative(),
  by_status: z.record(z.string(), z.number().int().nonnegative()),
});

export type UpcomingDeliveryEntryData = z.infer<typeof upcomingDeliveryBucketSchema>;

/** 2026-10-07：交期分桶响应（UpcomingDeliveryBuckets VO，3 顶层字段）。
 *  today 是**后端**判定的今天（口径 Asia/Shanghai），与 buckets[0].date 是同一个值；
 *  前端一律用它做「今天」的锚点，不再 new Date()（浏览器时区与服务端不同步会让整块
 *  柱状图错位）。buckets 恒为请求的 days 条、缺失日期已在服务端零填充。
 *
 *  末位 refine 把「today 与 buckets[0].date 同值」这条契约钉成**机器校验**：它是
 *  DashboardView 里「今日到期」KPI 唯一的数据来源（取首桶 count）。后端一旦漂了
 *  零填充起点，KPI 会静默显示错日的数字；refine 让它在 queryFn 守门处抛错，走既有的
 *  ElMessage 错误桥接暴露成显式故障。 */
export const upcomingBucketsSchema = z
  .object({
    today: z.string(),
    buckets: z.array(upcomingDeliveryBucketSchema),
    ts: z.string(),
  })
  .refine((v) => v.buckets[0]?.date === v.today, {
    message: 'buckets[0].date 必须等于 today（后端自 today 起零填充，「今日到期」KPI 取首桶）',
  });

export type UpcomingBucketsData = z.infer<typeof upcomingBucketsSchema>;

/** 2026-10-07：柱状图下钻的行（DeliveryOrderDetail VO，9 字段）。
 *  两列交期恒同时返回（planned_delivery_date 是 NOT NULL 列），倒计列由前端按当前
 *  口径自己选列渲染。客户名两级：l1_customer_name 取上级客户名，叶子无 parent 时
 *  退化为叶子名，保证该列非空。 */
export const deliveryOrderDetailSchema = z.object({
  id: z.string(),
  serial_no: z.string().nullable(),
  drawing_no: z.string(),
  name: z.string(),
  l1_customer_name: z.string().nullable(),
  customer_name: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  planned_delivery_date: z.string(),
  system_delivery_date: z.string().nullable(),
});

export type DeliveryOrderDetailData = z.infer<typeof deliveryOrderDetailSchema>;

/** 2026-10-07：柱状图下钻响应（DeliveryOrderDetailOut VO，5 顶层字段）。
 *  date / basis 是请求参数回显。total 是匹配总数、**不受 items 截断影响**（抽屉头部
 *  据此渲染「共 N 件」，用 items.length 会在触顶时谎报）。items 最多 200 行。 */
export const deliveryOrderDetailOutSchema = z.object({
  date: z.string(),
  // 后端把请求参数原样回显，合法值与 DELIVERY_BASES 同源（收成 enum 后，非法口径
  // 不可能通过守门 —— 它只会在请求构造阶段就出错）。
  basis: z.enum(DELIVERY_BASES),
  total: z.number(),
  items: z.array(deliveryOrderDetailSchema),
  ts: z.string(),
});

export type DeliveryOrderDetailOutData = z.infer<typeof deliveryOrderDetailOutSchema>;
