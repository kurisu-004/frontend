// src/utils/__tests__/systemDeliveryOrders.spec.ts
//
// 2026-10-03 新增：systemDeliveryOrders 纯函数底座的边界契约。零 vue / 零网络，
// 直接构造 PartListItem fixture 断言。
//
// 覆盖：
//   - W1：窗口上限 = today+6（today+6 命中、today+7 排除）
//   - W1b：窗口下界 = today（today 命中、昨天排除；逾期件不进这两块面板）
//   - W2：system_delivery_date 为 null 一律剔除
//   - W3：delivered_quantity = 0 与字段缺失（undefined）都归 urgent
//   - W4：delivered_quantity > 0 归 partial
//   - W5：两个桶各自 slice(0, limit)，互不串味
//   - W6：分桶**不重排**（输入的 ASC 顺序原样保留）
//   - W8：窗口两端与 useDashboardUrgentList 下发的请求参数同源（同一模块派生）
//   - W9：splitForDashboard 的窗口由调用方传入的 startIso 决定（不现取 today）——
//     固定历史起点下 start+6 命中、start+7 排除，客户端窗口与服务端请求窗口由此同刻
//   - W9b：固定日期 2026-10-05 起算的窗口端点算术

import { describe, expect, it } from 'vitest';
import {
  DELIVERY_WINDOW_DAYS,
  deliveryWindowCutoffIso,
  deliveryWindowEndIso,
  deliveryWindowStartIso,
  inDeliveryWindow,
  splitForDashboard,
} from '../systemDeliveryOrders';
import type { PartListItem } from '@/types/parts';

/** 相对今天偏移 n 天的本地 ISO（'YYYY-MM-DD'）。 */
function isoOffset(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 只带分桶 / 窗口判据关心的字段（其余必填字段给默认值）。 */
function makePart(overrides: Partial<PartListItem> = {}): PartListItem {
  return {
    id: '180000000000001',
    version: 1,
    serial_no: 'F1016',
    name: '连杆总成左前',
    drawing_no: 'DWG-001',
    applicant_name: null,
    quantity: 64,
    unit_price: '0',
    total_price: '0',
    request_date: isoOffset(-10),
    planned_delivery_date: isoOffset(3),
    is_urgent: false,
    status: 'IN_PROCESS',
    order_no: null,
    system_delivery_date: isoOffset(2),
    note: null,
    customer_name: '南海路厂区',
    l1_customer_name: '南海集团',
    location: null,
    has_cnc_program: false,
    ...overrides,
  };
}

describe('deliveryWindowCutoffIso / inDeliveryWindow（窗口边界）', () => {
  it('W1：上限 = today+6（today+6 命中、today+7 排除），窗口跨度 7 天', () => {
    expect(DELIVERY_WINDOW_DAYS).toBe(7);
    expect(deliveryWindowCutoffIso()).toBe(isoOffset(6));

    expect(inDeliveryWindow(makePart({ system_delivery_date: isoOffset(6) }))).toBe(true);
    expect(inDeliveryWindow(makePart({ system_delivery_date: isoOffset(7) }))).toBe(false);
  });

  it('W1b：下界 = today（今天命中、前天与昨天排除），端点两端齐飞', () => {
    // 下界的意义与 urgentList 的请求参数同源：服务端已按 [today, today+6] 过滤，
    // 客户端镜像同一窗口，逾期件不会靠「过去日期 ASC 排最前」挤进这两块面板。
    expect(deliveryWindowStartIso()).toBe(isoOffset(0));
    expect(inDeliveryWindow(makePart({ system_delivery_date: isoOffset(0) }))).toBe(true);
    expect(inDeliveryWindow(makePart({ system_delivery_date: isoOffset(-1) }))).toBe(false);
    expect(inDeliveryWindow(makePart({ system_delivery_date: isoOffset(-2) }))).toBe(false);

    const items = [
      makePart({ id: '1', serial_no: 'OVERDUE', system_delivery_date: isoOffset(-1) }),
      makePart({ id: '2', serial_no: 'TODAY', system_delivery_date: isoOffset(0) }),
      makePart({ id: '3', serial_no: 'NONE', system_delivery_date: null }),
      makePart({ id: '4', serial_no: 'CUTOFF', system_delivery_date: isoOffset(6) }),
      makePart({ id: '5', serial_no: 'LATE', system_delivery_date: isoOffset(7) }),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 30, partialLimit: 30 },
      deliveryWindowStartIso(),
    );
    expect(urgent.map((p) => p.serial_no)).toEqual(['TODAY', 'CUTOFF']);
    expect(partial).toHaveLength(0);
  });

  it('W8：窗口两端同源 —— deliveryWindowEndIso(start) 与 deliveryWindowCutoffIso() 一致', () => {
    // useDashboardUrgentList 的 system_delivery_date_from/_to 直接取这两个导出，
    // 客户端 splitForDashboard 收同一个 startIso 再派上界 ⇒ 不会出现「两处各写一遍
    // today+6」，也不会各取一次 today 而错开一天。
    const start = deliveryWindowStartIso();
    expect(deliveryWindowEndIso(start)).toBe(deliveryWindowCutoffIso());
    expect(deliveryWindowEndIso(start)).toBe(isoOffset(DELIVERY_WINDOW_DAYS - 1));
    // 跨月边界：月末起算 +6 天仍在同一个月 / 跨月都只依赖 Date 归一，不写死月长
    expect(deliveryWindowEndIso('2026-01-31')).toBe('2026-02-06');
  });

  it('W2：system_delivery_date 为 null 一律剔除（无交期不进任何桶）', () => {
    expect(inDeliveryWindow(makePart({ system_delivery_date: null }))).toBe(false);

    const { urgent, partial } = splitForDashboard(
      [makePart({ id: '1', system_delivery_date: null })],
      { urgentLimit: 30, partialLimit: 30 },
      deliveryWindowStartIso(),
    );
    expect(urgent).toHaveLength(0);
    expect(partial).toHaveLength(0);
  });

  it('W9：窗口由传入的 startIso 决定（固定历史日期，start+6 命中、start+7 排除）', () => {
    // 这条钉的是「客户端窗口与服务端窗口同刻」：startIso 就是 useDashboardUrgentList
    // 下发给服务端 from 的那个值，两端口径若各取一次 today，跨零点后会差一天，且丢掉的
    // 恰好是「昨天」（与「面板不含逾期」重合 ⇒ 漂移是静默的）。
    // 起点刻意取**固定的历史日期**而不是「今天 - N 天」：只有 startIso 恒不等于 today，
    // 「函数内部改回现取 today」才会被钉红（若起点恰好落在今天，两种实现结果相同，
    // 断言就失去鉴别力）。
    const startIso = '2020-06-01';
    const items = [
      makePart({ id: '1', serial_no: 'EDGE_IN', system_delivery_date: '2020-06-07' }),
      makePart({ id: '2', serial_no: 'EDGE_OUT', system_delivery_date: '2020-06-08' }),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 30, partialLimit: 30 },
      startIso,
    );
    expect(urgent.map((p) => p.serial_no)).toEqual(['EDGE_IN']);
    expect(partial).toHaveLength(0);
    // 上界确实由 startIso 派生（+6 天），不是别的常数
    expect(deliveryWindowEndIso(startIso)).toBe('2020-06-07');
  });

  it('W9b：固定日期 2026-10-05 起算 —— start+6 = 2026-10-11 命中、start+7 = 2026-10-12 排除', () => {
    // 窗口算术的固定读数（与运行日无关）。注意鉴别力在 W9：本条起点与「今天」是否相同
    // 会影响结论，只在非该日起算的运行日才有反例价值。
    const startIso = '2026-10-05';
    const items = [
      makePart({ id: '1', serial_no: 'EDGE_IN', system_delivery_date: '2026-10-11' }),
      makePart({ id: '2', serial_no: 'EDGE_OUT', system_delivery_date: '2026-10-12' }),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 30, partialLimit: 30 },
      startIso,
    );
    expect(urgent.map((p) => p.serial_no)).toEqual(['EDGE_IN']);
    expect(partial).toHaveLength(0);
    expect(deliveryWindowEndIso(startIso)).toBe('2026-10-11');
  });
});

describe('splitForDashboard（按「有无已交批次」分桶）', () => {
  it('W3：delivered_quantity = 0 与字段缺失（undefined）都归 urgent', () => {
    const items = [
      makePart({ id: '1', serial_no: 'ZERO', delivered_quantity: 0 }),
      makePart({ id: '2', serial_no: 'ABSENT' }),
      makePart({ id: '3', serial_no: 'NULL', delivered_quantity: null }),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 30, partialLimit: 30 },
      deliveryWindowStartIso(),
    );

    expect(partial).toHaveLength(0);
    expect(urgent.map((p) => p.serial_no)).toEqual(['ZERO', 'ABSENT', 'NULL']);
  });

  it('W4：delivered_quantity > 0 归 partial，并从 urgent 移出', () => {
    const items = [
      makePart({ id: '1', serial_no: 'CLEAN' }),
      makePart({ id: '2', serial_no: 'HALF', delivered_quantity: 20, quantity: 64 }),
      makePart({ id: '3', serial_no: 'ALL', delivered_quantity: 64, quantity: 64 }),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 30, partialLimit: 30 },
      deliveryWindowStartIso(),
    );

    expect(urgent.map((p) => p.serial_no)).toEqual(['CLEAN']);
    expect(partial.map((p) => p.serial_no)).toEqual(['HALF', 'ALL']);
  });

  it('W5：两个桶各自 slice(0, limit)，limit 互不影响', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePart({ id: `u${i}`, serial_no: `U${i}`, delivered_quantity: 0 }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makePart({ id: `p${i}`, serial_no: `P${i}`, delivered_quantity: 5 }),
      ),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 2, partialLimit: 3 },
      deliveryWindowStartIso(),
    );

    expect(urgent.map((p) => p.serial_no)).toEqual(['U0', 'U1']);
    expect(partial.map((p) => p.serial_no)).toEqual(['P0', 'P1', 'P2']);
  });

  it('W6：分桶不重排 —— 桶内保持后端给的 system_delivery_date ASC 顺序', () => {
    // 输入故意「交期升序 + 交期降序」各若干，分桶后桶内顺序必须与输入相对顺序一致。
    const items = [
      makePart({ id: '1', serial_no: 'A', system_delivery_date: isoOffset(1) }),
      makePart({
        id: '2',
        serial_no: 'B',
        system_delivery_date: isoOffset(3),
        delivered_quantity: 7,
      }),
      makePart({ id: '3', serial_no: 'C', system_delivery_date: isoOffset(2) }),
      makePart({
        id: '4',
        serial_no: 'D',
        system_delivery_date: isoOffset(4),
        delivered_quantity: 9,
      }),
    ];
    const { urgent, partial } = splitForDashboard(
      items,
      { urgentLimit: 30, partialLimit: 30 },
      deliveryWindowStartIso(),
    );

    expect(urgent.map((p) => p.serial_no)).toEqual(['A', 'C']);
    expect(partial.map((p) => p.serial_no)).toEqual(['B', 'D']);
  });

  it('W7：空输入 → 两桶皆空（面板走空态分支）', () => {
    expect(
      splitForDashboard([], { urgentLimit: 30, partialLimit: 30 }, deliveryWindowStartIso()),
    ).toEqual({
      urgent: [],
      partial: [],
    });
  });
});
