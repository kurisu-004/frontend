// src/views/dashboard/composables/__tests__/dashboardSnapshotSchema.spec.ts
//
// dashboard 域三个只读端点的 Zod schema 与后端契约对齐回归保护
// （契约来源：backend-rust docs/api/dashboard.md；与 schemas.spec.ts S4 系列同形态）。
//
// 覆盖：
//   - D1：完整 sample snapshot 通过（1 工人在手批次 + 2 交期面板行 + 1 分桶）；
//   - D2：缺必填字段拒绝（逐 schema 逐字段）；
//   - D3：可空字段置 null 仍可 parse；
//   - D4：DashboardSnapshot / WorkerHeldBatch / SystemDeliveryOrder /
//     UpcomingDeliveryBuckets / DeliveryOrderDetailOut 全字段 guard —— Zod strip 模式
//     会静默丢字段，光测缺失抛错不够，必须正向断言 parsed output keys 与后端 VO 字段
//     一一对应。
//
// 每个 schema 都补了「必填字段缺失 → throw」用例：Zod 默认 strip 让未声明字段被静默
// 丢弃，而反向的「误删必填声明」也必须抛错，否则契约失守无人察觉。

import { describe, expect, it } from 'vitest';
import {
  dashboardSnapshotSchema,
  deliveryOrderDetailOutSchema,
  deliveryOrderDetailSchema,
  systemDeliveryOrderSchema,
  upcomingBucketsSchema,
  upcomingDeliveryBucketSchema,
  workerHeldBatchSchema,
} from '../dashboardSnapshotSchema';

function makeBaseWorkerHeldBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000001',
    batch_id: '190000000000001',
    serial_no: 'F1234',
    quantity: 20,
    is_urgent: false,
    current_holder_id: '170000000000001',
    worker_name: '张三',
    ...overrides,
  };
}

function makeBaseSystemOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000002',
    serial_no: 'F5678',
    name: '连杆总成左前',
    quantity: 100,
    status: 'IN_PROCESS',
    system_delivery_date: '2026-10-08',
    customer_name: '南海路厂区',
    is_urgent: true,
    delivered_quantity: 3,
    ...overrides,
  };
}

function makeBaseBucket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { date: '2026-10-07', count: 5, by_status: { PENDING: 5 }, ...overrides };
}

function makeBaseDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '180000000000003',
    serial_no: 'F9012',
    drawing_no: 'DWG-001',
    name: '零件甲',
    l1_customer_name: '南海集团',
    customer_name: '南海路厂区',
    status: 'PENDING',
    planned_delivery_date: '2026-10-09',
    system_delivery_date: '2026-10-10',
    ...overrides,
  };
}

function makeBaseSnapshot(): Record<string, unknown> {
  return {
    overdue_count: 12,
    in_inspection_count: 4,
    in_process: [makeBaseWorkerHeldBatch()],
    system_delivery_orders: {
      urgent: [makeBaseSystemOrder({ delivered_quantity: 0 })],
      partial: [makeBaseSystemOrder()],
    },
    ts: '2026-10-07T14:30:00.123+08:00',
  };
}

function makeBaseBuckets(): Record<string, unknown> {
  return {
    today: '2026-10-07',
    buckets: [makeBaseBucket()],
    ts: '2026-10-07T14:30:00.123+08:00',
  };
}

function makeBaseDetailOut(): Record<string, unknown> {
  return {
    date: '2026-10-07',
    basis: 'system',
    total: 17,
    items: [makeBaseDetail()],
    ts: '2026-10-07T14:30:00.123+08:00',
  };
}

/** 去掉一个键后的副本 —— 构造「缺该必填字段」的 payload。 */
function omit(base: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...base };
  delete rest[key];
  return rest;
}

describe('workerHeldBatchSchema（工人在手加工批次 7 字段）', () => {
  it('D1：完整 7 字段 parse 通过', () => {
    const parsed = workerHeldBatchSchema.parse(makeBaseWorkerHeldBatch());
    expect(parsed.id).toBe('180000000000001');
    expect(parsed.batch_id).toBe('190000000000001');
    expect(parsed.quantity).toBe(20);
    expect(parsed.is_urgent).toBe(false);
    expect(parsed.worker_name).toBe('张三');
  });

  it('D4：7 字段全在 parsed output 里（strip-mode regression guard）', () => {
    const parsed = workerHeldBatchSchema.parse(makeBaseWorkerHeldBatch());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'id',
        'batch_id',
        'serial_no',
        'quantity',
        'is_urgent',
        'current_holder_id',
        'worker_name',
      ].sort(),
    );
  });

  it('D3：可空字段置 null 仍可 parse', () => {
    const parsed = workerHeldBatchSchema.parse(
      makeBaseWorkerHeldBatch({
        batch_id: null,
        serial_no: null,
        current_holder_id: null,
        worker_name: null,
      }),
    );
    expect(parsed.batch_id).toBeNull();
    expect(parsed.worker_name).toBeNull();
  });

  // batch_id 是前端 chip :key 的唯一来源，删掉声明会静默让同一工单多批次产生重复 key
  // —— 故这条不是「可空就可不声明」，必须显式存在。
  it('必填：缺 id / batch_id / quantity / is_urgent 任一 → 抛 ZodError', () => {
    for (const key of ['id', 'batch_id', 'quantity', 'is_urgent']) {
      expect(() => workerHeldBatchSchema.parse(omit(makeBaseWorkerHeldBatch(), key))).toThrow();
    }
  });
});

describe('systemDeliveryOrderSchema（交期面板行 9 字段）', () => {
  it('D1：完整 9 字段 parse 通过', () => {
    const parsed = systemDeliveryOrderSchema.parse(makeBaseSystemOrder());
    expect(parsed.id).toBe('180000000000002');
    expect(parsed.status).toBe('IN_PROCESS');
    expect(parsed.delivered_quantity).toBe(3);
  });

  it('D4：9 字段全在 parsed output 里（strip-mode regression guard）', () => {
    const parsed = systemDeliveryOrderSchema.parse(makeBaseSystemOrder());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'id',
        'serial_no',
        'name',
        'quantity',
        'status',
        'system_delivery_date',
        'customer_name',
        'is_urgent',
        'delivered_quantity',
      ].sort(),
    );
  });

  it('D3：可空字段置 null 仍可 parse', () => {
    const parsed = systemDeliveryOrderSchema.parse(
      makeBaseSystemOrder({ serial_no: null, system_delivery_date: null, customer_name: null }),
    );
    expect(parsed.serial_no).toBeNull();
    expect(parsed.system_delivery_date).toBeNull();
  });

  // delivered_quantity 语义是 0（没交过），绝不能 nullable：partial 桶的判定
  // （已交过一部分）就靠它，缺失会被读成「有交过」。
  it('delivered_quantity：0 合法（未交过），null / 缺失 → 抛 ZodError', () => {
    expect(systemDeliveryOrderSchema.parse(makeBaseSystemOrder({ delivered_quantity: 0 })))
      .toMatchObject({ delivered_quantity: 0 });
    expect(() =>
      systemDeliveryOrderSchema.parse(makeBaseSystemOrder({ delivered_quantity: null })),
    ).toThrow();
    expect(() =>
      systemDeliveryOrderSchema.parse(omit(makeBaseSystemOrder(), 'delivered_quantity')),
    ).toThrow();
  });

  it('status 锁 OrderStatus 枚举（非法字面量 → 抛 ZodError）', () => {
    expect(() => systemDeliveryOrderSchema.parse(makeBaseSystemOrder({ status: 'NOPE' })))
      .toThrow();
  });

  it('必填：缺 id / name / quantity / status / is_urgent 任一 → 抛 ZodError', () => {
    for (const key of ['id', 'name', 'quantity', 'status', 'is_urgent']) {
      expect(() => systemDeliveryOrderSchema.parse(omit(makeBaseSystemOrder(), key))).toThrow();
    }
  });
});

describe('dashboardSnapshotSchema（快照 5 顶层字段）', () => {
  it('D1：完整 sample snapshot 通过', () => {
    const parsed = dashboardSnapshotSchema.parse(makeBaseSnapshot());
    expect(parsed.overdue_count).toBe(12);
    expect(parsed.in_inspection_count).toBe(4);
    expect(parsed.in_process).toHaveLength(1);
    expect(parsed.system_delivery_orders.urgent).toHaveLength(1);
    expect(parsed.system_delivery_orders.partial).toHaveLength(1);
    expect(parsed.system_delivery_orders.urgent[0]?.delivered_quantity).toBe(0);
  });

  // D7 全字段 guard：Zod strip 会静默丢未声明字段，正向断言 keys 才能兜住误删。
  it('D4：5 顶层字段全在 parsed output 里（含 system_delivery_orders 的两桶）', () => {
    const parsed = dashboardSnapshotSchema.parse(makeBaseSnapshot());
    expect(Object.keys(parsed).sort()).toEqual(
      ['overdue_count', 'in_inspection_count', 'in_process', 'system_delivery_orders', 'ts'].sort(),
    );
    expect(Object.keys(parsed.system_delivery_orders).sort()).toEqual(['partial', 'urgent']);
  });

  it('D3：空数组 + 零计数也接受（无在制 / 无交期工单 / 无逾期）', () => {
    const parsed = dashboardSnapshotSchema.parse({
      overdue_count: 0,
      in_inspection_count: 0,
      in_process: [],
      system_delivery_orders: { urgent: [], partial: [] },
      ts: '2026-10-07T14:30:00.123+08:00',
    });
    expect(parsed.in_process).toHaveLength(0);
    expect(parsed.system_delivery_orders.urgent).toHaveLength(0);
  });

  it('必填：缺 ts / in_process / overdue_count / in_inspection_count 任一 → 抛 ZodError', () => {
    for (const key of ['ts', 'in_process', 'overdue_count', 'in_inspection_count']) {
      expect(() => dashboardSnapshotSchema.parse(omit(makeBaseSnapshot(), key))).toThrow();
    }
  });

  it('必填：缺 system_delivery_orders 或其任一桶 → 抛 ZodError', () => {
    expect(() =>
      dashboardSnapshotSchema.parse(omit(makeBaseSnapshot(), 'system_delivery_orders')),
    ).toThrow();

    const oneBucket = {
      ...makeBaseSnapshot(),
      system_delivery_orders: { urgent: [] },
    };
    expect(() => dashboardSnapshotSchema.parse(oneBucket)).toThrow();
  });
});

describe('upcomingDeliveryBucketSchema（分桶单桶 3 字段）', () => {
  // count 是 COUNT(*)::bigint → JSON integer，非 snowflake ID 故不走字符串化路径。
  it('D5：count 是 number（传 string 抛错，防后端未来回归串行化）', () => {
    const parsed = upcomingDeliveryBucketSchema.parse(makeBaseBucket());
    expect(parsed.count).toBe(5);
    expect(() => upcomingDeliveryBucketSchema.parse(makeBaseBucket({ count: '5' }))).toThrow();
  });

  it('D4：3 字段全在 parsed output 里', () => {
    const parsed = upcomingDeliveryBucketSchema.parse(
      makeBaseBucket({ by_status: { PENDING: 3, INSPECTION: 2, DELIVERED: 1 } }),
    );
    expect(Object.keys(parsed).sort()).toEqual(['by_status', 'count', 'date']);
  });

  it('D3：by_status 是空对象 {} → parse 通过（合法零桶日）', () => {
    const parsed = upcomingDeliveryBucketSchema.parse(
      makeBaseBucket({ count: 0, by_status: {} }),
    );
    expect(parsed.by_status).toEqual({});
  });

  it('必填 / 类型：缺 date、缺 by_status、by_status value 串型或负数 → 抛 ZodError', () => {
    expect(() => upcomingDeliveryBucketSchema.parse({ count: 0, by_status: {} })).toThrow();
    expect(() => upcomingDeliveryBucketSchema.parse({ date: '2026-10-07', count: 0 })).toThrow();
    expect(() =>
      upcomingDeliveryBucketSchema.parse({ date: '2026-10-07', count: 1, by_status: { PENDING: '3' } }),
    ).toThrow();
    expect(() =>
      upcomingDeliveryBucketSchema.parse({ date: '2026-10-07', count: 1, by_status: { PENDING: -1 } }),
    ).toThrow();
  });
});

describe('upcomingBucketsSchema（分桶响应 3 顶层字段）', () => {
  it('D1：完整响应通过，today 与 buckets[0].date 是同一个值', () => {
    const parsed = upcomingBucketsSchema.parse(makeBaseBuckets());
    expect(parsed.today).toBe('2026-10-07');
    expect(parsed.buckets[0]?.date).toBe(parsed.today);
    expect(parsed.buckets).toHaveLength(1);
  });

  it('D4：3 顶层字段全在 parsed output 里', () => {
    const parsed = upcomingBucketsSchema.parse(makeBaseBuckets());
    expect(Object.keys(parsed).sort()).toEqual(['buckets', 'today', 'ts']);
  });

  // today 是柱状图「今天」的唯一锚点，缺它前端只能回落 new Date()（时区不同步即错位）。
  it('必填：缺 today / buckets / ts 任一 → 抛 ZodError', () => {
    for (const key of ['today', 'buckets', 'ts']) {
      expect(() => upcomingBucketsSchema.parse(omit(makeBaseBuckets(), key))).toThrow();
    }
  });
});

describe('deliveryOrderDetailSchema（下钻行 9 字段）', () => {
  it('D1：完整 9 字段 parse 通过', () => {
    const parsed = deliveryOrderDetailSchema.parse(makeBaseDetail());
    expect(parsed.id).toBe('180000000000003');
    expect(parsed.drawing_no).toBe('DWG-001');
    expect(parsed.l1_customer_name).toBe('南海集团');
  });

  it('D4：9 字段全在 parsed output 里', () => {
    const parsed = deliveryOrderDetailSchema.parse(makeBaseDetail());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'id',
        'serial_no',
        'drawing_no',
        'name',
        'l1_customer_name',
        'customer_name',
        'status',
        'planned_delivery_date',
        'system_delivery_date',
      ].sort(),
    );
  });

  it('D3：可空字段置 null 仍可 parse（system_delivery_date 可空是系统口径的前提）', () => {
    const parsed = deliveryOrderDetailSchema.parse(
      makeBaseDetail({
        serial_no: null,
        l1_customer_name: null,
        customer_name: null,
        system_delivery_date: null,
      }),
    );
    expect(parsed.system_delivery_date).toBeNull();
  });

  it('必填：缺 planned_delivery_date（NOT NULL 列）/ id / drawing_no / name / status → 抛 ZodError', () => {
    for (const key of ['id', 'drawing_no', 'name', 'status', 'planned_delivery_date']) {
      expect(() => deliveryOrderDetailSchema.parse(omit(makeBaseDetail(), key))).toThrow();
    }
  });
});

describe('deliveryOrderDetailOutSchema（下钻响应 5 顶层字段）', () => {
  it('D1：完整响应通过，total 与 items 解耦', () => {
    const parsed = deliveryOrderDetailOutSchema.parse(makeBaseDetailOut());
    expect(parsed.date).toBe('2026-10-07');
    expect(parsed.basis).toBe('system');
    expect(parsed.total).toBe(17);
    expect(parsed.items).toHaveLength(1);
  });

  it('D4：5 顶层字段全在 parsed output 里', () => {
    const parsed = deliveryOrderDetailOutSchema.parse(makeBaseDetailOut());
    expect(Object.keys(parsed).sort()).toEqual(['basis', 'date', 'items', 'total', 'ts']);
  });

  // total 是抽屉头部「共 N 件」的唯一来源，误删声明会让它静默变 undefined 并被
  // `?? 0` 渲染成「共 0 件」。
  it('必填：缺 total / date / basis / items / ts 任一 → 抛 ZodError', () => {
    for (const key of ['total', 'date', 'basis', 'items', 'ts']) {
      expect(() => deliveryOrderDetailOutSchema.parse(omit(makeBaseDetailOut(), key))).toThrow();
    }
  });
});
