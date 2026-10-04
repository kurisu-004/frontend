/**
 * 系统交期窗口 + 「已交过」分桶的纯函数底座。
 *
 * 2026-10-03 新增：dashboard「最紧急工单」与「部分已交工单」两块面板共用同一份
 * union-list 拉取结果（useDashboardUrgentList.items，后端已按 system_delivery_date ASC
 * 排好），本模块负责在客户端按 7 天窗口（today → today+6）过滤并按「有无已交批次」
 * 分成两桶。
 *
 * **窗口两端**（2026-10-05 补下界）：与 `useDashboardUrgentList` 下发给服务端的
 * `system_delivery_date_from/_to` 是**同一个窗口**（下界 = 今天，上界 = 今天+6）。
 * 服务端先过滤，客户端再过一遍不是为了改口径，而是把服务端分页/裁剪之外的边界
 * （例如后端某天放宽了日期条件）在面板侧钉死；两端定义同源于本模块，调用方
 * （useDashboardUrgentList）直接取 `deliveryWindowStartIso` / `deliveryWindowEndIso`
 * 拼请求参数，不允许任何一处自己再写一份「today+6」。
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

/** Date → 本地 ISO（'YYYY-MM-DD'）。 */
function toLocalIso(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 'YYYY-MM-DD' 加减 n 天（按本地时区，跨月/跨年/夏令时都由 Date 归一）。 */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((n) => Number(n));
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + days);
  return toLocalIso(dt);
}

/** 窗口下界 = 本地今天的 ISO（'YYYY-MM-DD'），作为过滤下限与服务端 from 参数。 */
export function deliveryWindowStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return toLocalIso(d);
}

/** 给定窗口下界求上界：start + (DELIVERY_WINDOW_DAYS-1) 天。服务端 to 参数用。 */
export function deliveryWindowEndIso(startIso: string): string {
  return addDaysIso(startIso, DELIVERY_WINDOW_DAYS - 1);
}

/** 窗口上界 = today+(DELIVERY_WINDOW_DAYS-1) 的本地 ISO（'YYYY-MM-DD'），作为过滤上限。 */
export function deliveryWindowCutoffIso(): string {
  return deliveryWindowEndIso(deliveryWindowStartIso());
}

/** 工单是否落在交期窗口内：system_delivery_date 为 null 剔除，
 *  早于下界（逾期）或晚于上界（窗口外）剔除。 */
export function inDeliveryWindow(item: PartListItem): boolean {
  const date = item.system_delivery_date;
  if (!date) return false;
  return date >= deliveryWindowStartIso() && date <= deliveryWindowCutoffIso();
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
