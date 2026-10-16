// src/views/hr/schedule/utils/dayType.ts
//
// 2026-10-19 新建：6 档日型在本页的展示元数据（中文标签 / 是否工作日 / 班次跨天标注）。
//
// ⚠️ **枚举真源是 `@/types/hr`**：本文件只做「展示层取数」，**不再声明第二份 6 档字面量数组**
//   ——`HR_DAY_TYPES` 提供顺序（`HR_DAY_TYPE_META` 是无序的对象，字面量键序不该拿来当
//   展示顺序），标签 / 工作日判定一律从 `HR_DAY_TYPE_META` 读。防漂移由
//   `views/hr/schedule/utils/__tests__/dayType.spec.ts` 的「逐字相同」那条钉死。
//
// ⚠️ **颜色字面量不在本文件**：`el-tag` 的 5 个 `type`（primary / success / info / warning /
//   danger）就是颜色口径，本文件只做「日型 → type」的映射，具体配色由 Element Plus 主题给。
//   班次色是另一套（用户自己填的 `#rrggbb`），与日型无关。

import { HR_DAY_TYPE_META, HR_DAY_TYPES, isHrWorkday, type HrDayType } from '@/types/hr';
import { MINUTES_PER_DAY } from './absTime';

export type { HrDayType };

/** 一个下拉 / 图例项（日型 + 它的展示元数据）。 */
export interface DayTypeOption {
  value: HrDayType;
  /** 中文标签（后端 message 是给日志看的，图例与下拉一律用这个）。 */
  label: string;
  /** 是否算上班（= `isHrWorkday(value)`，图例分组与浮条判定同源）。 */
  workday: boolean;
}

/** 6 档日型的展示选项，顺序即 `HR_DAY_TYPES` 的顺序。 */
export const HR_DAY_TYPE_OPTIONS: readonly DayTypeOption[] = HR_DAY_TYPES.map((value) => ({
  value,
  label: HR_DAY_TYPE_META[value].label,
  workday: isHrWorkday(value),
}));

/** 中文标签。未知值回落到原样输出（**不抛**）：日型来自后端，守门在 Zod 那层，
 *  这里的非穷尽分支只服务于「标签渲染不出来」时不至于白屏。 */
export function dayTypeLabel(dayType: HrDayType): string {
  return HR_DAY_TYPE_META[dayType]?.label ?? String(dayType);
}

/** 格内日型徽标用的 `el-tag` `type`（Element Plus 只给 5 档，元素与取值见其文档）。 */
export type DayTypeTagType = 'primary' | 'success' | 'info' | 'warning' | 'danger';

/**
 * 6 档日型 → `el-tag` 的 `type`，**全页唯一一处**（`ScheduleDayCell` 只读这个函数，
 *  不在组件里另抄一份映射）。
 *
 * ⚠️ **6 档挤 5 个 type 是已定的取舍**：`REST_DAY`（休息日）与 `MAKEUP_HOLIDAY`（调休放假）
 *   同落 `info` —— 丢掉两者的颜色区分（原先也都是灰系，区分度本就极低），靠徽标上的**文字**
 *   区分（`休息日` / `调休放假`）。反过来 `MAKEUP_WORKDAY`（调休上班）与 `WORKDAY` 分开，
 *   因为「这天本该休却要上班」是排班员最需要一眼看到的那类日子。
 * ⚠️ **无数据（`dayType === null`）给 `info` 而不是 `primary`**：给 `primary` 会把「这条
 *   没返数据」渲染成「这天照常上班」，用户照着改日型时判断依据是错的。
 */
const DAY_TYPE_TAG_TYPE: Record<HrDayType, DayTypeTagType> = {
  WORKDAY: 'primary',
  MAKEUP_WORKDAY: 'success',
  REST_DAY: 'info',
  MAKEUP_HOLIDAY: 'info',
  STATUTORY_HOLIDAY: 'danger',
  CUSTOM_LEAVE: 'warning',
};

export function dayTypeTagType(dayType: HrDayType | null): DayTypeTagType {
  return dayType ? (DAY_TYPE_TAG_TYPE[dayType] ?? 'info') : 'info';
}

/** 是否算上班。**转发 `@/types/hr` 的 `isHrWorkday`**，本页只此一处入口，判据改一处即可。 */
export function isWorkdayDayType(dayType: HrDayType): boolean {
  return isHrWorkday(dayType);
}

/**
 * 该日型**能不能**填名称。
 *
 *  两档收名称，理由不同：`CUSTOM_LEAVE` 是「自定义休息日说明」，`STATUTORY_HOLIDAY` 是
 *  「节假日名」（"国庆节"、"春节"）—— 后者就是这列的原始用途，不给它填等于把这一档的语义
 *  堵死（口径见 `docs/api/hr.md` §3.3 / §4.1：`name` 的出参语义原文就是「节假日名 / 休息日
 *  说明」）。其余四档没有可填的东西。
 */
export function dayTypeAcceptsName(dayType: HrDayType): boolean {
  return dayType === 'CUSTOM_LEAVE' || dayType === 'STATUTORY_HOLIDAY';
}

/**
 * 该日型**是否必须**带名称。
 *
 *  ⚠️ **只有 `CUSTOM_LEAVE` 必填**：后端 `CalendarDayUpsertItem.name` 是 `Option<String>`，
 *   缺名只在 `CUSTOM_LEAVE` 上落 `21907`，法定节假日不填照样入库（`service.rs`
 *   `upsert_calendar_days` 的缺名闸门只判 `CustomLeave`）。所以「能填」与「必填」必须分开判：
 *   把法定节假日混进必填里，就是前端凭空拒一条后端允许的写。
 */
export function dayTypeRequiresName(dayType: HrDayType): boolean {
  return dayType === 'CUSTOM_LEAVE';
}

/**
 * 班次的跨天标注（班次栏那一行的 `+N天`）。
 *
 *  ⚠️ **用 `overflow_minutes` 而不是自己按段值算**：它是后端与 `cross_day` 同源的派生值，
 *   省掉前端对 `max(end) > 24:00` 的重复实现（两处各算一次，早晚漂）。不足一天按小时写
 *   （夜班收在次日 02:00 是 `+2h`，写 `+0天` 等于没标）。
 *
 * @param overflowMinutes `ShiftOut.overflow_minutes`（`max(end) - 24:00` 的分钟数）。
 * @returns 不跨天时是空串（调用方直接当「无标注」渲染）。
 */
export function crossDayText(overflowMinutes: number): string {
  if (!Number.isFinite(overflowMinutes) || overflowMinutes <= 0) return '';
  if (overflowMinutes < MINUTES_PER_DAY) {
    return `跨天 +${Math.round(overflowMinutes / 60)}h`;
  }
  return `跨天 +${Math.floor(overflowMinutes / MINUTES_PER_DAY)}天`;
}

/** 班次工作时长的人话（`ShiftOut.daily_minutes`）：`8h` / `8h30m`。分钟为 0 时给空串。 */
export function dailyMinutesText(dailyMinutes: number): string {
  if (!Number.isFinite(dailyMinutes) || dailyMinutes <= 0) return '';
  const h = Math.floor(dailyMinutes / 60);
  const m = Math.round(dailyMinutes % 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}
