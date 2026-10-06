// src/utils/__tests__/deliveryDate.spec.ts
//
// 交期天数/紧迫样式的**绝对输出**回归锁。
//
// 为什么值得单独立一个文件：报工台 HMI 上「昨天到期的件不显红」这类问题没有报错、不会
// 有人发现，而仓内原有的交期断言全部走「形状」口径（有没有 `.days-left`、有没有
// `overdue` class），对天数**算得对不对**零覆盖。本文件是全仓唯一按 TZ 两档锁定
// 「今天到期 / 已逾期 N 天 / N 天后到期」**具体字符串**的地方。
//
// 两档 TZ 锁同一个算法是刻意的：日期串按**本地零点**构造（`new Date('YYYY-MM-DD')`
// 按 UTC 零点解读会让东八区恒多算一天），故算法与时区无关 —— 下面两档给出**逐字相同**
// 的期望值。任一档变红都意味着「本地零点口径」被破坏，而不是「时区差异」。
//
// 固定 TZ 的方式（本仓 vitest.config.ts 没有全局 `test.env` 段，见下）：在 `withTz` 里
// 直接赋值 `process.env.TZ`，**且必须早于 `vi.useFakeTimers()`** —— 假 Date 装好后
// 换 TZ 不再生效（sinon 的 fake Date 会把时区偏移固定在安装那一刻）。所以「设 TZ → 装
// 假表 → 跑断言」三步必须包在同一个 helper 里，每个用例重装一次。
// 不写进 vitest.config.ts 的 `test.env`：那会一次性改掉全仓所有 spec 的时区基线，
// 超出本文件职责。「今天」用 `vi.setSystemTime` 钉到固定日历日，避免跨日那一刻集体变红。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliveryDaysLeftText, deliveryUrgencyClass } from '../deliveryDate';

/** 固定「今天」= 2026-10-04（本地零点）。`new Date(2026, 9, 4)` 按本地时区构造。 */
const FIXED_TODAY = new Date(2026, 9, 4, 0, 0, 0);
/** 钉住时区期间要还原的环境变量原值。 */
let originalTz: string | undefined;

/**
 * 在指定时区下跑一段断言。顺序不可调换：设 TZ 必须在装假表之前。
 * 「今天」在假表下恒为 FIXED_TODAY，日期串则用**本地日历分量**从 FIXED_TODAY 推出来 ——
 * 两种时区下推出来的都是同一个真实日历日（这是本文件要的：只让时区影响
 * `deliveryDate` 自己的算术，不让日期串本身随时区漂移）。
 */
function withTz(tz: string, run: (isoDaysFromToday: (n: number) => string) => void): void {
  process.env.TZ = tz;
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TODAY);
  const isoDaysFromToday = (n: number): string => {
    const d = new Date(FIXED_TODAY.getTime() + n * 86400000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  };
  try {
    run(isoDaysFromToday);
  } finally {
    vi.useRealTimers();
  }
}

/** 同一批真实日历日在两种时区下的期望输出（本地零点口径 ⇒ 与时区无关）。 */
function assertCalendarDaySemantics(iso: (n: number) => string): void {
  // 今天到期
  expect(deliveryDaysLeftText(iso(0))).toBe('今天到期');
  expect(deliveryUrgencyClass(iso(0))).toBe('due-soon');
  // 今天+2
  expect(deliveryDaysLeftText(iso(2))).toBe('2天后到期');
  expect(deliveryUrgencyClass(iso(2))).toBe('due-soon');
  // 昨天到期：必须是「已逾期1天」+ overdue（红）。这条是本文件的核心回归 ——
  // 按 UTC 零点解读时它会退化成「今天到期」+ due-soon，产线屏上过期件不显红。
  expect(deliveryDaysLeftText(iso(-1))).toBe('已逾期1天');
  expect(deliveryUrgencyClass(iso(-1))).toBe('overdue');
  // 5 天前逾期
  expect(deliveryDaysLeftText(iso(-5))).toBe('已逾期5天');
  expect(deliveryUrgencyClass(iso(-5))).toBe('overdue');
  // due-soon 的实际覆盖窗口（真实日历日）：今天 ~ 今天+3；今天+4 起无紧迫样式
  expect(deliveryUrgencyClass(iso(3))).toBe('due-soon');
  expect(deliveryUrgencyClass(iso(4))).toBe('');
  // >3 天不倒计时（只回落到 MM/DD 展示）
  expect(deliveryDaysLeftText(iso(9))).toBe('');
}

describe('deliveryDate 天数口径（本地零点，两档 TZ 期望逐字相同）', () => {
  beforeEach(() => {
    originalTz = process.env.TZ;
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('TZ=Asia/Shanghai（生产时区）：今天=今天到期、昨天=已逾期1天 + overdue', () => {
    withTz('Asia/Shanghai', assertCalendarDaySemantics);
  });

  it('TZ=UTC：同一天同一批日历日全部算对（对照档，两档输出必须一致）', () => {
    withTz('UTC', assertCalendarDaySemantics);
  });

  // 跨月 / 跨年边界：本地零点构造 Date 后 setDate 由 Date 归一，不该有月末跳日。
  it('跨月 / 跨年：日历日差正确', () => {
    withTz('Asia/Shanghai', (iso) => {
      expect(deliveryDaysLeftText(iso(1))).toBe('1天后到期');
      expect(deliveryDaysLeftText(iso(3))).toBe('3天后到期');
      expect(deliveryUrgencyClass(iso(3))).toBe('due-soon');
      expect(deliveryDaysLeftText(iso(-30))).toBe('已逾期30天');
    });
  });

  // 空值 / 非法串口径与时区无关：chip 据此显示「-」且不挂样式。
  it('空值与非法串：两档时区下都返空串 / 无紧迫 class', () => {
    for (const tz of ['Asia/Shanghai', 'UTC']) {
      withTz(tz, () => {
        expect(deliveryDaysLeftText(null)).toBe('');
        expect(deliveryDaysLeftText(undefined)).toBe('');
        expect(deliveryDaysLeftText('')).toBe('');
        expect(deliveryUrgencyClass(null)).toBe('');
        // 非法日期串：解析失败按「无值」处理，不抛错也不返回 NaN 参与比较
        expect(deliveryDaysLeftText('not-a-date')).toBe('');
        expect(deliveryUrgencyClass('not-a-date')).toBe('');
      });
    }
  });
});
