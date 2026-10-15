// src/views/hr/schedule/utils/__tests__/monthGrid.spec.ts
//
// 2026-10-19 新建：月历 42 格生成 + 日期串运算的单测。守住三条最容易回归的点：
//
//  1. **格数恒为 42**（6×7）：月视图不随月份高度跳变，翻月时格子位置不动；
//  2. **前后月补格标记**：补格 `inMonth=false`（灰显、不可点、不可拖选），判当月**同时看
//     月与年**（只看月份会把去年 12 月的补格误判成当月）；
//  3. **本地零点口径**：绝不 `new Date('YYYY-MM-DD')`（date-only 按 UTC 解读，东八区差一天）。
//
// ⚠️ 「本地零点」这条在本进程里看不出差异（TZ=UTC 时两种写法同解），所以下面额外用
// **显式构造**覆盖月初是周日 / 周一两种极端与跨年 —— 它们是补格逻辑真正的分支点。

import { describe, expect, it } from 'vitest';
import {
  MAX_LEADING_PAD,
  MONTH_GRID_CELLS,
  addDaysIso,
  buildMonthGrid,
  daysBetween,
  isoMinMax,
  monthBounds,
  parseLocalIso,
  toLocalIso,
} from '../monthGrid';

describe('buildMonthGrid — 格数与补格', () => {
  it('G1：**恒 42 格**，每格都带 `iso` / `day` / `weekday` / `inMonth`', () => {
    const cells = buildMonthGrid(2026, 10);
    expect(cells).toHaveLength(MONTH_GRID_CELLS);
    expect(MONTH_GRID_CELLS).toBe(42);
    for (const c of cells) {
      expect(c.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.day).toBeGreaterThanOrEqual(1);
      expect(c.day).toBeLessThanOrEqual(31);
      expect(c.weekday).toBeGreaterThanOrEqual(0);
      expect(c.weekday).toBeLessThanOrEqual(6);
      expect(typeof c.inMonth).toBe('boolean');
    }
  });

  it('G2：每周起始都是周日（第 0/7/14/… 格的 weekday 恒为 0）', () => {
    const cells = buildMonthGrid(2026, 10);
    // ⚠️ **只断言「每 7 格一循环」，别断言「每格都从周日递增」**：月初的补格数由那天是周几
    // 决定，weekday 序列是 `补格数 % 7` 起的循环（补格数 ≤ 6，所以补格数 0 的月份——月初是
    // 周日——才真的从周日开始）。断言后者会把这个正确行为判红。
    for (const c of cells) expect(c.weekday).toBe(cells.indexOf(c) % 7);
    for (const i of [0, 7, 14, 21, 28, 35]) expect(cells[i]!.weekday).toBe(0);
  });

  it('G3：**月初是周日 ⇒ 补 0 格**（首格就是 1 号且 inMonth）', () => {
    // 2024-06-01 是周六，2024-09-01 是周日 ⇒ 取后者（补 0 格的唯一形态）。
    const cells = buildMonthGrid(2024, 9);
    expect(cells[0]!.iso).toBe('2024-09-01');
    expect(cells[0]!.inMonth).toBe(true);
    // 30 天的九月：1..30 全部 inMonth，补格全部在后半月。
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
    expect(cells[30]!.inMonth).toBe(false);
    expect(cells[41]!.inMonth).toBe(false);
  });

  it('G4：**补格数的两个极端**（月初是周六 ⇒ 补 6 格；月初是周一 ⇒ 补 1 格）', () => {
    // 2024-06-01 是周六 ⇒ 往前补 6 格，首格落在 5 月最后一个周日（05-26）。
    const sat = buildMonthGrid(2024, 6);
    expect(MAX_LEADING_PAD).toBe(6);
    expect(sat[0]!.iso).toBe('2024-05-26');
    expect(sat[0]!.weekday).toBe(0);
    expect(sat.slice(0, 6).every((c) => !c.inMonth)).toBe(true);
    expect(sat[6]!.iso).toBe('2024-06-01');
    expect(sat[6]!.inMonth).toBe(true);
    expect(sat.filter((c) => c.inMonth)).toHaveLength(30);

    // 2024-07-01 是周一 ⇒ 只补 1 格（周日 06-30）。
    const mon = buildMonthGrid(2024, 7);
    expect(mon[0]!.iso).toBe('2024-06-30');
    expect(mon[0]!.inMonth).toBe(false);
    expect(mon[1]!.iso).toBe('2024-07-01');
    expect(mon.filter((c) => c.inMonth)).toHaveLength(31);
  });

  it('G5：**闰年 2 月**（29 天）与平年 2 月（28 天）的当月格数', () => {
    expect(buildMonthGrid(2024, 2).filter((c) => c.inMonth)).toHaveLength(29);
    expect(buildMonthGrid(2026, 2).filter((c) => c.inMonth)).toHaveLength(28);
  });

  it('G6：**跨年**（12 月与 1 月）：补格落到上一年 / 下一年，年份判定不能只看月份', () => {
    // 2026-12-01 是周二 ⇒ 前补 2 格（11-29 / 11-30）。
    const dec = buildMonthGrid(2026, 12);
    expect(dec[0]!.iso).toBe('2026-11-29');
    expect(dec[0]!.inMonth).toBe(false);
    expect(dec[41]!.inMonth).toBe(false);
    expect(dec.filter((c) => c.inMonth)).toHaveLength(31);

    // 2027-01-01 是周五 ⇒ 后补落到 2027-02。
    const jan = buildMonthGrid(2027, 1);
    expect(jan.filter((c) => c.inMonth)).toHaveLength(31);
    const tail = jan.filter((c) => !c.inMonth && c.iso > '2027-01-31');
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((c) => c.iso.startsWith('2027-02'))).toBe(true);
  });

  it('G7：**同月份的 1 月补格不会被误判成当月**（1 月与上一年 1 月的月份号相同）', () => {
    // 2025-01-01 是周三；2026-01-01 是周四。两次的补格都落在上一年 12 月。
    const cells = buildMonthGrid(2025, 1);
    const pad = cells.filter((c) => !c.inMonth && c.iso < '2025-01-01');
    expect(pad.length).toBe(3);
    expect(pad.every((c) => c.iso.startsWith('2024-12'))).toBe(true);
  });
});

describe('日期串运算 — 本地零点口径', () => {
  it('D1：parseLocalIso / toLocalIso 往返一致（不带时分秒）', () => {
    const d = parseLocalIso('2026-10-19');
    expect(d).not.toBeNull();
    expect(toLocalIso(d!)).toBe('2026-10-19');
    // 本地零点：时区偏移是整小时，东八区为 +8 ⇒ 本地零点 ≠ UTC 零点。
    expect(d!.getHours()).toBe(0);
  });

  it('D2：非法串返回 null / 空串（调用方按「无值」处理）', () => {
    expect(parseLocalIso('')).toBeNull();
    expect(parseLocalIso('2026/10/19')).toBeNull();
    expect(addDaysIso('x', 1)).toBe('');
    expect(daysBetween('x', '2026-10-19')).toBe(0);
  });

  it('D3：addDaysIso 跨月 / 跨年', () => {
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysIso('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('D4：daysBetween（`from` → `to`）与 isoMinMax（拖选浮条与 366 天夹紧用）', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    // 反序传就是负数：调用方据此判「区间反了」。
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
    expect(isoMinMax('2026-10-31', '2026-10-01')).toEqual(['2026-10-01', '2026-10-31']);
  });

  it('D5：monthBounds 给当月首末日（查询端点的 from / to 就是它）', () => {
    expect(monthBounds(2026, 10)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthBounds(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
});
