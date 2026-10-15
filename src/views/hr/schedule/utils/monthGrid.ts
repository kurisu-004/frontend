// src/views/hr/schedule/utils/monthGrid.ts
//
// 2026-10-19 新建：月历的 42 格生成 + 一组本地零点的日期串运算。纯函数、零 Vue 依赖，
// `ScheduleMonthGrid.vue` / `ScheduleSelectionBar.vue` / `useScheduleStore.ts` 三处共用。
//
// ⚠️ **绝不 `new Date('YYYY-MM-DD')`**：ES 规范里 date-only 形式按 **UTC 零点**解读，而
//   「今天」那一侧是本地零点 —— 东八区下 `new Date('2026-10-19')` 落在 10-18 08:00，整月
//   坐标轴往前挪一天（首行全是上月末、月末两格空出来，拖选区间也跟着错）。同类坑已在本仓
//   两处登记：`utils/deliveryDate.ts` 与 `views/dashboard/components/UpcomingDeliveryChart.vue`。
//   本文件自建 `parseLocalIso` / `toLocalIso`（那两处的同名 helper 是私有的、不导出），
//   **日期串与「今天」同处一个时区基准**。
//
// 一律按「周日起」对齐：月历第一列是周日（与仓内其它日历视图的中文习惯一致），月初是周一时
// 前补 6 格，月初是周日时前补 0 格。

/** 月历固定 6 行 × 7 列。**格数恒定**是刻意的：月视图不随月份高度跳变，翻月时格子位置
 * 不动（只换内容），拖选的肌肉记忆与视觉扫描都不被打断。 */
export const MONTH_GRID_CELLS = 42;

/** 补格数的上界：月初是周日时正好补 0 格，月初是周六时补 6 格（首格落在上月最后一天）。 */
export const MAX_LEADING_PAD = 6;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** 月历的一格。 */
export interface MonthCell {
  /** `'YYYY-MM-DD'`。 */
  iso: string;
  /** 日（1..31）。补格也带真实日号（`29` / `31`），只是 `inMonth` 为 false。 */
  day: number;
  /** 星期几（0 = 周日 .. 6 = 周六）。 */
  weekday: number;
  /** 是否落在当月内。false = 前后月补格：灰显、不可点、不可拖选。 */
  inMonth: boolean;
}

/** ISO 日期串 → 本地零点的 `Date`（见文件头的 UTC 陷阱）。非法串返回 `null`。 */
export function parseLocalIso(s: string): Date | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** 本地零点的 `Date` → `'YYYY-MM-DD'`（本地零点口径，不走 `toISOString` 的 UTC）。 */
export function toLocalIso(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** ISO 日期串加减天数（本地零点）。非法串返回空串（调用方按「无值」处理）。 */
export function addDaysIso(iso: string, days: number): string {
  const d = parseLocalIso(iso);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return toLocalIso(d);
}

/** `from` → `to` 走过的天数（`to` 在后为正）。任一非法串返回 `0`。
 *
 *  **不拿它算「还剩几天」这类展示**：那类展示的基准是「今天」，与本页无关；这里只给
 *  「选区跨几天」「区间是否越 366 天」两处夹紧用。参数顺序按「起点、终点」读，
 *  调用方不必自己摆正负。 */
export function daysBetween(from: string, to: string): number {
  const a = parseLocalIso(from);
  const b = parseLocalIso(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** 两个 ISO 日期串的 `[早, 晚]`（逐字比较即可：同格式定长串的字典序 = 时间序）。 */
export function isoMinMax(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** 某月的首末日（`month` 取 1..12）。 */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  return { from: toLocalIso(first), to: toLocalIso(last) };
}

/**
 * 生成 6×7 = 42 格月历。
 *
 * @param year 公元年。
 * @param month 月份，**1..12**（调用方是「翻到 YYYY-MM」那个游标，不要传 0..11）。
 *
 * 补格口径：先按月初的星期回退到最近的周日（最多回退 6 格），再连续铺 42 天。
 */
export function buildMonthGrid(year: number, month: number): MonthCell[] {
  const first = new Date(year, month - 1, 1);
  const leadingPad = first.getDay();
  const cells: MonthCell[] = [];
  for (let i = 0; i < MONTH_GRID_CELLS; i += 1) {
    const d = new Date(year, month - 1, 1 + i - leadingPad);
    cells.push({
      iso: toLocalIso(d),
      day: d.getDate(),
      weekday: d.getDay(),
      // 判当月**同时**看月与年：只看 `getMonth()` 会把去年 12 月的补格（与本月同为 11 月
      // 的情形）误判成当月，翻到 1 月时首行整行都是「当月」灰格。
      inMonth: d.getFullYear() === year && d.getMonth() === month - 1,
    });
  }
  return cells;
}
