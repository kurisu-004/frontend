// src/utils/__tests__/naiveDateTime.spec.ts
//
// 2026-10-21 迁入（原先在 `views/wecom/utils/__tests__/naiveDateTime.spec.ts`）：naive 时间
// 切片的口径守卫。两条不变量：
//
//  1. **不做时区平移**：后端这些列下发的是**不带时区后缀**的 naive 字符串（Asia/Shanghai
//     墙钟），显示什么就切什么。踩过的坑是走 `utils/date.ts::formatDateTime` —— 那个函数
//     `new Date()` 后按 UTC 输出，`08:30` 会变成 `00:30`，整整 8 小时。
//  2. **四个消费点共用一份**（账号管理「最后登录」/ 邮件发送历史 / 每日总结发送历史 /
//     Webhook 列表「更新时间」）。格式不同时，切 tab / 切页面时用户没法判断两处是不是同一次操作。

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
