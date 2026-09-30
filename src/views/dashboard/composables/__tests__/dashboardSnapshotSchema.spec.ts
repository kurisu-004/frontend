// src/views/dashboard/composables/__tests__/dashboardSnapshotSchema.spec.ts
//
// 2026-09-28 新增：dashboard 大屏快照 Zod schema 与 backend-rust DashboardSnapshot VO
// 对齐回归保护（沿 2026-09-26 约定 #4 与 schemas.spec.ts S4 系列同形态）。
//
// 字段来源：
//   - backend-rust/src/modules/dashboard/vo/snapshot.rs:77-119（DashboardSnapshot 5 顶层 + 4 shelf 字段）
//   - snapshot.rs:95-119（DashboardItem 19 字段，5 必填 + 14 nullable）
//   - snapshot.rs:122-125（UpcomingDeliveryBucket 2 字段，count i64 JSON integer）
//
// 覆盖：
//   - D1：完整 sample snapshot 通过（含 1 shelf group + 2 items + 1 inspection
//     item + 1 in-process item + 1 delivery bucket）；
//   - D2：缺必填字段拒绝（id / name / drawing_no / quantity / is_urgent 任一缺失 → 抛错）；
//   - D3：可选字段（batch_id / serial_no / planned_delivery_date 等）缺省可正常 parse；
//   - D4：DashboardItem 19 字段全声明 regression guard（与 customerSchema S4 同形态）；
//   - D5：UpcomingDeliveryBucket count 是 number（COUNT(*)::bigint → JSON integer）；
//   - D6：dashboardItemSchema 不在 items 数组内时（裸对象）也接受；
//   - D7（2026-09-28 review 第 1 轮修复追加）：DashboardSnapshot /
//     OnProductionShelfGroup / DashboardItem / UpcomingDeliveryBucket 全字段
//     存在 guard —— Zod strip 模式会静默丢字段，光测缺失抛错不够，必须正向断言
//     parsed output keys 与后端 VO 字段一一对应。

import { describe, expect, it } from 'vitest';
import {
  dashboardSnapshotSchema,
  dashboardItemSchema,
  onProductionShelfGroupSchema,
  upcomingDeliveryBucketSchema,
} from '../dashboardSnapshotSchema';

function makeBaseItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    batch_id: '190000000000001',
    batch_no: 1,
    serial_no: 'SN-001',
    name: '零件甲',
    drawing_no: 'DWG-001',
    quantity: 10,
    is_urgent: false,
    planned_delivery_date: '2026-09-30',
    picked_up_at: null,
    current_holder_id: '170000000000001',
    current_holder_kind: 'shelf',
    shelf_code: 'A-01',
    customer_id: '160000000000001',
    customer_name: '客户甲',
    customer_path: '客户甲/客户乙',
    next_process_id: '170000000000002',
    next_process_name: '数控加工',
    worker_name: '张三',
    ...overrides,
  };
}

function makeBaseSnapshot(): Record<string, unknown> {
  return {
    on_production_shelves: [
      {
        shelf_id: '150000000000001',
        shelf_code: 'A-01',
        shelf_name: '生产区 A-01',
        total_count: 1,
        items: [makeBaseItem()],
      },
    ],
    on_inspection_shelves: [makeBaseItem({ id: '180000000000002', shelf_code: 'I-01' })],
    in_process: [makeBaseItem({ id: '180000000000003', current_holder_kind: 'worker' })],
    upcoming_delivery: [{ date: '2026-09-30', count: 5, by_status: { PENDING: 5 } }],
    ts: '2026-09-28T10:00:00+08:00',
  };
}

describe('dashboardSnapshotSchema — DashboardSnapshot VO 契约对齐（2026-09-28）', () => {
  describe('dashboardItemSchema（DashboardItem 19 字段对齐）', () => {
    it('D6：完整 19 字段 dashboardItemSchema.parse 通过', () => {
      const parsed = dashboardItemSchema.parse(makeBaseItem());
      expect(parsed.id).toBe('180000000000001');
      expect(parsed.quantity).toBe(10);
      expect(parsed.is_urgent).toBe(false);
    });

    // 2026-09-28 review 第 1 轮修复追加：D7 全字段 guard。
    // Zod 默认 strip 模式会让 schema 未声明的字段被静默丢弃，光测缺失抛错不够——
    // 例如有人误删 customer_id 字段声明，本用例仍绿。前置正断言 keys 与后端 VO
    // 字段一一对应，是 S4 regression guard 的核心思路。
    it('D7：DashboardItem 19 字段全在 parsed output 里（strip-mode regression guard）', () => {
      const parsed = dashboardItemSchema.parse(makeBaseItem());
      expect(Object.keys(parsed).sort()).toEqual(
        [
          'id',
          'batch_id',
          'batch_no',
          'serial_no',
          'name',
          'drawing_no',
          'quantity',
          'is_urgent',
          'planned_delivery_date',
          'picked_up_at',
          'current_holder_id',
          'current_holder_kind',
          'shelf_code',
          'customer_id',
          'customer_name',
          'customer_path',
          'next_process_id',
          'next_process_name',
          'worker_name',
        ].sort(),
      );
    });

    it('D3：可选字段缺省（batch_id / serial_no / planned_delivery_date 等置 null）仍可 parse', () => {
      const parsed = dashboardItemSchema.parse(
        makeBaseItem({
          batch_id: null,
          batch_no: null,
          serial_no: null,
          planned_delivery_date: null,
          picked_up_at: null,
          current_holder_id: null,
          current_holder_kind: null,
          shelf_code: null,
          customer_id: null,
          customer_name: null,
          customer_path: null,
          next_process_id: null,
          next_process_name: null,
          worker_name: null,
        }),
      );
      expect(parsed.batch_id).toBeNull();
      expect(parsed.customer_name).toBeNull();
    });

    it('D2：缺 name → 抛 ZodError', () => {
      const { name: _, ...rest } = makeBaseItem();
      void _;
      expect(() => dashboardItemSchema.parse(rest)).toThrow();
    });

    it('D2b：缺 drawing_no → 抛 ZodError', () => {
      const { drawing_no: _, ...rest } = makeBaseItem();
      void _;
      expect(() => dashboardItemSchema.parse(rest)).toThrow();
    });

    it('D2c：缺 quantity → 抛 ZodError', () => {
      const { quantity: _, ...rest } = makeBaseItem();
      void _;
      expect(() => dashboardItemSchema.parse(rest)).toThrow();
    });

    it('D2d：缺 is_urgent → 抛 ZodError', () => {
      const { is_urgent: _, ...rest } = makeBaseItem();
      void _;
      expect(() => dashboardItemSchema.parse(rest)).toThrow();
    });

    it('D2e：缺 id → 抛 ZodError', () => {
      const { id: _, ...rest } = makeBaseItem();
      void _;
      expect(() => dashboardItemSchema.parse(rest)).toThrow();
    });
  });

  describe('onProductionShelfGroupSchema', () => {
    it('解析完整 OnProductionShelfGroup 4 顶层字段 + items', () => {
      const parsed = onProductionShelfGroupSchema.parse({
        shelf_id: '150000000000001',
        shelf_code: 'A-01',
        shelf_name: '生产区 A-01',
        total_count: 3,
        items: [makeBaseItem(), makeBaseItem({ id: '180000000000002' })],
      });
      expect(parsed.total_count).toBe(3);
      expect(parsed.items).toHaveLength(2);
    });

    // 2026-09-28 review 第 1 轮修复追加：D7 全字段 guard。
    it('D7：OnProductionShelfGroup 4 顶层字段全在 parsed output 里', () => {
      const parsed = onProductionShelfGroupSchema.parse({
        shelf_id: '150000000000001',
        shelf_code: 'A-01',
        shelf_name: '生产区 A-01',
        total_count: 3,
        items: [makeBaseItem()],
      });
      expect(Object.keys(parsed).sort()).toEqual(
        ['shelf_id', 'shelf_code', 'shelf_name', 'total_count', 'items'].sort(),
      );
    });

    it('缺 total_count → 抛 ZodError', () => {
      expect(() =>
        onProductionShelfGroupSchema.parse({
          shelf_id: '1',
          shelf_code: 'A',
          shelf_name: 'N',
          items: [],
        }),
      ).toThrow();
    });
  });

  describe('upcomingDeliveryBucketSchema', () => {
    // 2026-09-30 bugfix：count 是 COUNT(*)::bigint → JSON integer，非 snowflake ID
    // 故不走 serde-i64 字符串化路径（与 customerSchema S4 不同形态）。
    it('D5：count 是 number（COUNT(*)::bigint → JSON integer）', () => {
      const parsed = upcomingDeliveryBucketSchema.parse({
        date: '2026-09-30',
        count: 42,
        by_status: {},
      });
      expect(parsed.count).toBe(42);
    });

    // 2026-09-28 review 第 1 轮修复追加：D7 全字段 guard。
    it('D7：UpcomingDeliveryBucket 3 字段全在 parsed output 里（2026-09-30 加 by_status）', () => {
      const parsed = upcomingDeliveryBucketSchema.parse({
        date: '2026-09-30',
        count: 42,
        by_status: { PENDING: 10, INSPECTION: 5 },
      });
      expect(Object.keys(parsed).sort()).toEqual(['by_status', 'count', 'date'].sort());
    });

    // 2026-09-30 bugfix：原断言把"契约"和"实现"反过来锁了。count 是 number，传入 number 必须通过；
    // 传 string（前端期望不传）必须拒。
    it('count 传 number → parse 通过', () => {
      const parsed = upcomingDeliveryBucketSchema.parse({
        date: '2026-09-30',
        count: 42,
        by_status: {},
      });
      expect(parsed.count).toBe(42);
    });
    it('count 传 string → 抛 ZodError（防止后端未来回归串行化）', () => {
      expect(() =>
        upcomingDeliveryBucketSchema.parse({
          date: '2026-09-30',
          count: '42',
          by_status: {},
        }),
      ).toThrow();
    });

    it('缺 date → 抛 ZodError', () => {
      expect(() => upcomingDeliveryBucketSchema.parse({ count: 0 })).toThrow();
    });

    // 2026-09-30 新增（plan §2.7 by_status 必填 / 错类型 / 空对象用例）：
    // S 套与 customerSchema S4 regression guard 同形态 —— Zod 默认 strip 模式
    // 会让未声明字段静默丢，必须显式校验。
    describe('2026-09-30 by_status 必填 / 错类型 / 空对象', () => {
      it('S1：有效 by_status（含多种状态）→ parse 通过', () => {
        const parsed = upcomingDeliveryBucketSchema.parse({
          date: '2026-09-30',
          count: 6,
          by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 },
        });
        expect(parsed.by_status.PENDING).toBe(3);
        expect(parsed.by_status.INSPECTION).toBe(2);
        expect(parsed.by_status.DELIVERED).toBe(1);
      });

      it('S2：缺 by_status → 抛 ZodError（防止后端漏返）', () => {
        expect(() =>
          upcomingDeliveryBucketSchema.parse({ date: '2026-09-30', count: 0 }),
        ).toThrow();
      });

      it('S3：by_status value 是 string → 抛 ZodError', () => {
        expect(() =>
          upcomingDeliveryBucketSchema.parse({
            date: '2026-09-30',
            count: 1,
            by_status: { PENDING: '3' as unknown as number },
          }),
        ).toThrow();
      });

      it('S4：by_status value 是负数 → 抛 ZodError（z.number().int().nonnegative）', () => {
        expect(() =>
          upcomingDeliveryBucketSchema.parse({
            date: '2026-09-30',
            count: 1,
            by_status: { PENDING: -1 },
          }),
        ).toThrow();
      });

      it('S5：by_status 是空对象 {} → parse 通过（合法零桶日终态）', () => {
        const parsed = upcomingDeliveryBucketSchema.parse({
          date: '2026-09-30',
          count: 0,
          by_status: {},
        });
        expect(parsed.by_status).toEqual({});
        expect(parsed.count).toBe(0);
      });
    });
  });

  describe('dashboardSnapshotSchema', () => {
    it('D1：完整 sample snapshot 通过（含 shelf group + items + delivery bucket）', () => {
      const parsed = dashboardSnapshotSchema.parse(makeBaseSnapshot());
      expect(parsed.on_production_shelves).toHaveLength(1);
      expect(parsed.on_inspection_shelves).toHaveLength(1);
      expect(parsed.in_process).toHaveLength(1);
      expect(parsed.upcoming_delivery).toHaveLength(1);
      expect(parsed.upcoming_delivery[0]?.count).toBe(5);
    });

    // 2026-09-28 review 第 1 轮修复追加：D7 全字段 guard。
    it('D7：DashboardSnapshot 5 顶层字段全在 parsed output 里', () => {
      const parsed = dashboardSnapshotSchema.parse(makeBaseSnapshot());
      expect(Object.keys(parsed).sort()).toEqual(
        [
          'on_production_shelves',
          'on_inspection_shelves',
          'in_process',
          'upcoming_delivery',
          'ts',
        ].sort(),
      );
    });

    it('空数组也接受（snapshot 内无货架 / 无在制）', () => {
      const parsed = dashboardSnapshotSchema.parse({
        on_production_shelves: [],
        on_inspection_shelves: [],
        in_process: [],
        upcoming_delivery: [],
        ts: '2026-09-28T10:00:00+08:00',
      });
      expect(parsed.on_production_shelves).toHaveLength(0);
    });

    it('缺 ts → 抛 ZodError', () => {
      const { ts: _, ...rest } = makeBaseSnapshot();
      void _;
      expect(() => dashboardSnapshotSchema.parse(rest)).toThrow();
    });

    it('缺 in_process → 抛 ZodError', () => {
      const { in_process: _, ...rest } = makeBaseSnapshot();
      void _;
      expect(() => dashboardSnapshotSchema.parse(rest)).toThrow();
    });
  });
});
