/**
 * 系统交期窗口 + 「已交过」分桶的纯函数底座。
 *
 * 2026-10-03 新增：dashboard「最紧急工单」与「部分已交工单」两块面板共用同一份
 * union-list 拉取结果（useDashboardUrgentList.items，后端已按 system_delivery_date ASC
 * 排好），本模块负责在客户端按 7 天窗口（today → today+6）过滤并按「有无已交批次」
 * 分成两桶。
 *
 * **「有已交批次就移出紧急列表」这条规则只允许存在这一个模块里** —— 两个面板都必须
 * 调 `splitForDashboard`，不允许任何一侧自己再判一次 `delivered_quantity`，否则两侧
 * 口径漂移（一边剔一边不剔）无法在单测里发现。
 *
 * 纯函数、无 vue 依赖：便于在 spec 里直接构造 fixture 断言边界。
 */

import type { PartListItem } from '@/types/parts';

/** 交期窗口天数：today → today+6（含端点，即 7 天）。 */
export const DELIVERY_WINDOW_DAYS = 7;

/** today+(DELIVERY_WINDOW_DAYS-1) 的本地 ISO（'YYYY-MM-DD'），作为过滤上限。 */
export function deliveryWindowCutoffIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + DELIVERY_WINDOW_DAYS - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 工单是否落在交期窗口内：system_delivery_date 为 null 剔除，晚于上限剔除。 */
export function inDeliveryWindow(item: PartListItem): boolean {
  if (!item.system_delivery_date) return false;
  return item.system_delivery_date <= deliveryWindowCutoffIso();
}

/** 是否「已经交过」：已送数量 > 0。字段缺失（后端未上线该列）时按未交过处理。 */
export function hasDeliveredQuantity(item: PartListItem): boolean {
  return (item.delivered_quantity ?? 0) > 0;
}

export interface SplitOptions {
  urgentLimit: number;
  partialLimit: number;
}

export interface SplitResult {
  urgent: PartListItem[];
  partial: PartListItem[];
}

/**
 * 窗口内按「有无已交批次」分桶，各自带上限。
 *
 * 口径要点：
 *   - 「交齐后移出」不靠前端判 `status === 'DELIVERED'`：union-list 的 statuses 请求集
 *     本身不含 DELIVERED，交齐的工单自动不在候选集内（后端 min-progress 派生）。
 *   - 「有交过」= `delivered_quantity > 0`，这类进 partial；其余（0 / 字段缺失）留 urgent。
 *     ⇒ `delivered_quantity` 缺失时 urgent 桶与不做分桶完全一致。
 *   - 后端已按 system_delivery_date ASC 排好，前端只 filter + slice，**不重排**。
 */
export function splitForDashboard(
  items: PartListItem[],
  { urgentLimit, partialLimit }: SplitOptions,
): SplitResult {
  const inWindow = items.filter(inDeliveryWindow);
  return {
    urgent: inWindow.filter((it) => !hasDeliveredQuantity(it)).slice(0, urgentLimit),
    partial: inWindow.filter(hasDeliveredQuantity).slice(0, partialLimit),
  };
}
