// src/views/hr/schedule/utils/dayType.ts
//
// 2026-10-19 新建：6 档日型在本页的展示元数据（中文标签 / 色板键 / 是否工作日 / 班次跨天标注）。
//
// ⚠️ **枚举真源是 `@/types/hr`**：本文件只做「展示层取数」，**不再声明第二份 6 档字面量数组**
//   ——`HR_DAY_TYPES` 提供顺序（`HR_DAY_TYPE_META` 是无序的对象，字面量键序不该拿来当
//   展示顺序），标签 / 色板键 / 工作日判定一律从 `HR_DAY_TYPE_META` 读。防漂移由
//   `__tests__/utils/dayType.spec.ts` 的「逐字相同」那条钉死。
//
// ⚠️ **颜色字面量不在本文件**：`HR_DAY_TYPE_META.colorKey` 是**色板键**（`workday` /
//   `rest` / …），具体颜色映射写在 `components/ScheduleDayCell.vue` 的 scoped scss 里
//   （`--primary-color` / `--primary-light` / `--primary-lighter` 三个主题色来自
//   `src/styles/variables.scss` 的 `:root`）。types 层放颜色会让纯类型文件反向依赖样式口径，
//   而样式集中在组件里才能随主题一起改。

import { HR_DAY_TYPE_META, HR_DAY_TYPES, isHrWorkday, type HrDayType } from '@/types/hr';
import { MINUTES_PER_DAY } from './absTime';

export type { HrDayType };

/** 一个下拉 / 图例项（日型 + 它的展示元数据）。 */
export interface DayTypeOption {
  value: HrDayType;
  /** 中文标签（后端 message 是给日志看的，图例与下拉一律用这个）。 */
  label: string;
  /** 色板键，对应 `ScheduleDayCell.vue` 里的 `.dt-*` 类。 */
  colorKey: string;
  /** 是否算上班（= `isHrWorkday(value)`，图例分组与浮条判定同源）。 */
  workday: boolean;
}

/** 6 档日型的展示选项，顺序即 `HR_DAY_TYPES` 的顺序。 */
export const HR_DAY_TYPE_OPTIONS: readonly DayTypeOption[] = HR_DAY_TYPES.map((value) => ({
  value,
  label: HR_DAY_TYPE_META[value].label,
  colorKey: HR_DAY_TYPE_META[value].colorKey,
  workday: isHrWorkday(value),
}));

/** 中文标签。未知值回落到原样输出（**不抛**）：日型来自后端，守门在 Zod 那层，
 * 这里的非穷尽分支只服务于「标签渲染不出来」时不至于白屏。 */
export function dayTypeLabel(dayType: HrDayType): string {
  return HR_DAY_TYPE_META[dayType]?.label ?? String(dayType);
}

/** 色板键（`.dt-${key}` 的 key 部分）。 */
export function dayTypeColorKey(dayType: HrDayType): string {
  return HR_DAY_TYPE_META[dayType]?.colorKey ?? 'rest';
}

/** 是否算上班。**转发 `@/types/hr` 的 `isHrWorkday`**，本页只此一处入口，判据改一处即可。 */
export function isWorkdayDayType(dayType: HrDayType): boolean {
  return isHrWorkday(dayType);
}

/** 该日型是否**必须**带名称（`CUSTOM_LEAVE` 缺名后端拒 21907）。 */
export function dayTypeNeedsName(dayType: HrDayType): boolean {
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
