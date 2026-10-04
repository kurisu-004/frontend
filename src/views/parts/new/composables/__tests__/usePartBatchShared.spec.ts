// 2026-10-05 新增：usePartBatchShared 纯函数单测 —— toMoneyString。
//
// 锁的是「含税单价 / 总价 → 后端 Decimal 契约字符串」这条边界：
// 建单入参是 rust rust_decimal + serde-with-str，只认字符串，且列标度固定 2 位。
// 表格里的总价是裸浮点乘出来的（0.1 * 3 === 0.30000000000000004），直接 String()
// 发出去会被 Decimal 如实解析成 13 位小数 —— 这条 helper 是唯一的收口点。
import { describe, expect, it } from 'vitest';

import { toMoneyString } from '../usePartBatchShared';

describe('toMoneyString', () => {
  it('缺价（null / undefined / NaN / ±Infinity）→ undefined，让调用方不发该键', () => {
    expect(toMoneyString(null)).toBeUndefined();
    expect(toMoneyString(undefined)).toBeUndefined();
    expect(toMoneyString(Number.NaN)).toBeUndefined();
    expect(toMoneyString(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toMoneyString(Number.NEGATIVE_INFINITY)).toBeUndefined();
    // 不能折成 '0'：那会把「用户没填价」和「用户明确填了 0 元」混成同一个语义
    expect(toMoneyString(null)).not.toBe('0');
  });

  it('浮点尾数被抹平（0.1 * 3 = 0.30000000000000004）', () => {
    // 先证明这个坑真实存在：裸乘确实有 17 位尾数
    expect(String(0.1 * 3)).toBe('0.30000000000000004');
    expect(toMoneyString(0.1 * 3)).toBe('0.30');
    // String() 会把这串尾数原样发出去，被 Decimal 如实解析
    expect(toMoneyString(0.1 * 3)).not.toBe(String(0.1 * 3));
  });

  it('补齐到固定 2 位小数（整数 / 1 位小数都补零）', () => {
    expect(toMoneyString(0)).toBe('0.00');
    expect(toMoneyString(95)).toBe('95.00');
    expect(toMoneyString(1.5)).toBe('1.50');
    expect(toMoneyString(0.1)).toBe('0.10');
    // 已带 2 位：幂等
    expect(toMoneyString(95.25)).toBe('95.25');
    expect(toMoneyString(0.3)).toBe('0.30');
  });

  it('超过 2 位按四舍五入截到 2 位（对齐 NUMERIC(12,2) 标度）', () => {
    expect(toMoneyString(1.005)).toBe('1.00');
    expect(toMoneyString(1.006)).toBe('1.01');
    expect(toMoneyString(12.345)).toBe('12.35');
    expect(toMoneyString(12.344)).toBe('12.34');
    // 输出恒为 2 位小数：不允许出现 '12' / '12.3' 这类短形态
    for (const n of [0, 1, 12, 123, 1234, 0.5, 12.5]) {
      expect(toMoneyString(n)).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('负值保留符号（表里有 min=0 兜底，但 helper 自身不吞符号）', () => {
    expect(toMoneyString(-1.5)).toBe('-1.50');
  });
});
