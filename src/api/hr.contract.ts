// 2026-10-19 新建：人事（hr）域的**出参侧** wire 契约（types only，零 runtime）。
//
// 端点（baseURL `/api/v2`，前缀 `/hr/*`，零 PUT/PATCH/DELETE）：
//   GET  /hr/calendar/days                  ← listHrCalendarDays
//   POST /hr/calendar/days/delete            ← deleteHrCalendarDays
//   GET  /hr/shifts                         ← listHrShifts
//   POST /hr/shifts                         ← createHrShift（回显 ShiftOut）
//   POST /hr/shifts/{id}                    ← updateHrShift（回显 ShiftOut）
//   POST /hr/shifts/{id}/deactivate         ← deactivateHrShift（回显 ShiftOut）
//   GET  /hr/shifts/{id}/calendar           ← getHrShiftCalendar
//   POST /hr/shifts/{id}/calendar/days      ← saveHrShiftCalendarDays（回显 {affected}）
//   POST /hr/shifts/{id}/calendar/days/delete ← deleteHrShiftCalendarDays（回显 {affected}）
//
// 分层取舍：请求体 / 查询参数在 `src/types/hr.ts`（含日型枚举这种带 runtime 值的部分），
// 出参只在这里。两边不互相抄，`api/hr.ts` 把两侧类型拼成完整签名。
//
// wire 层形态约定：
//   - `id` 是雪花 ID 的 **JSON 字符串**（JS Number 会丢精度）；声明成 number 会在 JS 侧
//     悄悄改掉同一个 id；
//   - `version` / 计数 / 分钟数走**裸 JSON 数字**，前端照常用 number；
//   - 日期是 `'YYYY-MM-DD'` 字符串、时刻是 `'HH:MM'` 字符串（`HH ∈ 0..48`，绝对时钟轴，
//     逐档口径见 `types/hr.ts::ShiftSegmentOut`）；
//   - 列表端点的出参一律是**信封对象** `{items: [...]}`，不是裸数组。

import type { HrDayType, ShiftSegmentOut } from '@/types/hr';

/** `GET /hr/calendar/days` 的行 VO（`CalendarDayOut`）。 */
export interface CalendarDayOut {
  /** 日历日 `'YYYY-MM-DD'`。 */
  cal_date: string;
  day_type: HrDayType;
  /** 节假日名。`CUSTOM_LEAVE` 必填非空；其余档可空。 */
  name: string | null;
  /** **推导标记**：true = 该天没有显式行、按星期规则兜底推出来的；false = 库里真有这一行。
   *  用途：区分「这天本来就是周日」与「这天被谁手工改成了工作日」——前者不该显示成
   *  「已被修改」的痕迹。 */
  derived: boolean;
}

/** `GET /hr/shifts` / `POST /hr/shifts` / `POST /hr/shifts/{id}` /
 *  `POST /hr/shifts/{id}/deactivate` 共用的行 VO（`ShiftOut`）。 */
export interface ShiftOut {
  /** 雪花 ID 的 **JSON 字符串**。 */
  id: string;
  /** OCC 锚：改档 / 停用必须原样回传，冲突返 40901。 */
  version: number;
  /** 班次编码（唯一，重复后端拒 21902）。 */
  code: string;
  /** 班次名称。 */
  name: string;
  /** 班次色，可空 = 走页面默认色。 */
  color: string | null;
  /** 时段列表（**绝对时钟轴**，`HH ∈ 0..48`，逐档口径见 `types/hr.ts::ShiftSegmentOut`）。 */
  segments: ShiftSegmentOut[];
  /** 是否启用。停用是软删：行仍在库里，只是不再出现在新建考勤的选择项里。 */
  is_active: boolean;
  /** 排序权重，页面按它排班次栏。 */
  sort_order: number;
  /** 备注。 */
  remark: string | null;
  /** 派生：**任一段** `end > '24:00'` 即为 true（跨天班次）。 */
  cross_day: boolean;
  /** 派生：`max(end) - 24:00` 的**分钟数**，0 = 不跨天。与 `cross_day` 同源，前端不必自己算。
   *  ⚠️ 单位是**分钟不是小时**：段值允许带分钟（夜班收在 `26:30` 这种次日 02:30 的偏移），
   *  截成整小时会把 90 分钟溢出报成 1 小时，班次栏的「跨天 +N」标注随之失真。 */
  overflow_minutes: number;
  /** 派生：`Σ(end - start)`（分钟）。**跨天段按绝对差算**，与 `overflow_minutes` 各自独立。 */
  daily_minutes: number;
  /** 创建时间（后端 naive datetime 的字符串形态）。 */
  created_at: string;
  /** 末次更新时间。 */
  updated_at: string;
}

/** `GET /hr/shifts/{id}/calendar` 的行 VO（`ShiftCalendarDayOut`）。 */
export interface ShiftCalendarDayOut {
  /** 日历日 `'YYYY-MM-DD'`。 */
  cal_date: string;
  /** **全局日历**那天推导出来的日型（未叠加本班次覆盖）。 */
  global_day_type: HrDayType;
  /** 叠加**本班次**覆盖行之后的最终日型（渲染与判定都读它）。 */
  effective_day_type: HrDayType;
  /** 最终日型是否算上班（= `effective_day_type ∈ {WORKDAY, MAKEUP_WORKDAY}`，后端已算好）。 */
  is_workday: boolean;
  /** 该天是否有**本班次的覆盖行**（false = 直接沿用全局日历那天）。 */
  is_override: boolean;
}

/** 批量写日历端点的出参（端点 2 / 3 共用 `CalendarDaysWriteOut`、端点 9 / 10 共用
 *  `ShiftDaysWriteOut`，两者形状相同：都是 `{ affected }`）。 */
export interface HrCalendarWriteOut {
  /** 实际改动行数（upsert = `INSERT … ON CONFLICT DO UPDATE` 命中行数；delete = 被软删的
   *  显式行数）。
   *
   *  ⚠️ **delete 的 `0` 是合法成功**（那几天本来就没有显式行 / 覆盖行，删完本来就该落回推导
   *  值），不是错误；而 upsert 传空 `items` 落 21904 —— 两件事别混。 */
  affected: number;
}

/** `GET /hr/calendar/days` 的信封。 */
export interface HrCalendarDaysResult {
  items: CalendarDayOut[];
}

/** `GET /hr/shifts` 的信封。 */
export interface HrShiftListResult {
  items: ShiftOut[];
}

/** `GET /hr/shifts/{id}/calendar` 的信封。 */
export interface HrShiftCalendarResult {
  /** 所属班次 id（**JSON 字符串**，与 `ShiftOut.id` 同一把 `serialize_i64`）。后端给这一列是
   *  为了让前端画标题时不必回查一次列表。⚠️ 它在信封上而不在 `items` 里，漏声明会让
   *  `.strict()` 的守门每屏抛 `unrecognized_keys`（端点 8 100% 不可用）。 */
  shift_id: string;
  items: ShiftCalendarDayOut[];
}
