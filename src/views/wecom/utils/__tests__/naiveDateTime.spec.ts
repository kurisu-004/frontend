// src/views/wecom/utils/__tests__/naiveDateTime.spec.ts
//
// 2026-10-17 新建：`formatNaiveDateTime` 的口径守卫。两条不变量：
//
//  1. **不做时区平移**：后端这些列下发的是**不带时区后缀**的 naive 字符串（Asia/Shanghai
//     墙钟），显示什么就切什么。踩过的坑是走 `utils/date.ts::formatDateTime` —— 那个函数
//     `new Date()` 后按 UTC 输出，`08:30` 会变成 `00:30`，整整 8 小时。
//  2. **同域两张表共用一份**：日志表的「时间」列与 Webhook 列表的「更新时间」列渲染的是同一种
//     字段（两张表分属 `WeComCenter` 的两个 tab）。两种格式（一边带秒一边不带）没法让人判断两处
//     是不是同一次操作。

import { describe, expect, it } from 'vitest';
import { formatNaiveDateTime } from '../naiveDateTime';

describe('formatNaiveDateTime', () => {
  it('T1：常规形态切成 `YYYY-MM-DD HH:MM`（秒被截掉）', () => {
    expect(formatNaiveDateTime('2026-10-17 08:30:15')).toBe('2026-10-17 08:30');
    expect(formatNaiveDateTime('2026-10-17T08:30:15')).toBe('2026-10-17 08:30');
  });

  it('T2：**不**做时区平移（`08:30` 不能变成 `00:30`）', () => {
    // 这条是「不引 utils/date.ts」那条纪律的可执行形态。
    expect(formatNaiveDateTime('2026-10-17 08:30:00')).toContain('08:30');
    expect(formatNaiveDateTime('2026-10-17 00:00:00')).toBe('2026-10-17 00:00');
  });

  it('T3：空值给 `-`（不是空串 —— 空白格与「没这个值」在排查时不是一回事）', () => {
    expect(formatNaiveDateTime(null)).toBe('-');
    expect(formatNaiveDateTime(undefined)).toBe('-');
    expect(formatNaiveDateTime('')).toBe('-');
  });

  it('T4：短于 16 位的输入原样返回（不补零、不抛 —— 这一列是线索不是校验闸门）', () => {
    expect(formatNaiveDateTime('2026-10-17')).toBe('2026-10-17');
    expect(formatNaiveDateTime('08:30')).toBe('08:30');
  });
});
