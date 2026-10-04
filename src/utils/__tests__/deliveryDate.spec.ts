// src/utils/__tests__/deliveryDate.spec.ts
//
// 交期天数/紧迫样式的**绝对输出**回归锁（2026-10-04 新增，review 第 1 轮）。
//
// 为什么值得单独立一个文件：报工台 HMI 上「昨天到期的件不显红」这类问题没有报错、不会
// 有人发现，而仓内原有的交期断言全部走「形状」口径（有没有 `.days-left`、有没有
// `overdue` class），对天数**算得对不对**零覆盖。本文件是全仓唯一按 TZ 两档锁定
// 「今天到期 / 已逾期 N 天 / N 天后到期」**具体字符串**的地方。
//
// ⚠️ 本文件刻意锁的是**当前带缺陷的输出**。`deliveryDate.ts` 有一个已登记的时区缺陷
// （见该文件文件头）：日期串按 UTC 零点解析、「今天」按本地零点，东八区恒多算一天。
// 修好之后下面两条断言会同时变红 —— 那正是提醒「该把这里改成正确值、并同步三个
// dashboard 组件的期望」的红灯，不是误报。
//
// 固定 TZ 的方式（本仓 vitest.config.ts 没有全局 `test.env` 段，见下）：在 `withTz` 里
// 直接赋值 `process.env.TZ`，**且必须早于 `vi.useFakeTimers()`** —— 假 Date 装好后
// 换 TZ 不再生效（sinon 的 fake Date 会把时区偏移固定在安装那一刻）。所以「设 TZ → 装
// 假表 → 跑断言」三步必须包在同一个 helper 里，每个用例重装一次。
// 不写进 vitest.config.ts 的 `test.env`：那会一次性改掉全仓 125 个 spec 的时区基线，
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
 * 两种时区下推出来的都是同一个真实日历日（这是本文件要的：只让时区影响 `deliveryDate`
 * 自己的算术，不让日期串本身随时区漂移）。
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

describe('deliveryDate 天数口径（已知时区缺陷的绝对输出锁）', () => {
  beforeEach(() => {
    originalTz = process.env.TZ;
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // 缺陷本体：同一批真实日历日，UTC 下算得对，东八区整体 +1 天。
  it('TZ=Asia/Shanghai（生产时区）：今天算「1天后到期」、昨天算「今天到期」且不判逾期', () => {
    withTz('Asia/Shanghai', (iso) => {
      // 今天到期：口径差一天 ⇒ 说成还剩 1 天
      expect(deliveryDaysLeftText(iso(0))).toBe('1天后到期');
      // 今天+2：说成还剩 3 天
      expect(deliveryDaysLeftText(iso(2))).toBe('3天后到期');
      // 昨天到期：说成「今天到期」，样式是 `due-soon`（橙）而**不是 `overdue`**（红）——
      // 也就是昨天已经过期的件在产线屏上不显红。
      expect(deliveryDaysLeftText(iso(-1))).toBe('今天到期');
      expect(deliveryUrgencyClass(iso(-1))).toBe('due-soon');
      // 5 天前逾期：少报 1 天
      expect(deliveryDaysLeftText(iso(-5))).toBe('已逾期4天');
      expect(deliveryUrgencyClass(iso(-5))).toBe('overdue');
      // due-soon 的实际覆盖窗口（真实日历日）：昨天 ~ 今天+2；今天+3 起无紧迫样式
      expect(deliveryUrgencyClass(iso(2))).toBe('due-soon');
      expect(deliveryUrgencyClass(iso(3))).toBe('');
    });
  });

  // 对照档：证明上面那组不是「算法本来就该这样」，而是时区产物。修好之后本档不会变。
  it('TZ=UTC：同一天同一批日历日全部算对（对照档，说明偏差来源是时区不是算法）', () => {
    withTz('UTC', (iso) => {
      expect(deliveryDaysLeftText(iso(0))).toBe('今天到期');
      expect(deliveryDaysLeftText(iso(2))).toBe('2天后到期');
      expect(deliveryDaysLeftText(iso(-1))).toBe('已逾期1天');
      expect(deliveryUrgencyClass(iso(-1))).toBe('overdue');
      expect(deliveryDaysLeftText(iso(-5))).toBe('已逾期5天');
    });
  });

  // 空值口径与时区无关，两档都该成立（chip 恒渲染后这条直接决定屏幕上显示什么）。
  it('空值：两档时区下都返空串 / 无紧迫 class（chip 据此显示「-」且不挂样式）', () => {
    withTz('Asia/Shanghai', () => {
      expect(deliveryDaysLeftText(null)).toBe('');
      expect(deliveryUrgencyClass(null)).toBe('');
    });
    withTz('UTC', () => {
      expect(deliveryDaysLeftText(null)).toBe('');
      expect(deliveryUrgencyClass(null)).toBe('');
    });
  });
});
