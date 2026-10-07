// src/views/com/delivery/composables/__tests__/deliveryNoteSchema.spec.ts
//
// 2026-10-08 新增：Zod 守门 schema 的行为守卫。
//
// 守门 schema 的全部价值在于「**字段全声明**」：Zod 默认 strip 会把没声明的键静默丢掉
// —— 后端加字段不报错、前端读不到，两边都以为是对的。所以本文件对每个 schema 钉三类
// 输入：合法 / 缺必填字段 / 类型错，外加 `skip_serializing_if` 字段**缺失**这一态
// （它与「值为 null」是两种语义，不能合并）。
//
// ⚠️ **下半部分的 `BACKEND_VO_*` 清单是本文件的核心**，它把「schema 声明的东西后端真的
// 会发」变成可执行断言 —— 在它出现之前，本文件只有一条「schema 对 schema」的字段集合
// 比对（detail vs lineItem），那种比对**结构上不可能**发现与后端 VO 的偏差，于是
// 「行项必填 version（后端没有）」「assembly_id 必填键（后端散件时整个 skip）」两个
// 运行时炸弹都能全绿通过、把详情页与草稿看板打成永久空白。

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
    customer_id: '11',
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

  it('可空字段给 null 也接（后端 `Option<T>` 无 serde 属性时恒发 null）', () => {
    expect(() => deliveryNoteItemSchema.parse(item({ note: null }))).not.toThrow();
  });

  it('strip 生效：未声明的键被丢掉（这正是「必须全声明」的理由）', () => {
    const parsed = deliveryNoteItemSchema.parse(item({ driver_worker_id: '77' }));
    expect('driver_worker_id' in parsed).toBe(false);
  });
});

describe('deliveryNoteLineItemSchema', () => {
  it('两个套数字段缺失（键整个没有）→ 接，不兜 0', () => {
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

  it('assembly_id 键整个不存在（散件行的真实 wire）→ 接（B2 回归）', () => {
    // 后端装配是 `assembly_id: asm.map(|a| a.id)`，散件 ⇒ None ⇒ 被 skip_serializing_if
    // 抹掉。写成 `.nullable()`（键必填）时这一行直接 parse 抛 ⇒ 详情页 / 草稿看板空白。
    const raw = lineItem();
    delete (raw as Record<string, unknown>).assembly_id;
    const parsed = deliveryNoteLineItemSchema.parse(raw);
    expect(parsed.assembly_id).toBeUndefined();
    expect(parsed.id).toBe('225132995307110400');
  });

  it('后端从不发 version：不在 schema 里（多声明一个必填字段 = 详情页当场炸）', () => {
    // 回归守卫：`version` 是纯 TS 类型时代留下的幻觉字段，后端 VO 没有它。
    expect('version' in deliveryNoteLineItemSchema.shape).toBe(false);
    // 真发一个 version 进来也会被 strip（不参与任何写端点调用）。
    const parsed = deliveryNoteLineItemSchema.parse(lineItem({ version: 7 }));
    expect('version' in parsed).toBe(false);
  });

  it('customer_id 缺失（后端尚未补该字段的过渡期）→ 接，打印分组退化为按名兜底', () => {
    const raw = lineItem();
    delete (raw as Record<string, unknown>).customer_id;
    expect(deliveryNoteLineItemSchema.parse(raw).customer_id).toBeUndefined();
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

// ============================================================================
// 后端 VO 字段名清单（**本文件的核心护栏**）
//
// 2026-10-08 review 第 1 轮加。两个 blocker（行项必填 `version` / `assembly_id` 键必填）
// 的共同根因是：字段集合的一致性断言拿「schema 对 schema」互比，而 Zod 是**运行时**
// 闸门 —— 与后端 VO 的偏差只能在真响应上暴露，页面当场空白。这里把后端 VO 的字段名
// 手抄成常量，让偏差变成必红的单测（而不是线上空白页）。
//
// ⚠️⚠️ **改名义务**（与后端同源，改一边必须同改另一边）：
//   · 增删 / 改名字段 → 后端 `modules/com/delivery_note/vo/{delivery_note,delivery_group,
//     driver,scan_tree}.rs` **与**本清单同批改。漏改的后果分两种：schema 声明了清单外
//     的字段 = 运行时 parse 抛（本轮两个 blocker 就是这么来的）；清单里多一个已删字段 =
//     护栏变松（无声，但方向安全）。
//   · 后端给字段加 / 去 `skip_serializing_if` → `BACKEND_VO_SKIPPED_FIELDS` 同批改。
//   · 前端给字段加 `.nullish()`（比 VO 更宽）→ `SCHEMA_WIDER_THAN_VO` 必须登记理由，
//     否则「为什么这个字段是 nullish」没人查得到，久了就没人敢动。
// ============================================================================

/** Zod object 的 shape（只用到 safeParse，避开 zod 的具体类型体操）。 */
type AnyShape = Record<string, { safeParse: (v: unknown) => { success: boolean } }>;

/** `vo/delivery_note.rs::DeliveryNoteOut`（`created_at` 后端保留、前端零读，未声明）。 */
const BACKEND_VO_DELIVERY_NOTE_OUT = [
  'id',
  'version',
  'delivery_note_no',
  'customer_id',
  'customer_name',
  'customer_path',
  'status',
  'submitted_at',
  'picked_up_at',
  'driver_worker_name',
  'part_count',
  'note',
  'delivery_date',
  'created_at',
];

/**
 * `vo/delivery_note.rs::DeliveryNoteLineItem`（后端 2026-10-08 裁掉了 `is_urgent` /
 * `is_scanned` / `scanned` 三个恒定值字段）。
 */
const BACKEND_VO_LINE_ITEM = [
  'id',
  'part_id',
  'batch_no',
  'batch_label',
  'serial_no',
  'drawing_no',
  'name',
  'quantity',
  'status',
  'applicant_name',
  'request_date',
  'planned_delivery_date',
  'system_delivery_date',
  'order_no',
  'note',
  'customer_name',
  // 2026-10-08 本轮后端补：L2 叶子客户 id（打印分组键）。补齐前的 wire 上没有该键。
  'customer_id',
  'parent_customer_name',
  'customer_path',
  'assembly_id',
  'assembly_serial_no',
  'assembly_drawing_no',
  'assembly_name',
  'assembly_order_no',
  'assembly_quantity',
  'shippable_sets',
];

/** `vo/delivery_note.rs::DeliveryNoteDetailOut` = `#[serde(flatten)] head` + line_items。 */
const BACKEND_VO_DETAIL_OUT = [...BACKEND_VO_DELIVERY_NOTE_OUT, 'line_items'];

/** `vo/scan_tree.rs::DeliveryScanTreeOut`。 */
const BACKEND_VO_SCAN_TREE = ['hit_kind', 'scanned_serial_no', 'draft', 'assembly', 'children'];

/** `vo/driver.rs::DeliveryDriverOption`（列表项）。 */
const BACKEND_VO_DRIVER_OPTION = ['id', 'name', 'badge_code'];

/** `vo/delivery_group.rs::DeliveryGroupListOut`。 */
const BACKEND_VO_GROUP_LIST = ['groups', 'ungrouped_customers'];

/**
 * 后端带 `skip_serializing_if = "Option::is_none"` 的字段（**键会整个消失**）。
 * 这类字段在前端**必须**是 `.nullish()`，否则空值行 / 散件行直接 parse 抛。
 * `DeliveryNoteOut` 的 `Option<i64>` 已被 2026-10-08 的字段裁剪全部删掉，故这里是空表。
 */
const BACKEND_VO_SKIPPED_FIELDS: Record<string, readonly string[]> = {
  lineItem: ['assembly_id'],
};

/**
 * schema 比后端 VO **更宽**的字段（接受 undefined，而后端恒发值）。安全方向（多一个键
 * 也不会炸），但必须登记理由，否则「为什么这里是 nullish」无从查证。
 */
const SCHEMA_WIDER_THAN_VO: Record<string, string> = {
  'lineItem.customer_id':
    '后端 2026-10-08 本轮补齐该字段；补齐前的响应里没有它，schema 先按 .nullish 过渡' +
    '（打印分组退化为按 customer_name 兜底）。后端上线后本条即可删。',
  'lineItem.assembly_quantity':
    '后端是裸 Option<i32>（无 skip_serializing_if，恒发 null）；.nullish() 是超集，行为不变。',
  'lineItem.shippable_sets':
    '后端是裸 Option<i32>（无 skip_serializing_if，恒发 null）；.nullish() 是超集，行为不变。',
};

/** schema 里「键必填」的字段（safeParse(undefined) 失败）。 */
function requiredKeysOf(shape: unknown): string[] {
  return Object.entries(shape as AnyShape)
    .filter(([, v]) => !v.safeParse(undefined).success)
    .map(([k]) => k);
}

/** schema 里「键可缺」的字段（safeParse(undefined) 成功）。 */
function optionalKeysOf(shape: unknown): string[] {
  return Object.entries(shape as AnyShape)
    .filter(([, v]) => v.safeParse(undefined).success)
    .map(([k]) => k);
}

/** driver 列表 schema 的行对象形状（`items` 是 ZodArray ⇒ 取 `.element.shape`）。 */
function driverOptionShape(): AnyShape {
  const items = deliveryDriverListResultSchema.shape.items as unknown as {
    element: { shape: AnyShape };
  };
  return items.element.shape;
}

describe('后端 VO 字段名清单护栏（schema ↔ 后端 VO，不是 schema ↔ schema）', () => {
  it('行项：每个必填字段都能在后端 DeliveryNoteLineItem 找到', () => {
    const unknown = requiredKeysOf(deliveryNoteLineItemSchema.shape).filter(
      (k) => !BACKEND_VO_LINE_ITEM.includes(k),
    );
    expect(
      unknown,
      `schema 必填了后端 VO 没有的字段：${unknown.join('、')}（真实响应上会 parse 抛）`,
    ).toEqual([]);
  });

  it('列表行 / 详情本体：每个必填字段都能在后端 VO 找到', () => {
    const outUnknown = requiredKeysOf(deliveryNoteItemSchema.shape).filter(
      (k) => !BACKEND_VO_DELIVERY_NOTE_OUT.includes(k),
    );
    const detailUnknown = requiredKeysOf(
      Object.fromEntries(
        Object.entries(deliveryNoteDetailSchema.shape).filter(([k]) => k !== 'line_items'),
      ),
    ).filter((k) => !BACKEND_VO_DETAIL_OUT.includes(k));
    expect(outUnknown, `列表行必填了后端没有的字段：${outUnknown.join('、')}`).toEqual([]);
    expect(detailUnknown, `详情本体必填了后端没有的字段：${detailUnknown.join('、')}`).toEqual([]);
  });

  it('行项：清单里的每个字段都能在 schema 里找到（漏抄 / 漏声明双向可查）', () => {
    const missing = BACKEND_VO_LINE_ITEM.filter((k) => !(k in deliveryNoteLineItemSchema.shape));
    // 后端有、前端零读的字段会落在这里 —— 那不是 bug（Zod strip 无害），但必须是有意识
    // 的零读；本域现状是空集（唯一例外 `created_at` 在 DeliveryNoteOut 上，已在注释登记）。
    expect(missing).toEqual([]);
  });

  it('后端带 skip_serializing_if 的字段，schema 必须能接 undefined（B2 那类故障的护栏）', () => {
    for (const key of BACKEND_VO_SKIPPED_FIELDS.lineItem) {
      const field = (deliveryNoteLineItemSchema.shape as AnyShape)[key];
      expect(
        field.safeParse(undefined).success,
        `${key} 后端带 skip_serializing_if（键会消失），schema 却声明成键必填`,
      ).toBe(true);
    }
  });

  it('schema 比 VO 更宽的字段都在登记表里（带理由），且登记无陈旧', () => {
    const skipped = BACKEND_VO_SKIPPED_FIELDS.lineItem;
    const wider = optionalKeysOf(deliveryNoteLineItemSchema.shape).filter((k) => !skipped.includes(k));
    const unregistered = wider.filter((k) => !SCHEMA_WIDER_THAN_VO[`lineItem.${k}`]);
    expect(unregistered, `这些字段接了 undefined 但没登记理由：${unregistered.join('、')}`).toEqual([]);
    const stale = Object.keys(SCHEMA_WIDER_THAN_VO).filter((k) => !wider.includes(k.split('.')[1]!));
    expect(stale, `SCHEMA_WIDER_THAN_VO 有陈旧登记：${stale.join('、')}`).toEqual([]);
  });

  it('扫码树 / 司机 / 分组：必填字段都能在后端 VO 找到', () => {
    const unknown = [
      ...requiredKeysOf(deliveryScanTreeSchema.shape)
        .filter((k) => !BACKEND_VO_SCAN_TREE.includes(k))
        .map((k) => `scanTree.${k}`),
      ...requiredKeysOf(driverOptionShape())
        .filter((k) => !BACKEND_VO_DRIVER_OPTION.includes(k))
        .map((k) => `driver.${k}`),
      ...requiredKeysOf(deliveryGroupListResultSchema.shape)
        .filter((k) => !BACKEND_VO_GROUP_LIST.includes(k))
        .map((k) => `group.${k}`),
    ];
    expect(unknown, `下列必填字段不在对应后端 VO 里：${unknown.join('、')}`).toEqual([]);
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
