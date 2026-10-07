// src/views/com/delivery/__tests__/deliveryNoteColumnDefs.spec.ts
//
// 2026-10-08 新增：**列快照 key 不可变**的回归守卫。
//
// 列可见性 / 列顺序快照存在 localStorage（key = listKey），快照里存的是「列 key 数组」。
// 改 key / 改顺序 ⇒ 老用户已配好的列整体失效，而且这种失效**没有任何报错**（用
// ColumnVisibilityPopover 的人只会觉得「我的列设置怎么没了」）。所以这三个文件的
// 列 key 与顺序在本文件里钉死：
//   · delivery_note_list           —— 一览 8 列（deliveryNoteColumnDefs）
//   · delivery_note_detail_line_items —— 详情 13 列（deliveryNoteLineItemsColumnDefs）
//   · print_preview_dialog         —— 打印 6 列（deliveryNotePrintColumnDefs）
//
// 另钉：行类型与 schema 的 z.infer 同源（`export type XxxRow = XxxItemData`）——
// 改 schema 时忘了同步列渲染，TS 会在这里报错。

import { describe, expect, it } from 'vitest';
import { buildDeliveryNoteColumnDefs, DELIVERY_NOTE_LIST_KEY } from '../deliveryNoteColumnDefs';
import {
  buildDeliveryNoteLineItemsColumnDefs,
  DELIVERY_NOTE_LINE_ITEMS_LIST_KEY,
} from '../deliveryNoteLineItemsColumnDefs';
import {
  buildDeliveryNotePrintColumnDefs,
  PRINT_PREVIEW_LIST_KEY,
} from '../deliveryNotePrintColumnDefs';
import type { DeliveryNoteItemData } from '../composables/deliveryNoteSchema';
import type { PrintRow } from '../utils/deliveryNotePrintRows';

describe('列 key 与顺序（改了就让老用户列设置失效）', () => {
  it('送货单一览 8 列，顺序与 2026-10-08 之前完全一致', () => {
    expect(buildDeliveryNoteColumnDefs().map((d) => d.key)).toEqual([
      'delivery_note_no',
      'delivery_date',
      'customer',
      'status',
      'part_count',
      'submitted_at',
      'picked_up_at',
      'driver_worker_name',
    ]);
  });

  it('详情页 13 列，顺序与 2026-10-08 之前完全一致', () => {
    expect(buildDeliveryNoteLineItemsColumnDefs().map((d) => d.key)).toEqual([
      'batch_label',
      'serial_no',
      'drawing_no',
      'order_no',
      'name',
      'customer',
      'applicant_name',
      'quantity',
      'request_date',
      'planned_delivery_date',
      'system_delivery_date',
      'note',
      'status',
    ]);
  });

  it('打印对话框 6 列（数量 / 操作列不进 defs）', () => {
    const keys = buildDeliveryNotePrintColumnDefs().map((d) => d.key);
    expect(keys).toEqual([
      'index',
      'order_no',
      'l2_customer',
      'applicant_name',
      'drawing_no',
      'name',
      'system_delivery_date',
      'note',
    ]);
    // 数量列只读、操作列无列设置 —— 两者都不该出现在列可见性 map 里
    expect(keys).not.toContain('quantity');
    expect(keys).not.toContain('actions');
  });

  it('三个 listKey 沿用既有 localStorage key（不许改）', () => {
    expect(DELIVERY_NOTE_LIST_KEY).toBe('delivery_note_list');
    expect(DELIVERY_NOTE_LINE_ITEMS_LIST_KEY).toBe('delivery_note_detail_line_items');
    expect(PRINT_PREVIEW_LIST_KEY).toBe('print_preview_dialog');
  });
});

describe('行类型与 schema 的 z.infer 同源', () => {
  it('列表行类型 = deliveryNoteItemSchema 的 z.infer', () => {
    // 编译期保证：这里只断「一行最小可赋值对象能通过类型检查」。
    const row: DeliveryNoteItemData = {
      id: '1',
      version: 1,
      delivery_note_no: 'DN-1',
      customer_id: 'C1',
      customer_name: null,
      customer_path: null,
      status: 'DRAFT',
      submitted_at: null,
      picked_up_at: null,
      driver_worker_name: null,
      part_count: 0,
      note: null,
      delivery_date: null,
    };
    expect(row.delivery_note_no).toBe('DN-1');
  });

  it('打印行类型带折叠所需的装配件字段与 nullable 数量', () => {
    const row: PrintRow = {
      id: 'ASM_A1',
      order_no: 'SO-1',
      l2_customer: '法拉',
      applicant_name: '张三',
      drawing_no: 'ASM-1',
      name: '总装',
      quantity: null,
      unit: '套',
      system_delivery_date: null,
      note: '',
      is_asm_row: true,
      member_ids: ['1', '2'],
    };
    expect(row.quantity).toBeNull();
    expect(row.member_ids).toHaveLength(2);
  });
});
