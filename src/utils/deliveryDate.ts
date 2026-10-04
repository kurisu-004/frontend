/**
 * 计划交期缓冲天数。
 *
 * 2026-08-05 起前端不再减缓冲，直接显示真实计划交期，与后端打印背面
 *（service/printing.py 已无 buffer）对齐；常量保留为 0，以便将来需要时恢复。
 *
 * ⚠️ 2026-10-04 已知缺陷（本批刻意不修，登记在此）：**天数口径按时区偏移**。
 *
 * `shiftIsoDate` 与下面三个天数/样式函数都把日期串交给 `new Date('YYYY-MM-DD')`，而
 * ES 规范里 date-only 形式按 **UTC 零点**解读；「今天」那一侧是**本地零点**。于是
 * `Math.ceil((target - today) / 86400000)` 在东八区恒多 1 天，实测（TZ=Asia/Shanghai，
 * 「今天」= 2026-10-04）：
 *   真实日历日 今天   → `1天后到期`（不是「今天到期」）
 *   真实日历日 昨天   → `今天到期` + `due-soon`（**不是 `overdue`**）—— 已经过期的件
 *                      在产线屏上不显红，只剩橙色
 *   真实日历日 今天+2 → `3天后到期`（`due-soon` 窗口因此整体前移一天）
 *   真实日历日 5 天前 → `已逾期4天`
 * TZ=UTC 下全部正确 ⇒ 纯时区产物。回归锁见 `src/utils/__tests__/deliveryDate.spec.ts`
 * （该文件按 TZ 两档分别锁定当前绝对输出，修好之后两档会同时变 ⇒ 测试变红是提醒）。
 *
 * 影响面（受影响的 4 个组件消费点）：
 *   - `views/scan/components/DeliveryDateChip.vue` —— 2026-10-04 起 chip 恒渲染，
 *     `daysText` / `overdue` / `due-soon` 首次在报工台 HMI 上真正生效（此前
 *     `system_delivery_date` 恒 null，这段是死路径）；后端补上真实投影的同一次发布
 *     就会把它暴露给工人。
 *   - `views/dashboard/components/UpcomingDeliveryListDrawer.vue` / `UrgentOrderDrawer.vue`
 *     / `SystemDeliveryOrdersPanel.vue` —— 早已在生产上带着这个偏差跑。
 *
 * 取舍（2026-10-04）：报工台这批改动**不顺手修**。修它要改日期串的解析口径（按本地
 * 零点构造 Date），会同时改动上面 3 个 dashboard 组件的渲染值（逾期红线的位置、倒计时
 * 文案），属于另一个评审面；混进本批会让这次改动的爆炸半径失控。
 */
export const DELIVERY_DATE_BUFFER_DAYS = 0;

type DeliveryDate = string | null | undefined;

/** 把 ISO 日期字符串向过去推 N 天，返回新 ISO 日期字符串。空值 → 空串。 */
function shiftIsoDate(s: string, days: number): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 缓冲后的日期；空值 → 空串。 */
export function bufferedDeliveryDate(s: DeliveryDate): string {
  if (!s) return '';
  return shiftIsoDate(s, DELIVERY_DATE_BUFFER_DAYS);
}

/** 扫码三页显示交期：缓冲后的 MM/DD。 */
export function formatDeliveryDate(s: DeliveryDate): string {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return '';
  return buffered.slice(5).replace(/-/g, '/');
}

/** 基于缓冲后日期计算剩余天数文案。空值→空；过期→'已逾期N天'；今天→'今天到期'；≤3 天→'N天后到期'。 */
export function deliveryDaysLeftText(s: DeliveryDate): string {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return '';
  const target = new Date(buffered);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((target.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return `已逾期${Math.abs(diff)}天`;
  if (diff === 0) return '今天到期';
  if (diff <= 3) return `${diff}天后到期`;
  return '';
}

/** 基于缓冲后日期返回样式类：'overdue' / 'due-soon' / ''。 */
export function deliveryUrgencyClass(s: DeliveryDate): '' | 'overdue' | 'due-soon' {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return '';
  const target = new Date(buffered);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((target.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff <= 3) return 'due-soon';
  return '';
}

/**
 * 基于缓冲后日期返回 Element Plus Tag 类型。
 *
 * ⚠️ 2026-10-04 登记：**全仓无消费方**（`DeliveryDateChip` 与三页模板都用
 * `deliveryUrgencyClass` 的 class 方案，不用 Tag type）。保留不删：后端补上真实投影后
 * 若产品改回「标签」形态，这里直接可用。天数口径同文件头那条已知缺陷。
 */
export function deliveryUrgencyTag(s: DeliveryDate): 'danger' | 'warning' | 'info' {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return 'info';
  const target = new Date(buffered);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((target.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return 'danger';
  if (diff <= 3) return 'warning';
  return 'info';
}

/** Dashboard 货架卡片专用：缓冲后短日期 MM-DD；空值 → '-'。 */
export function formatDashboardDeliveryDate(s: DeliveryDate): string {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return '-';
  return buffered.slice(5);
}
