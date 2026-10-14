// src/views/wecom/daily/utils/__tests__/upcomingDaysLabel.spec.ts
//
// 2026-10-17 新建：「N 日内」列表头文案的守卫。守的是「表头不许说谎」这一条 —— 这一列数的是
// `upcoming_days` 范围内的工单，而 `upcoming_days` 是管理员可配的（后端 `meta.upcoming_days_range`
// 下发 1..60、默认 3）。表头写死「3日内」在管理员改成 7 天之后就成了一句假话，而它恰好是排查
// 「为什么逾期 / 近期数对不上」时第一眼看的列。
//
// 渲染层（label 绑到本函数的 computed、壳把 `form.upcoming_days` 传进来）由
// `__tests__/WeComLogTable.spec.ts` 的 C1 + D 组守；本文件守取值与回落本身。

import { describe, expect, it } from 'vitest';
import { WECOM_DAILY_DEFAULT_UPCOMING_DAYS, upcomingDaysLabel } from '../upcomingDaysLabel';

describe('upcomingDaysLabel', () => {
  it('L1：正常数值直接渲染成 `N日内`', () => {
    expect(upcomingDaysLabel(7)).toBe('7日内');
    expect(upcomingDaysLabel(3)).toBe('3日内');
    expect(upcomingDaysLabel(60)).toBe('60日内');
  });

  it('L2：字符串数字照样采用（输入组件与 v-model 之间的类型边界不该让表头说谎）', () => {
    expect(upcomingDaysLabel('7')).toBe('7日内');
    expect(upcomingDaysLabel(' 7 ')).toBe('7日内');
  });

  it('L3：空 / 非数字 / 非正数一律回落到后端默认的 `3日内`', () => {
    // `el-input-number` 被清空时给的是 `undefined`；wire 上也可能拿到空串或脏值。
    for (const bad of [undefined, null, '', '   ', Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(upcomingDaysLabel(bad)).toBe('3日内');
    }
    expect(WECOM_DAILY_DEFAULT_UPCOMING_DAYS).toBe(3);
  });

  it('L4：**任何输入都不会渲染出「日内」而前面没有数字的空标签**', () => {
    for (const bad of [undefined, null, '', '  ', Number.NaN]) {
      expect(upcomingDaysLabel(bad)).toMatch(/^\d+日内$/);
    }
  });
});
