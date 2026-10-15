// src/views/hr/schedule/utils/__tests__/absTime.spec.ts
//
// 2026-10-19 新建：绝对时钟轴换算与 V1–V6 镜像校验的纯函数单测。本域最容易错的地方就在
// 这个文件覆盖的三件事上：
//
//  1. **`'HH:MM'` ⇄ 分钟**的换算与格式判据（`48:30` 必须拒收、`24:00` 与 `48:00` 必须放行）；
//  2. **V1–V6 的边界**（零长段 / 乱序 / 重叠 / 邻接 / 段数 / 跨度恰好 24:00 与超 1 分钟）；
//  3. **picker ⇄ 段列表的收口**（`seq = 下标 + 1`、按 `start` 升序、坏行丢弃）。
//
// 单元全跑 node 环境（无 Vue 依赖是本文件能被这么直接测的前提）。

import { describe, expect, it } from 'vitest';
import {
  ABS_MAX_MINUTES,
  MINUTES_PER_DAY,
  absRangeToPicker,
  findOverlap,
  formatAbs,
  parseAbs,
  pickerToSegments,
  segmentsToPickers,
  spanOf,
  toAbsRange,
  validateSegments,
  type SegmentPickerState,
} from '../absTime';
import type { ShiftSegmentOut } from '@/types/hr';

/** 造一段（`seq` 由调用方给，本文件显式写出来便于断言）。 */
function seg(seq: number, start: string, end: string): ShiftSegmentOut {
  return { seq, start, end };
}

/** V1–V6 全过的合法基准（白班两段）。 */
const WHITE_SHIFT = [seg(1, '08:00', '12:00'), seg(2, '13:00', '17:00')];

describe('parseAbs / formatAbs — 换算与格式判据', () => {
  it('P1：常规换算（00:00 / 08:30 / 23:00）', () => {
    expect(parseAbs('00:00')).toBe(0);
    expect(parseAbs('08:30')).toBe(510);
    expect(parseAbs('23:00')).toBe(1380);
    expect(formatAbs(0)).toBe('00:00');
    expect(formatAbs(510)).toBe('08:30');
    expect(formatAbs(1380)).toBe('23:00');
  });

  it('P2：绝对轴跨天值放行到 48:00（HH ≤ 48）', () => {
    expect(parseAbs('24:00')).toBe(MINUTES_PER_DAY);
    expect(parseAbs('26:00')).toBe(1560);
    expect(parseAbs('48:00')).toBe(ABS_MAX_MINUTES);
    expect(formatAbs(1560)).toBe('26:00');
    expect(formatAbs(ABS_MAX_MINUTES)).toBe('48:00');
  });

  it('P3：`48:30` / `49:00` 拒收（HH > 48）', () => {
    expect(parseAbs('48:30')).toBeNull();
    expect(parseAbs('49:00')).toBeNull();
    expect(parseAbs('99:00')).toBeNull();
  });

  it('P4：格式非法拒收（缺分 / 分钟越界 / 负号 / 多位数小时之外的东西）', () => {
    for (const bad of ['', '8', '8:0', '0800', '24:60', '-1:00', 'abc', '08:00:00', ' 08:00']) {
      expect(parseAbs(bad), `「${bad}」应当被拒`).toBeNull();
    }
  });

  it('P5：小时允许一位（`8:05`），小时补零格式化（`formatAbs(485)` → `08:05`）', () => {
    expect(parseAbs('8:05')).toBe(485);
    expect(formatAbs(485)).toBe('08:05');
  });

  it('P6：往返一致（分钟 → 串 → 分钟）', () => {
    for (const m of [0, 15, 485, 1380, 1440, 1560, 2880]) {
      expect(parseAbs(formatAbs(m))).toBe(m);
    }
  });
});

describe('spanOf / validateSegments — V1–V6 镜像', () => {
  it('V0：合法白班两段全过', () => {
    const res = validateSegments(WHITE_SHIFT);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('V1：段值越界（`00:00~48:30`）被判红', () => {
    const res = validateSegments([seg(1, '00:00', '48:30')]);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('48:30');
  });

  it('V2：零长段（`08:00 → 08:00`）被判红', () => {
    const res = validateSegments([seg(1, '08:00', '08:00')]);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('时长为 0');
  });

  it('V3：首段起于 `24:00` 之后被判红（`24:00 → 26:00`）', () => {
    const res = validateSegments([seg(1, '24:00', '26:00')]);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('当日开始');
  });

  it('V4a：重叠被判红（`08:00~12:00` 与 `11:00~13:00`）', () => {
    const res = validateSegments([seg(1, '08:00', '12:00'), seg(2, '11:00', '13:00')]);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('重叠');
  });

  it('V4b：**邻接不算重叠**（`08:00~12:00` + `12:00~17:00` 合法）', () => {
    const res = validateSegments([seg(1, '08:00', '12:00'), seg(2, '12:00', '17:00')]);
    expect(res.ok).toBe(true);
  });

  it('V4c：乱序被判红（`13:00~17:00` 排在 `08:00~12:00` 前面）', () => {
    const res = validateSegments([seg(1, '13:00', '17:00'), seg(2, '08:00', '12:00')]);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('从早到晚');
  });

  it('V5a：空数组判红', () => {
    const res = validateSegments([]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(['至少需要 1 个时段']);
  });

  it('V5b：7 段判红（超过 6 段上限）', () => {
    const segs: ShiftSegmentOut[] = [];
    for (let i = 0; i < 7; i += 1) {
      const h = String(i * 2).padStart(2, '0');
      segs.push(seg(i + 1, `${h}:00`, `${String(i * 2 + 1).padStart(2, '0')}:00`));
    }
    const res = validateSegments(segs);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('最多 6 个');
  });

  it('V6a：跨度**恰好 24:00** 放行（`00:00 → 24:00`）', () => {
    const res = validateSegments([seg(1, '00:00', '24:00')]);
    expect(res.ok).toBe(true);
    expect(spanOf([seg(1, '00:00', '24:00')])).toBe(MINUTES_PER_DAY);
  });

  it('V6b：跨度**超 1 分钟**判红（`00:00 → 24:01`）', () => {
    const res = validateSegments([seg(1, '00:00', '24:01')]);
    expect(res.ok).toBe(false);
    expect(res.errors.join('；')).toContain('超过 24:00');
  });

  it('V6c：`08:00 → 32:00`（24h 连做）跨度恰好 24:00，放行', () => {
    const res = validateSegments([seg(1, '08:00', '32:00')]);
    expect(res.ok).toBe(true);
    expect(spanOf([seg(1, '08:00', '32:00')])).toBe(MINUTES_PER_DAY);
  });

  it('跨天夜班 `22:00 → 26:00` 放行，跨度 04:00', () => {
    expect(validateSegments([seg(1, '22:00', '26:00')]).ok).toBe(true);
    expect(spanOf([seg(1, '22:00', '26:00')])).toBe(240);
  });

  it('带分钟的段值（`18:00 → 次日 04:30`）按绝对差算跨度', () => {
    expect(spanOf([seg(1, '18:00', '28:30')])).toBe(630);
    expect(validateSegments([seg(1, '18:00', '28:30')]).ok).toBe(true);
  });

  it('spanOf：空列表给 0（不是 NaN / -Infinity）', () => {
    expect(spanOf([])).toBe(0);
  });

  it('toAbsRange：读不出的段给 null（而不是半个区间）', () => {
    expect(toAbsRange(seg(1, '8:0', '17:00'))).toBeNull();
    expect(toAbsRange(seg(1, '08:00', '17:00'))).toEqual({ start: 480, end: 1020 });
  });
});

describe('findOverlap — 相交 / 邻接', () => {
  const occupied = [
    { start: 480, end: 720 }, // 08:00–12:00
    { start: 780, end: 1020 }, // 13:00–17:00
  ];

  it('O1：命中第一个重叠段返回它的下标', () => {
    expect(findOverlap({ start: 600, end: 800 }, occupied)).toBe(0);
    expect(findOverlap({ start: 900, end: 1100 }, occupied)).toBe(1);
  });

  it('O2：邻接不算相交（贴着起 / 贴着止都不算）', () => {
    expect(findOverlap({ start: 240, end: 480 }, occupied)).toBeNull();
    expect(findOverlap({ start: 720, end: 780 }, occupied)).toBeNull();
    expect(findOverlap({ start: 1020, end: 1200 }, occupied)).toBeNull();
  });

  it('O3：完全不相交给 null；跨日候选照样判', () => {
    expect(findOverlap({ start: 0, end: 60 }, occupied)).toBeNull();
    expect(findOverlap({ start: 1320, end: 1500 }, occupied)).toBeNull(); // 22:00→次日 01:00
  });
});

describe('pickerToSegments / segmentsToPickers / absRangeToPicker — 收口', () => {
  const pickers: SegmentPickerState[] = [
    { start: '22:00', end: '02:00', endDay: 1 },
    { start: '08:00', end: '12:00', endDay: 0 },
  ];

  it('K1：**按 start 升序**排好并重编 `seq = 下标 + 1`', () => {
    expect(pickerToSegments(pickers)).toEqual([
      { seq: 1, start: '08:00', end: '12:00' },
      { seq: 2, start: '22:00', end: '26:00' },
    ]);
  });

  it('K2：`endDay` 折成绝对偏移（次日 → +1440 分钟）', () => {
    expect(pickerToSegments([{ start: '08:00', end: '08:00', endDay: 1 }])).toEqual([
      { seq: 1, start: '08:00', end: '32:00' },
    ]);
  });

  it('K3：零长 / 读不出的行被**丢弃**（不进列表）', () => {
    expect(pickerToSegments([{ start: '9:0', end: '10:00', endDay: 0 }])).toEqual([]);
    // 同一时刻且 endDay=0 ⇒ 绝对差 0 ⇒ 丢弃（24h 连做要显式写 endDay=1，判据见 K2）
    expect(pickerToSegments([{ start: '08:00', end: '08:00', endDay: 0 }])).toEqual([]);
  });

  it('K4：产出物一定过 V1–V6（收口的净输出不是「大致有序」）', () => {
    const produced = pickerToSegments(pickers);
    expect(validateSegments(produced).ok).toBe(true);
  });

  it('K5：逆向（segmentsToPickers）往返一致', () => {
    const segs = pickerToSegments(pickers);
    expect(segmentsToPickers(segs)).toEqual([
      { start: '08:00', end: '12:00', endDay: 0 },
      { start: '22:00', end: '02:00', endDay: 1 },
    ]);
  });

  it('K6：跨两天的段（`08:00 → 32:00`）反推仍是 `endDay=1`', () => {
    expect(segmentsToPickers([seg(1, '08:00', '32:00')])).toEqual([
      { start: '08:00', end: '08:00', endDay: 1 },
    ]);
  });

  it('K7：absRangeToPicker 与 segmentsToPickers 同口径（拖拽新建走前者）', () => {
    expect(absRangeToPicker({ start: 1560, end: 1800 })).toEqual({
      start: '02:00',
      end: '06:00',
      endDay: 1,
    });
  });
});
