// @vitest-environment happy-dom
// src/views/scan/components/__tests__/DeliveryDateChip.spec.ts
//
// 2026-10-04 新增：交期 chip「只显示系统交期、无值显示 '-'」的渲染契约。
//
// 为什么值得单独立一个文件：chip 是三页（取件 / 放回 / 送检）共用的唯一一处交期渲染，
// 而它承载的是**产品规则**（计划交期不上屏、只作排序键）。改坏了症状是工人在产线屏幕
// 上看到两个日期、或者看到空白格 —— 没有报错、不会有人发现。
//
// 三页里 chip 是恒渲染（没有 v-if），所以「无值显示 '-'」这一条必须由组件自己保证：以前
// 由调用方的 `v-if="planned || system"` 兜着，改成恒渲染后这份保证就落到这里了。
//
// 紧迫样式与剩余天数文案是同一个日期的两副面孔（`deliveryUrgencyClass` /
// `deliveryDaysLeftText` 都以系统交期为唯一输入），一并钉住，避免两个函数某天只改一个。
//
// ⚠️ `deliveryDate.ts` 内部把 `systemDeliveryDate` 归一成**日期串**再用 `new Date()`
// 解析，日期串按 UTC 零点解读，而「今天」是本地零点 ⇒ 东八区下天数会多算一天（该缺陷
// 的权威登记在 `src/utils/deliveryDate.ts` 文件头）。本文件用 `isoForDiffDays(n)` 反推出
// 「在该口径下正好差 n 天」的日期串，于是「2 天后到期」这类断言在任意时区都成立（红的
// 不会只是机器时区）。日期**格式**（MM/DD 与否）用形状断言而不是写死日历日，同理。
//
// 职责边界（2026-10-04 review 第 1 轮）：本文件只管**组件渲染契约**（渲染不渲染、渲什么
// 形状、挂不挂 class），**不管天数算得对不对**。天数与紧迫样式的绝对值、以及那个时区
// 缺陷的 TZ 两档对照，锁在 `src/utils/__tests__/deliveryDate.spec.ts` —— 那边修好之后
// 会红，这边不会，两边都不该越界。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import DeliveryDateChip from '../DeliveryDateChip.vue';

const stubs = {
  'el-icon': { name: 'ElIconStub', template: '<i><slot /></i>' },
  'el-tag': {
    name: 'ElTagStub',
    props: ['type', 'size', 'effect'],
    template: '<span class="mock-tag"><slot /></span>',
  },
};

/**
 * 造一个「`deliveryDate.ts` 口径下正好差 n 天」的系统交期值（本地正午时间戳）。
 * 见文件头：直接用「今天 + n 天」拼串会在 UTC+8 下少一天。
 */
function isoForDiffDays(n: number): string {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const target = new Date(todayMidnight.getTime() + n * 86400000);
  // 取 UTC 日历分量拼成本地正午：解析结果落在同一个民用日，且 UTC 零点口径下正好差 n 天
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(target.getUTCDate()).padStart(2, '0');
  return `${target.getUTCFullYear()}-${mm}-${dd}T12:00:00`;
}

function render(systemDeliveryDate: string | null) {
  return mount(DeliveryDateChip, {
    props: { systemDeliveryDate },
    global: { stubs },
  });
}

describe('DeliveryDateChip', () => {
  beforeEach(() => {
    // 固定「今天」：否则「N 天后到期」这类断言会在跨日那一刻集体变红
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 4, 0, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('有系统交期：渲染 MM/DD（不是完整 ISO、也不是空值占位）+ 「系统交期」小标签', () => {
    const w = render(isoForDiffDays(100));

    expect(w.text()).toMatch(/\d{2}\/\d{2}/);
    expect(w.text()).not.toMatch(/\d{4}/);
    expect(w.text()).toContain('系统交期');
    expect(w.find('.system-tag').exists()).toBe(true);
  });

  it('无系统交期：日期位渲染 "-"，且不渲染标签 / 剩余天数 / 紧迫样式', () => {
    const w = render(null);

    expect(w.text().trim()).toBe('-');
    // 计划交期不再上屏：这一版只吃 system_delivery_date，null 就是 '-'，没有第二条腿
    expect(w.find('.system-tag').exists()).toBe(false);
    expect(w.find('.days-left').exists()).toBe(false);
    // 无值不许挂紧迫样式（否则整块红/橙，工人以为逾期了）
    expect(w.classes()).not.toContain('overdue');
    expect(w.classes()).not.toContain('due-soon');
  });

  it('逾期：overdue 样式 + 「已逾期N天」文案', () => {
    const w = render(isoForDiffDays(-5));

    expect(w.classes()).toContain('overdue');
    expect(w.find('.days-left').text()).toContain('已逾期5天');
  });

  it('临期：due-soon 样式 + 「N天后到期」文案（≤3 天）', () => {
    const w = render(isoForDiffDays(2));

    expect(w.classes()).toContain('due-soon');
    expect(w.find('.days-left').text()).toContain('2天后到期');
  });

  it('还有余量：没有紧迫样式、没有剩余天数文案（超过 3 天）', () => {
    const w = render(isoForDiffDays(30));

    expect(w.classes()).not.toContain('overdue');
    expect(w.classes()).not.toContain('due-soon');
    expect(w.find('.days-left').exists()).toBe(false);
    expect(w.text()).toContain('系统交期');
  });

  // props 收窄（砍掉 plannedDeliveryDate）的直接守卫：计划交期若被误传回来，它必须
  // **不影响**任何输出 —— 这条守住「计划交期只是排序键、不上屏」不被悄悄改回去。
  // 故意用类型断言绕过 props 检查：TypeScript 本来就会拦掉这个多余 prop，我们要验的
  // 恰恰是「运行时不认它」这半边。
  it('计划交期传了也不上屏（props 只有 systemDeliveryDate，多余的 attr 被忽略）', () => {
    const props: { systemDeliveryDate: string | null; plannedDeliveryDate: string } = {
      systemDeliveryDate: null,
      plannedDeliveryDate: isoForDiffDays(1),
    };
    const w = mount(DeliveryDateChip, {
      props: props as never,
      global: { stubs },
    });

    expect(w.text().trim()).toBe('-');
    expect(w.find('.system-tag').exists()).toBe(false);
  });
});
