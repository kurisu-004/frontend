// src/views/com/delivery/composables/__tests__/deliveryNoteSchema.spec.ts
//
// 2026-10-08 新增：Zod 守门 schema 的行为守卫。
//
// 守门 schema 的全部价值在于「**字段全声明**」：Zod 默认 strip 会把没声明的键静默丢掉
// —— 后端加字段不报错、前端读不到，两边都以为是对的。所以本文件对每个 schema 钉三类
// 输入：合法 / 缺必填字段 / 类型错，外加 `skip_serializing_if` 字段**缺失**这一态
// （它与「值为 null」是两种语义，不能合并）。

import { describe, expect, it } from 'vitest';
import {
  deliveryDriverListResultSchema,
  deliveryNoteBatchDetailResultSchema,
  deliveryNoteDetailSchema,
  deliveryNoteItemSchema,
  deliveryNoteLineItemSchema,
  deliveryNoteListResultSchema,
} from '../deliveryNoteSchema';
import { deliveryGroupListResultSchema } from '../deliveryGroupSchema';
import { deliveryScanTreeSchema } from '../deliveryScanTreeSchema';

function item(p: Record<string, unknown> = {}) {
  return {
    id: '9007199254740993',
    version: 3,
    delivery_note_no: 'DN-20260110-0007',
    customer_id: '1',
    customer_name: '法拉电子',
    customer_path: '法拉电子 / 法拉',
    status: 'DRAFT',
    submitted_at: null,
    picked_up_at: null,
    driver_worker_name: null,
    part_count: 2,
    note: null,
    delivery_date: '2026-01-10',
    ...p,
  };
}

function lineItem(p: Record<string, unknown> = {}) {
  return {
    id: '225132995307110400',
    part_id: '208421321317548032',
    version: 7,
    batch_no: 2,
    batch_label: 'L2',
    serial_no: 'F1001-01',
    drawing_no: 'DWG-1',
    name: '铝电解电容',
    quantity: 5,
    status: 'READY_TO_SHIP',
    applicant_name: '张三',
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: '2026-11-01',
    order_no: 'SO-1',
    note: null,
    customer_name: '法拉',
    parent_customer_name: '法拉电子',
    customer_path: '法拉电子 / 法拉',
    assembly_id: null,
    assembly_serial_no: null,
    assembly_drawing_no: null,
    assembly_name: null,
    assembly_order_no: null,
    ...p,
  };
}

describe('deliveryNoteItemSchema', () => {
  it('合法对象全字段保留', () => {
    const parsed = deliveryNoteItemSchema.parse(item());
    expect(parsed.part_count).toBe(2);
    expect(parsed.id).toBe('9007199254740993');
  });

  it('status 不锁字面量（后端新增枚举不炸）', () => {
    expect(deliveryNoteItemSchema.parse(item({ status: 'FUTURE' })).status).toBe('FUTURE');
  });

  it('缺必填字段 → 抛（part_count 少一个就红）', () => {
    const bad = item();
    delete (bad as any).part_count;
    expect(() => deliveryNoteItemSchema.parse(bad)).toThrow();
  });

  it('类型错（part_count 是字符串）→ 抛', () => {
    expect(() => deliveryNoteItemSchema.parse(item({ part_count: '2' }))).toThrow();
  });

  it('可空字段给 undefined 也接（后端字段缺失时的宽容侧只对 nullish 字段开）', () => {
    expect(() => deliveryNoteItemSchema.parse(item({ note: null }))).not.toThrow();
  });

  it('strip 生效：未声明的键被丢掉（这正是「必须全声明」的理由）', () => {
    const parsed = deliveryNoteItemSchema.parse(item({ driver_worker_id: '77' }));
    expect('driver_worker_id' in parsed).toBe(false);
  });
});

describe('deliveryNoteLineItemSchema', () => {
  it('两个套数字段缺失（后端 skip_serializing_if 未上线）→ 接，不兜 0', () => {
    const parsed = deliveryNoteLineItemSchema.parse(lineItem());
    expect(parsed.shippable_sets).toBeUndefined();
    expect(parsed.assembly_quantity).toBeUndefined();
  });

  it('两个套数字段显式 null → 也是 null（与缺失不同义，两态都接）', () => {
    const parsed = deliveryNoteLineItemSchema.parse(
      lineItem({ shippable_sets: null, assembly_quantity: null }),
    );
    expect(parsed.shippable_sets).toBeNull();
  });

  it('version 必填（批次 OCC 锚，缺了 remove-batches 会静默不带锚）', () => {
    const bad = lineItem();
    delete (bad as any).version;
    expect(() => deliveryNoteLineItemSchema.parse(bad)).toThrow();
  });

  it('batch_no / batch_label 可空', () => {
    expect(deliveryNoteLineItemSchema.parse(lineItem({ batch_no: null })).batch_no).toBeNull();
  });
});

describe('deliveryNoteDetailSchema', () => {
  it('本体字段集合与 deliveryNoteItemSchema 一致 + line_items（flatten 的前端镜像）', () => {
    const detail = deliveryNoteDetailSchema.parse({ ...item(), line_items: [lineItem()] });
    expect(detail.line_items).toHaveLength(1);
    const itemKeys = Object.keys(deliveryNoteItemSchema.shape).sort();
    const detailKeys = Object.keys(detail).filter((k) => k !== 'line_items').sort();
    expect(detailKeys).toEqual(itemKeys);
  });

  it('line_items 缺字段 → 抛', () => {
    expect(() => deliveryNoteDetailSchema.parse({ ...item(), line_items: [{ id: '1' }] })).toThrow();
  });
});

describe('列表 / 批量详情 信封', () => {
  it('分页四字段是 JSON number（不是字符串）', () => {
    const parsed = deliveryNoteListResultSchema.parse({
      items: [item()],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(parsed.total).toBe(1);
    expect(() =>
      deliveryNoteListResultSchema.parse({ items: [], total: '1', limit: 50, offset: 0 }),
    ).toThrow();
  });

  it('批量详情包 items 详情数组', () => {
    const parsed = deliveryNoteBatchDetailResultSchema.parse({
      items: [{ ...item(), line_items: [] }],
    });
    expect(parsed.items).toHaveLength(1);
  });
});

describe('deliveryGroupListResultSchema', () => {
  it('合法 groups + ungrouped_customers', () => {
    const parsed = deliveryGroupListResultSchema.parse({
      groups: [{ id: '7', name: '二五六厂', members: [{ customer_id: '11', customer_name: '陆达' }], version: 1 }],
      ungrouped_customers: [{ id: '13', name: '法拉' }],
    });
    expect(parsed.groups[0]!.members[0]!.customer_id).toBe('11');
  });

  it('成员缺 customer_name → 抛（分组面板要按名渲染标签）', () => {
    expect(() =>
      deliveryGroupListResultSchema.parse({
        groups: [{ id: '7', name: 'x', members: [{ customer_id: '11' }], version: 1 }],
        ungrouped_customers: [],
      }),
    ).toThrow();
  });
});

describe('deliveryDriverListResultSchema', () => {
  it('雪花 id 是 string', () => {
    const parsed = deliveryDriverListResultSchema.parse({
      items: [{ id: '207145104975069184', name: '张三', badge_code: 'A001' }],
    });
    expect(parsed.items[0]!.id).toBe('207145104975069184');
  });

  it('id 是 number → 抛（后端走 serialize_i64，发的一定是 string）', () => {
    expect(() =>
      deliveryDriverListResultSchema.parse({
        items: [{ id: 207, name: '张三', badge_code: 'A001' }],
      }),
    ).toThrow();
  });
});

describe('deliveryScanTreeSchema', () => {
  const tree = {
    hit_kind: 'ASSEMBLY',
    scanned_serial_no: 'F1001',
    draft: { note_id: 'N1', note_no: 'DN-1', version: 5, status: 'DRAFT' },
    assembly: {
      id: 'A1',
      serial_no: 'F1001',
      name: '总装',
      drawing_no: 'ASM-1',
      status: 'READY_TO_SHIP',
      quantity: 3,
      is_urgent: false,
      system_delivery_date: null,
      customer_name: '法拉',
      customer_id: '11',
      entry_max_sets: 2,
      per_set_parts: [{ part_id: 'P1', per_set_quantity: 3 }],
    },
    children: [
      {
        id: 'P1',
        serial_no: 'F1001-01',
        name: '子件',
        drawing_no: 'D-1',
        status: 'READY_TO_SHIP',
        quantity: 9,
        is_urgent: false,
        system_delivery_date: null,
        customer_name: '法拉',
        version: 1,
        customer_id: '11',
        entry_max_quantity: 5,
        children: [
          {
            id: 'B1',
            batch_no: 1,
            quantity: 5,
            status: 'READY_TO_SHIP',
            version: 3,
            is_repairing: false,
            location: 'PRODUCTION_SHELF',
            current_holder_display: null,
            process_name: null,
            is_scanned: false,
            occupied_by_note_no: 'DN-20260101-0002',
          },
        ],
      },
    ],
  };

  it('三层树整体通过', () => {
    const parsed = deliveryScanTreeSchema.parse(tree);
    expect(parsed.assembly?.entry_max_sets).toBe(2);
    expect(parsed.children[0]!.children[0]!.occupied_by_note_no).toBe('DN-20260101-0002');
  });

  it('entry_max_* / occupied_by_note_no 缺一个就红（入单闸门的依据）', () => {
    const bad = structuredClone(tree) as unknown as Record<string, never>;
    delete (bad.children as any)[0].entry_max_quantity;
    expect(() => deliveryScanTreeSchema.parse(bad)).toThrow();
  });

  it('draft: null（该 L1 下还没有草稿）→ 接', () => {
    expect(deliveryScanTreeSchema.parse({ ...tree, draft: null }).draft).toBeNull();
  });

  it('assembly: null（独立件树）→ 接', () => {
    const parsed = deliveryScanTreeSchema.parse({ ...tree, assembly: null });
    expect(parsed.assembly).toBeNull();
  });
});
