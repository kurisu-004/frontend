// views/inspection/composables/resolveScanRouteStatus.ts
//
// 2026-10-03 新增：待品检一览页「扫码命中 0 行」时的状态分流判据（纯函数）。
//
// 抽成独立纯函数而不是留在 `InspectionPending.vue` 里的原因：该视图挂 4 个业务弹窗 +
// 批次选择弹窗 + 扫码全局订阅 + 5min 自动刷新 timer，为断这三条分支而整体挂载成本
// 过高；且它是本次 VO 收口唯一改了**用户可见行为**的地方（见下方两条判据注释），
// 值得有独立的穷举单测。

/** 扫码 fallback 的三条出口（值即语义，不做二次编码）。 */
export type ScanRouteKind =
  /** 零件在品检中，但被当前筛选 / 分页挡在列表外 → 提示用户调筛选，不要弹二选一。 */
  | 'inspection-out-of-range'
  /** 可以走「快捷品检」弹窗（搬到品检架 + 通过 / 打回，一步到位）。 */
  | 'scan-inspect'
  /** 本页无动作能力 → 降级为「显示当前位置」提示（findPartBySerialAndPrompt）。 */
  | 'locate';

/**
 * `getPartBySerial` 命中一个零件后，决定待品检页该怎么响应。
 *
 * 判据说明：
 *  - `inspection-out-of-range`：**不能**照 2026-09-30 版那样直接弹「品检通过 / 指定
 *    工序」二选一 —— 那条路径拿的是 part 级形态，`batch_id` 为 null/undefined，
 *    两个动作都会打成 `/prod/batches/undefined/...` 的必失败请求。走到这里说明该
 *    批次被当前筛选 / 分页挡在列表外，明确提示用户调整范围。
 *  - `scan-inspect`：`scan-inspect` 端点接受的合法起点状态（PENDING 未下发、
 *    PROGRAMMING 编程中、IN_PROCESS 且在生产货架上）。
 *  - `locate`：其余全部（IN_PROCESS+WORKER / READY_TO_SHIP / DELIVERED /
 *    REPAIRING / OUTSOURCE / COMPLETED / CANCELLED / 后端未识别的状态值），
 *    降级为展示当前位置，不做任何写操作。
 *
 * `status` / `location` 刻意收成 `string | null | undefined` 而不是 `OrderStatus`：
 * 后端加状态值时前端应落到 `locate` 而不是抛类型错误。
 */
export function resolveScanRouteStatus(
  status: string | null | undefined,
  location: string | null | undefined,
): ScanRouteKind {
  if (status === 'INSPECTION') return 'inspection-out-of-range';
  if (
    status === 'PENDING' ||
    status === 'PROGRAMMING' ||
    (status === 'IN_PROCESS' && location === 'PRODUCTION_SHELF')
  ) {
    return 'scan-inspect';
  }
  return 'locate';
}
