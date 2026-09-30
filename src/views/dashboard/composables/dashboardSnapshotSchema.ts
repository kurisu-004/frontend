// 2026-09-28 新增：dashboard 域大屏快照 Zod schema。
//
// 字段对齐 backend-rust/src/modules/dashboard/vo/snapshot.rs 的 DashboardSnapshot
// VO（含 OnProductionShelfGroup / DashboardItem / UpcomingDeliveryBucket 共 19 + 4 + 2 = 25
// 字段全集；DashboardItem 5 必填 + 14 nullable）。
//
// 关键约束（沿 2026-09-26 约定的 queryFn Zod 守门 + 2026-09-24 Zod schema-first）：
//   - 所有非 Option 字段必填显式声明（Zod 默认 strip 模式会静默丢弃未声明字段，
//     与 customerSchema S4 regression guard 同形态）；
//   - 数值类 i64（COUNT(*)::bigint 等）保留 JSON integer，前端 z.number()；
//     仅 snowflake ID（> Number.MAX_SAFE_INTEGER = 2^53-1）走 serde-i64 → string，
//     与 customerSchema S4 / partSchema S12 同形态。
//   - 2026-09-30 bugfix：原注释将所有 i64 一刀切走字符串是错的（与 snapshot.rs:124
//     count: i64 + docs/api/dashboard.md:90「数值类保留 JSON integer」不一致）。
//   - 链式 trim 在前（沿 2026-09-24 约定）—— 本 VO 无 string trim 需求，仅在
//     后期如新增字符串字段校验时遵循；
//   - 不强制长度 / 范围（与 composables/queries/schemas.ts 注释一致：基础数据
//     schema 只验证「能解析就够了」，DDL 边界是表单 schema 职责）。
//
// 数据来源：
//   - backend-rust/src/modules/dashboard/vo/snapshot.rs:77-119（DashboardSnapshot 5 顶层字段）
//   - snapshot.rs:86-92（OnProductionShelfGroup 4 字段 + items: Vec<DashboardItem>）
//   - snapshot.rs:95-119（DashboardItem 19 字段，5 必填 + 14 nullable）
//   - snapshot.rs:122-125（UpcomingDeliveryBucket 2 字段）

import { z } from 'zod';

/** 2026-09-28 新增：单个零件 / 批次行（DashboardItem VO）。
 *  19 字段全部显式声明：5 个非 Option 必填（id / name / drawing_no / quantity /
 *  is_urgent），14 个 Option 字段 nullable()。 */
export const dashboardItemSchema = z.object({
  id: z.string(),
  // 2026-07-29 批次化：卡片行=批次；quantity 为批次量
  batch_id: z.string().nullable(),
  batch_no: z.number().nullable(),
  serial_no: z.string().nullable(),
  name: z.string(),
  drawing_no: z.string(),
  quantity: z.number(),
  is_urgent: z.boolean(),
  planned_delivery_date: z.string().nullable(),
  picked_up_at: z.string().nullable(),
  // 2026-09-16 PR-2 暂存：3 字段（current_holder_id / current_holder_kind /
  // shelf_code）值来自 rust 后端 dashboard/service.rs
  current_holder_id: z.string().nullable(),
  current_holder_kind: z.string().nullable(),
  shelf_code: z.string().nullable(),
  // customer_* 4 字段
  customer_id: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_path: z.string().nullable(),
  // 大屏「下一工序」直接展示
  next_process_id: z.string().nullable(),
  next_process_name: z.string().nullable(),
  worker_name: z.string().nullable(),
});

export type DashboardItemData = z.infer<typeof dashboardItemSchema>;

/** 2026-09-28 新增：生产区货架分组（OnProductionShelfGroup VO）。
 *  4 顶层字段 + items: Vec<DashboardItem>。total_count 是 usize（后端非 Option），
 *  必填 number。 */
export const onProductionShelfGroupSchema = z.object({
  shelf_id: z.string(),
  shelf_code: z.string(),
  shelf_name: z.string(),
  total_count: z.number(),
  items: z.array(dashboardItemSchema),
});

export type DashboardShelfGroupData = z.infer<typeof onProductionShelfGroupSchema>;

/** 2026-09-28 新增：未来 N 天交付分桶（UpcomingDeliveryBucket VO）。
 *  count 是 COUNT(*)::bigint → JSON integer，前端 z.number() 接收（沿
 *  backend-rust/docs/api/dashboard.md:90「数值类保留 JSON integer」约定）。
 *  2026-09-30 bugfix：原误用 z.string()，与后端 VO i64 类型不符。 */
export const upcomingDeliveryBucketSchema = z.object({
  date: z.string(),
  count: z.number(),
});

export type UpcomingDeliveryEntryData = z.infer<typeof upcomingDeliveryBucketSchema>;

/** 2026-09-28 新增：大屏快照顶层（DashboardSnapshot VO）。
 *  5 顶层字段（4 数组 + 1 ts 时间戳），全部显式声明。
 *  顶层 ts 与 in_process / on_production_shelves 等字段 ts 是独立字段（snapshot 内
 *  各分块带自己的 ts，服务端实现细节，前端不强校验语义）。 */
export const dashboardSnapshotSchema = z.object({
  on_production_shelves: z.array(onProductionShelfGroupSchema),
  on_inspection_shelves: z.array(dashboardItemSchema),
  in_process: z.array(dashboardItemSchema),
  upcoming_delivery: z.array(upcomingDeliveryBucketSchema),
  ts: z.string(),
});

export type DashboardSnapshotData = z.infer<typeof dashboardSnapshotSchema>;
