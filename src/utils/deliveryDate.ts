/**
 * 计划交期缓冲天数。
 *
 * 2026-08-05 起前端不再减缓冲，直接显示真实计划交期，与后端打印背面
 *（service/printing.py 已无 buffer）对齐；常量保留为 0，以便将来需要时恢复。
 *
 * **日期串一律按本地零点构造 Date**（2026-10-07）：ES 规范里 `new Date('YYYY-MM-DD')`
 * 这种 date-only 形式按 **UTC 零点**解读，而「今天」那一侧是**本地零点** —— 两端口径
 * 不一致会让天数差按时区偏移恒偏 1 天（东八区恒 +1 天，昨天到期的件被算成
 * 「今天到期」且不显红）。本文件所有解析入口统一走 `parseLocalIso`，让日期串与
 * 「今天」同处一个时区基准。
 *
 * 影响面：`shiftIsoDate` 供 `bufferedDeliveryDate` 内部用（缓冲天数为 0 时是恒等
 * 变换，但保留入口以便将来恢复缓冲），其上挂 `formatDeliveryDate`（MM/DD 展示）、
 * `deliveryDaysLeftText`（倒计文案）、`deliveryUrgencyClass` / `deliveryUrgencyTag`
 * （紧迫样式）。绝对输出的回归锁见 `src/utils/__tests__/deliveryDate.spec.ts`
 * （按 TZ 两档分别锁定）。
 */
export const DELIVERY_DATE_BUFFER_DAYS = 0;

type DeliveryDate = string | null | undefined;

/**
 * ISO 日期串 → 本地零点的 Date。**不要**直接用 `new Date('YYYY-MM-DD')`：
 * date-only 形式按 UTC 零点解读，与本地零点的「今天」不同基准（见文件头）。
 * 非法串返回 null，由调用方按「无值」处理。
 */
function parseLocalIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(y, mo - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** 本地零点格式化回 ISO（'YYYY-MM-DD'）。 */
function toLocalIso(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 把 ISO 日期字符串向过去推 N 天，返回新 ISO 日期字符串。空值 / 非法值 → 空串。 */
function shiftIsoDate(s: string, days: number): string {
  const d = parseLocalIso(s);
  if (!d) return '';
  d.setDate(d.getDate() - days);
  return toLocalIso(d);
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

/**
 * 送货单打印「预估交期」列的展示格式：`YYYY-MM-DD` → `M月D日`（月、日不补零，不带年份）。
 *
 * 走 `parseLocalIso` 而不是裸正则切片，是为了让非法串与本文件其余入口同口径返空串。
 * 只做取字段、不做日期算术 ⇒ 不存在 UTC / 本地零点的漂移问题（见文件头那条约束的成因）。
 * 空值 / 非法串 → 空串，由调用方按「无值」处理。
 */
export function formatDeliveryMonthDay(s: DeliveryDate): string {
  if (!s) return '';
  const d = parseLocalIso(s);
  if (!d) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 本地零点「今天」+ 目标日与它的日历日差（两端同基准，见 parseLocalIso）。 */
function calendarDaysLeftOf(buffered: string): number | null {
  const target = parseLocalIso(buffered);
  if (!target) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 基于缓冲后日期计算剩余天数文案。空值→空；过期→'已逾期N天'；今天→'今天到期'；≤3 天→'N天后到期'。 */
export function deliveryDaysLeftText(s: DeliveryDate): string {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return '';
  const diff = calendarDaysLeftOf(buffered);
  if (diff === null) return '';
  if (diff < 0) return `已逾期${Math.abs(diff)}天`;
  if (diff === 0) return '今天到期';
  if (diff <= 3) return `${diff}天后到期`;
  return '';
}

/** 基于缓冲后日期返回样式类：'overdue' / 'due-soon' / ''。 */
export function deliveryUrgencyClass(s: DeliveryDate): '' | 'overdue' | 'due-soon' {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return '';
  const diff = calendarDaysLeftOf(buffered);
  if (diff === null) return '';
  if (diff < 0) return 'overdue';
  if (diff <= 3) return 'due-soon';
  return '';
}

/**
 * 基于缓冲后日期返回 Element Plus Tag 类型。
 *
 * **全仓无消费方**（`DeliveryDateChip` 与三页模板都用 `deliveryUrgencyClass` 的 class
 * 方案，不用 Tag type）。保留不删：后端补上真实投影后若产品改回「标签」形态，这里
 * 直接可用。口径与上面两个函数同源。
 */
export function deliveryUrgencyTag(s: DeliveryDate): 'danger' | 'warning' | 'info' {
  const buffered = bufferedDeliveryDate(s);
  if (!buffered) return 'info';
  const diff = calendarDaysLeftOf(buffered);
  if (diff === null) return 'info';
  if (diff < 0) return 'danger';
  if (diff <= 3) return 'warning';
  return 'info';
}
