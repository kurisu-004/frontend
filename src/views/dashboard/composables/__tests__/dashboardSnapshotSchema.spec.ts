// src/views/dashboard/composables/__tests__/dashboardSnapshotSchema.spec.ts
//
// 2026-09-28 新增：dashboard 大屏快照 Zod schema 与 backend-rust DashboardSnapshot VO
// 对齐回归保护（沿 2026-09-26 约定 #4 与 schemas.spec.ts S4 系列同形态）。
//
// 字段来源：
//   - backend-rust/src/modules/dashboard/vo/snapshot.rs:77-119（DashboardSnapshot 5 顶层 + 4 shelf 字段）
//   - snapshot.rs:95-119（DashboardItem 17 字段）
//   - snapshot.rs:122-125（UpcomingDeliveryBucket 2 字段，count i64 → string）
//
// 覆盖：
//   - D1：完整 sample snapshot 通过（含 1 shelf group + 2 items + 1 inspection
//     item + 1 in-process item + 1 delivery bucket）；
//   - D2：缺必填字段拒绝（id / name / drawing_no / quantity / is_urgent 任一缺失 → 抛错）；
//   - D3：可选字段（batch_id / serial_no / planned_delivery_date 等）缺省可正常 parse；
//   - D4：DashboardItem 17 字段全声明 regression guard（与 customerSchema S4 同形态）；
//   - D5：UpcomingDeliveryBucket count 是 string（rust_decimal/serde-i64 wire-format）；
//   - D6：dashboardItemSchema 不在 items 数组内时（裸对象）也接受。

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
    upcoming_delivery: [{ date: '2026-09-30', count: '5' }],
    ts: '2026-09-28T10:00:00+08:00',
  };
}

describe('dashboardSnapshotSchema — DashboardSnapshot VO 契约对齐（2026-09-28）', () => {
  describe('dashboardItemSchema（DashboardItem 17 字段对齐）', () => {
    it('D6：完整 17 字段 dashboardItemSchema.parse 通过', () => {
      const parsed = dashboardItemSchema.parse(makeBaseItem());
      expect(parsed.id).toBe('180000000000001');
      expect(parsed.quantity).toBe(10);
      expect(parsed.is_urgent).toBe(false);
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
    it('D5：count 是 string（i64 → rust serde-i64 序列化为字符串）', () => {
      const parsed = upcomingDeliveryBucketSchema.parse({ date: '2026-09-30', count: '42' });
      expect(parsed.count).toBe('42');
    });

    it('count 传 number → 抛 ZodError', () => {
      expect(() => upcomingDeliveryBucketSchema.parse({ date: '2026-09-30', count: 42 })).toThrow();
    });

    it('缺 date → 抛 ZodError', () => {
      expect(() => upcomingDeliveryBucketSchema.parse({ count: '0' })).toThrow();
    });
  });

  describe('dashboardSnapshotSchema', () => {
    it('D1：完整 sample snapshot 通过（含 shelf group + items + delivery bucket）', () => {
      const parsed = dashboardSnapshotSchema.parse(makeBaseSnapshot());
      expect(parsed.on_production_shelves).toHaveLength(1);
      expect(parsed.on_inspection_shelves).toHaveLength(1);
      expect(parsed.in_process).toHaveLength(1);
      expect(parsed.upcoming_delivery).toHaveLength(1);
      expect(parsed.upcoming_delivery[0]?.count).toBe('5');
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
