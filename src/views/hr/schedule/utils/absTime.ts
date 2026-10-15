// src/views/hr/schedule/utils/absTime.ts
//
// 2026-10-19 新建：班次时段的**绝对时钟轴**换算与 V1–V6 镜像校验。纯函数、零 Vue 依赖
// （`ShiftTimeAxis.vue` 的拖拽预览 / `ShiftEditDialog.vue` 的保存闸门 / `hrScheduleSchema.ts`
// 的表单校验三处共用一份口径），所以可以直接单测。
//
// **绝对时钟轴**：段值是 `cal_date 00:00` 起算的偏移串 `'HH:MM'`，`HH ∈ 0..48`。夜班
// 22:00 → 次日 02:00 写 `'22:00'→'26:00'`，24h 连做写 `'08:00'→'32:00'`。由此「跨天班次的
// 日期归属 = 工作开始时间所在日」由数据结构本身保证，本文件**不做任何跨天推断**、不按
// `end <= start` 反推归属日 —— 那类启发式会与后端口径打架。
//
// ⚠️ **本文件的校验层是 UX、不是权威**：V1–V6 是后端 21903 / 21908 的**镜像**，作用是让用户
//   在浏览器里就看见问题（红字 + 保存禁用）而不是提交后吃一个业务码。后端仍是唯一判据，
//   本层漏判只影响体验、不影响落库数据；反过来前端**不能**比后端更宽（那会让用户以为合法
//   却一直提交失败）。
//
// ⚠️ **单位统一到「分钟」**：绝对偏移的唯一内部表示是自 `cal_date 00:00` 起的分钟数。
//   `HH ∈ 0..48` 所以上界是 2880（32 位正整数足够，不必上 BigInt）；段值允许带分钟，所以
//   **不能**用「小时 + 分钟」两级结构做算术（跨整点进位要在两处各写一遍）。

import type { ShiftSegmentOut } from '@/types/hr';

/** 一天分钟数（绝对轴 24:00 处的刻度）。 */
export const MINUTES_PER_DAY = 1440;

/** 绝对轴上界：`'48:00'` = 2880（V1 的硬上界）。 */
export const ABS_MAX_MINUTES = 48 * 60;

/** 后端允许的最多段数（V5 的硬上界）。 */
export const ABS_MAX_SEGMENTS = 6;

/** 段值格式：`HH` 一到两位、`MM` 两位且 `00..59`。**先卡格式再谈数值** —— `9:5` / `9:60`
 * 这类串不是「分钟数非法」而是「不是时刻」，两者给用户的提示不同。 */
const ABS_RE = /^([0-9]{1,2}):([0-5]\d)$/;

/** 一个绝对区间（分钟）。拖拽与冲突检测的通用货币形态。 */
export interface AbsRange {
  /** 起点分钟（含）。 */
  start: number;
  /** 终点分钟（不含，与后端「`start_{i+1} >= end_i`」的邻接口径一致）。 */
  end: number;
}

/** `'HH:MM'` → 自 `cal_date 00:00` 起的分钟数；格式非法或 `HH > 48` 返回 `null`。
 *
 *  ⚠️ **`null` 表示「读不出来」而不是「0」**：调用方必须区分「这一格没有值」与「这一格是
 *  零点」—— 前者不该渲染成 `00:00`（那是凭空造一个合法时刻）。 */
export function parseAbs(s: string): number | null {
  const m = ABS_RE.exec(s);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh * 60 + mm > ABS_MAX_MINUTES) return null;
  return hh * 60 + mm;
}

/** 分钟数 → `'HH:MM'`（小时两位补零）。超过 48:00 的值也照原样格式化（红字展示要用，
 *  截断会让「29:99」被显示成「05:39」而看不出超了）。 */
export function formatAbs(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 段列表的总跨度（分钟）= `max(end) - min(start)`，即 V6 的被测量。空列表给 0。 */
export function spanOf(segments: readonly ShiftSegmentOut[]): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const seg of segments) {
    const s = parseAbs(seg.start);
    const e = parseAbs(seg.end);
    if (s === null || e === null) continue;
    if (s < min) min = s;
    if (e > max) max = e;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}

/** V1–V6 镜像校验的结果。`errors` 逐条给「用户该改什么」的人话，不是错误码。 */
export interface SegmentValidation {
  /** true = 六条全过（前端可以放行提交）。 */
  ok: boolean;
  /** 逐条问题；同一类问题可能不止一条（例如两段都零长）。 */
  errors: string[];
}

/**
 * V1–V6 镜像校验（后端 21903 / 21908 的前端版，**UX 层不是权威判据**）：
 *
 *  - **V1** 每段 `0 ≤ start` 且 `end ≤ '48:00'`（含格式与上界）；
 *  - **V2** 每段 `start < end`（严格，零长段非法）；
 *  - **V3** 首段 `start < '24:00'`（班次必须在当日开始，否则日期归属失去意义）；
 *  - **V4** 按 `start` 升序且不重叠：相邻满足 `start_{i+1} >= end_i`（**邻接不算重叠**，
 *    `08:00~12:00` + `12:00~17:00` 合法）；
 *  - **V5** `1 ≤ 段数 ≤ 6`；
 *  - **V6** `max(end) - min(start) ≤ '24:00'`。V6 的用意：**跨日重叠 ⟺ span > 24h**，
 *    卡死它之后，相邻两日 / 隔日的班次实例在结构上不可能重叠（否则某个班次会同时占着
 *    两个日历日的那段时间）。
 */
export function validateSegments(segments: readonly ShiftSegmentOut[]): SegmentValidation {
  const errors: string[] = [];

  // V5：段数。先卡段数，避免下面按空数组判出一堆「不合法」。
  if (segments.length === 0) {
    return { ok: false, errors: ['至少需要 1 个时段'] };
  }
  if (segments.length > ABS_MAX_SEGMENTS) {
    errors.push(`时段最多 ${ABS_MAX_SEGMENTS} 个，当前 ${segments.length} 个`);
  }

  // V1 + V2：逐段可读性与零长。
  const readable: Array<{ start: number; end: number; index: number }> = [];
  for (const [index, seg] of segments.entries()) {
    const s = parseAbs(seg.start);
    const e = parseAbs(seg.end);
    const at = `第 ${index + 1} 段`;
    if (s === null) {
      errors.push(`${at}起点「${seg.start}」不是合法时刻（应为 HH:MM，小时 00..48）`);
      continue;
    }
    if (e === null) {
      errors.push(`${at}终点「${seg.end}」不是合法时刻（应为 HH:MM，小时 00..48）`);
      continue;
    }
    if (s >= e) {
      errors.push(`${at}「${seg.start} → ${seg.end}」时长为 0 或负，结束时刻必须晚于开始时刻`);
      continue;
    }
    readable.push({ start: s, end: e, index });
  }

  // V3：首段必须落在当日。后端按「首段 ≥ 24:00」拒（21903），这里给同款提示。
  const firstStart = parseAbs(segments[0]!.start);
  if (firstStart !== null && firstStart >= MINUTES_PER_DAY) {
    errors.push('第一个时段必须从当日开始（起点早于 24:00）');
  }

  // V4：升序 + 不重叠。按**输入顺序**判（后端按 `seq` 排完再比相邻区间，所以乱序同样拒）。
  for (let i = 1; i < readable.length; i += 1) {
    const prev = readable[i - 1]!;
    const cur = readable[i]!;
    if (cur.start < prev.start) {
      errors.push('时段必须按开始时刻从早到晚排列');
    } else if (cur.start < prev.end) {
      errors.push(
        `第 ${prev.index + 1} 段与第 ${cur.index + 1} 段重叠（${formatAbs(cur.start)} 早于上一段结束 ${formatAbs(prev.end)}）`,
      );
    }
  }

  // V6：总跨度。
  const span = spanOf(segments);
  if (span > MINUTES_PER_DAY) {
    errors.push(`班次跨度 ${formatAbs(span)} 超过 24:00（跨日班次会与相邻工作日冲突）`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 候选区间与已占用区间列表是否相交。**邻接不算相交**（`08:00~12:00` 与 `12:00~17:00`
 * 可以各画各的），与 V4 的 `>=` 判据同口径。
 *
 * @returns 相交的下标；无相交返回 `null`。
 */
export function findOverlap(candidate: AbsRange, occupied: readonly AbsRange[]): number | null {
  for (const [i, other] of occupied.entries()) {
    if (candidate.start < other.end && other.start < candidate.end) return i;
  }
  return null;
}

/** 把一段的绝对分钟转成 `{start, end}`；任一端不可读返回 `null`。 */
export function toAbsRange(seg: ShiftSegmentOut): AbsRange | null {
  const start = parseAbs(seg.start);
  const end = parseAbs(seg.end);
  if (start === null || end === null) return null;
  return { start, end };
}

/**
 * 时间轴**选择器态**。它是「墙钟 + 第几天」两元组，不是绝对偏移 —— 用户在 UI 上表达的是
 * 「几点到几点、结束于第几天」，绝对偏移是派生结果。
 */
export interface SegmentPickerState {
  /** 开始时刻（墙钟 `'HH:MM'`，`HH ∈ 0..23`）。 */
  start: string;
  /** 结束时刻（墙钟 `'HH:MM'`，`HH ∈ 0..23`）。 */
  end: string;
  /** 结束于第几天（0 = 当日 / 1 = 次日 / 2 = +2 日）。**显式**偏移，24h 连做的
   *  `08:00 → 次日 08:00` 靠它表达（靠 `end < start` 反推在这种情形下会失效）。 */
  endDay: 0 | 1 | 2;
}

/**
 * 选择器态 → 绝对分钟区间。
 *
 *  ⚠️ **起始侧没有「第几天」**：V3 要求首段从当日开始、V6 又把总跨度卡在 24:00 内，两者
 * 合起来蕴含**没有任何一段能起于次日或更晚**（起于 `24:00` 之后的段，减去最早的起点就已经
 * 超过 24:00）。所以 `start` 直接就是墙钟分钟，偏移只由 `endDay` 贡献。
 */
export function pickerToAbsRange(picker: SegmentPickerState): AbsRange | null {
  const s = parseAbs(picker.start);
  const e = parseAbs(picker.end);
  if (s === null || e === null) return null;
  const start = s;
  const end = e + picker.endDay * MINUTES_PER_DAY;
  return { start, end };
}

/**
 * ★ 选择器态 → 段列表的**唯一收口**：`ShiftTimeAxis.vue` 的每一次改动（拖拽新建、时间选择
 * 器改值、删段）都走这里，产出按 `start` 升序、`seq = 下标 + 1` 的段列表（用户不用管
 * `seq`，组件自己算）。
 *
 * 读不出 / 长度非正的项**直接丢掉**：选择器态允许出现中间态（用户刚把结束时刻改到开始
 * 时刻之前），丢弃比把它塞进列表里让用户对着一条红字发愣好。真正的判据在
 * `validateSegments`（V1–V6），它在提交前跑。
 */
export function pickerToSegments(pickers: readonly SegmentPickerState[]): ShiftSegmentOut[] {
  const ranges: AbsRange[] = [];
  for (const p of pickers) {
    const r = pickerToAbsRange(p);
    if (!r || r.end <= r.start) continue;
    ranges.push(r);
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges.map((r, i) => ({ seq: i + 1, start: formatAbs(r.start), end: formatAbs(r.end) }));
}

/** 段列表 → 选择器态（`ShiftTimeAxis.vue` 从 `modelValue` 反推编辑态用，逆向收口）。
 *
 *  墙钟取 `绝对分钟 mod 1440`，跨天数取 `floor(绝对分钟 / 1440)`；`48:00` 这个上界落在
 *  「+2 日 00:00」（`endDay` 的第 3 档）。 */
export function segmentsToPickers(segments: readonly ShiftSegmentOut[]): SegmentPickerState[] {
  const out: SegmentPickerState[] = [];
  for (const seg of segments) {
    const s = parseAbs(seg.start);
    const e = parseAbs(seg.end);
    if (s === null || e === null) continue;
    out.push({
      start: formatAbs(s % MINUTES_PER_DAY),
      end: formatAbs(e % MINUTES_PER_DAY),
      endDay: Math.min(2, Math.floor(e / MINUTES_PER_DAY)) as 0 | 1 | 2,
    });
  }
  return out;
}

/** 绝对分钟区间 → 选择器态（拖拽松手时用；与 `segmentsToPickers` 同口径）。 */
export function absRangeToPicker(range: AbsRange): SegmentPickerState {
  return {
    start: formatAbs(range.start % MINUTES_PER_DAY),
    end: formatAbs(range.end % MINUTES_PER_DAY),
    endDay: Math.min(2, Math.floor(range.end / MINUTES_PER_DAY)) as 0 | 1 | 2,
  };
}
