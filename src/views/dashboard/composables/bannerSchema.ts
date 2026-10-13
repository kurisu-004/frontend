// 2026-10-13 新增：SCAN_BANNER 事件的守门 schema。
//
// 它守的是**推送通道**（`/ws/dashboard` 的 `{type:'event', event_type:'SCAN_BANNER'}` 帧），
// 这是本仓 Zod 守门点的第三种形态：
//   1. queryFn 守门 —— HTTP 首取的三个 dashboard 端点（dashboardSnapshotSchema.ts）；
//   2. api 层 / useMutation 承载的单次拉取（如 api/inspection.ts 的扫码树）；
//   3. **推送通道** —— 既没有 queryFn 承载，也不是 api 层的函数调用，而是 WS 长连接
//      直接把帧送进组件的 `onDashboardEvent` 回调 ⇒ `.parse()` 的落点是**组件回调内部**
//      （`views/dashboard/components/ScanBanner.vue`），api 层不参与。
//
// 关键约束（与 dashboardSnapshotSchema.ts 同款）：
//   - 所有字段**显式声明**。Zod 默认 strip 会静默丢弃未声明字段，漏一个声明，
//     守门就形同虚设；
//   - 可空字段 nullable() 且**不给默认值** —— 后端显式返 null 与「字段缺失」是两种
//     状态，混起来会把契约漂移渲染成「无值」而不是当场暴露；
//   - 不强制长度 / 范围（基础数据 schema 只验证「能解析就够了」）。

import { z } from 'zod';

/** SCAN_BANNER 的三个动作值。刻意与「旧横幅支持的 8 个 kind」不是一回事 ——
 *  这里描述的是报工台上的一次动作（扫码台的操作），不是 dashboard 的状态翻转事件。
 *  两者在 wire 上是不同位置：动作在 `data.action`，状态翻转在 `event_type`。 */
export const SCAN_BANNER_ACTIONS = ['PICKED_UP', 'RETURNED', 'INSPECTED'] as const;

/** `data` 的形态（后端 `ScanBannerItem`，6 字段，全部显式声明）。 */
export const scanBannerItemSchema = z.object({
  /** 报工台上刚发生的动作。 */
  action: z.enum(SCAN_BANNER_ACTIONS),
  /** 作业工人姓名（非空：事件由一次成功的扫码提交产生，作业人必存在）。 */
  worker_name: z.string(),
  /** 工单序列号。终态工单可为 NULL，此时展示层回落图纸号。 */
  serial_no: z.string().nullable(),
  /** 图纸号（序列号的兜底来源，必填）。 */
  drawing_no: z.string(),
  /** 本次动作涉及的件数（后端 i32 → JS number）。 */
  quantity: z.number(),
  /** 系统交期（可空）。**刻意用宽松的 `z.string().nullable()` 而非日期格式闸**：
   *  后端用 NaiveDate 还是 NaiveDateTime 序列化会决定 wire 上是 `2026-10-27` 还是
   *  `2026-10-27T00:00:00`，展示层只取 `M-DD`，格式闸加严只会让两种合法形态里
   *  的一种被静默丢弃（事件被守门丢掉 = 该条横幅不出现），对正确性零收益。 */
  system_delivery_date: z.string().nullable(),
});

export type ScanBannerItemData = z.infer<typeof scanBannerItemSchema>;
