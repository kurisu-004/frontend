// src/views/dashboard/composables/__tests__/bannerSchema.spec.ts
//
// SCAN_BANNER 守门 schema 的正向 / 负向用例。
//
// 这批用例守的是「推送通道的守门点」这条纪律（CLAUDE.md「Zod schema-first」的第三种
// 形态）：schema 放在域内 composables 里、`.safeParse()` 落在组件的 onDashboardEvent
// 回调内。schema 少声明一个字段 = 那一类坏事件静默渲染成空文案，而 parse 被整段摘掉
// 时不会有任何报错 —— 所以负向用例必须逐个字段戳。

import { describe, expect, it } from 'vitest';
import { scanBannerItemSchema } from '../bannerSchema';

/** 一条合法的 payload。 */
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'PICKED_UP',
    worker_name: '张三',
    serial_no: 'F1234',
    drawing_no: 'DWG-9',
    quantity: 20,
    system_delivery_date: '2026-10-27',
    ...over,
  };
}

describe('scanBannerItemSchema（2026-10-13）', () => {
  it('正向：完整 payload 解析成功，六个字段原样保留', () => {
    const parsed = scanBannerItemSchema.parse(valid());
    expect(parsed).toEqual({
      action: 'PICKED_UP',
      worker_name: '张三',
      serial_no: 'F1234',
      drawing_no: 'DWG-9',
      quantity: 20,
      system_delivery_date: '2026-10-27',
    });
  });

  it.each(['PICKED_UP', 'RETURNED', 'INSPECTED'] as const)('正向：action=%s 合法', (action) => {
    expect(scanBannerItemSchema.parse(valid({ action })).action).toBe(action);
  });

  it('正向：serial_no / system_delivery_date 为 null 仍然通过（两处都是合法业务态）', () => {
    const parsed = scanBannerItemSchema.parse(
      valid({ serial_no: null, system_delivery_date: null }),
    );
    expect(parsed.serial_no).toBeNull();
    expect(parsed.system_delivery_date).toBeNull();
  });

  it('正向：system_delivery_date 带时刻的漂移形态仍然通过', () => {
    // 刻意不收紧日期格式闸：后端 `system_delivery_date` 是 `Option<chrono::NaiveDate>`
    // （后端 `src/modules/prod/scan/vo/transition.rs`），wire 上只有 "YYYY-MM-DD" 与
    // null 两种形态；展示层只取 M-DD，带时刻的漂移 `slice(5,10)` 仍能正确降级，而
    // 格式过紧只会把它静默变成「事件被丢弃」，对正确性零收益。
    expect(
      scanBannerItemSchema.parse(valid({ system_delivery_date: '2026-10-27T00:00:00' })),
    ).toMatchObject({ system_delivery_date: '2026-10-27T00:00:00' });
  });

  it('负向：action 非法值被拒', () => {
    expect(scanBannerItemSchema.safeParse(valid({ action: 'PLACED_ON_SHELF' })).success).toBe(
      false,
    );
    expect(scanBannerItemSchema.safeParse(valid({ action: 'picked_up' })).success).toBe(false);
  });

  // 逐个必填字段缺失 —— Zod 默认 strip 会静默丢未声明字段，漏声明一个字段守门就形同虚设，
  // 所以这里逐字段戳而不是「随便少一个」。
  const REQUIRED_KEYS = ['action', 'worker_name', 'drawing_no', 'quantity'] as const;

  it.each(REQUIRED_KEYS)('负向：必填键 %s 缺失被拒', (key) => {
    const payload = valid();
    delete payload[key];
    expect(scanBannerItemSchema.safeParse(payload).success).toBe(false);
  });

  it('负向：可空键缺失（serial_no / system_delivery_date）同样被拒 —— 可空 ≠ 可缺', () => {
    for (const key of ['serial_no', 'system_delivery_date'] as const) {
      const payload = valid();
      delete payload[key];
      expect(scanBannerItemSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('负向：字段类型错被拒（quantity 传字符串 / worker_name 传数字 / 日期传对象）', () => {
    expect(scanBannerItemSchema.safeParse(valid({ quantity: '20' })).success).toBe(false);
    expect(scanBannerItemSchema.safeParse(valid({ worker_name: 3 })).success).toBe(false);
    expect(scanBannerItemSchema.safeParse(valid({ system_delivery_date: {} })).success).toBe(false);
  });

  it('负向：未声明的多余键被 strip（不报错，但不会流到消费侧）', () => {
    const parsed = scanBannerItemSchema.parse(valid({ shelf_code: 'A-01', bogus: 1 }));
    expect(parsed).not.toHaveProperty('shelf_code');
    expect(parsed).not.toHaveProperty('bogus');
  });
});
