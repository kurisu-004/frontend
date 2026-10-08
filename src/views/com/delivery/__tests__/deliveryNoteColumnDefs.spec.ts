// src/views/com/delivery/__tests__/deliveryNoteColumnDefs.spec.ts
//
// 2026-10-08 新增：**列快照 key 不可变**的回归守卫。
//
// 列可见性 / 列顺序快照存在 localStorage（key = listKey），快照里存的是「列 key 数组」。
// 改 key / 改顺序 ⇒ 老用户已配好的列整体失效，而且这种失效**没有任何报错**（用
// ColumnVisibilityPopover 的人只会觉得「我的列设置怎么没了」）。所以这三个文件的
// 列 key 与顺序在本文件里钉死：
//   · delivery_note_list           —— 一览 8 列（deliveryNoteColumnDefs）
//   · delivery_note_detail_line_items —— 详情 12 列（deliveryNoteLineItemsColumnDefs）
//   · print_preview_dialog         —— 打印 8 列（deliveryNotePrintColumnDefs）；列**顺序**
//     另按分组分片存 `print_preview_dialog__<groupKey>`（每张分组表一条序列）
//
// 2026-10-09：详情表行由批次行改为零件 / 装配件行 ⇒ 删 `batch_label`（批次号不再单列，
// 一行代表同零件的多个批次），13 列变 12 列。**删列是安全的**：`useColumnVisibility` 的
// 恢复是 lenient 的（只取 defs 里存在的 key，缺失 key 按新增列追加到末尾），老快照里的
// `batch_label` 会被直接剔除、不报错。反过来「改 key 名」才是会让快照静默失效的动作，
// 那才必须连本文件一起改。
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
  printColumnOrderListKey,
  PRINT_PREVIEW_LIST_KEY,
} from '../deliveryNotePrintColumnDefs';
import type { DeliveryNoteItemData } from '../composables/deliveryNoteSchema';
import type { PrintRow } from '../utils/deliveryNotePrintRows';
import type { ColumnDef } from '@/composables/useColumnVisibility';

/** 打印对话框的列定义（按 key 取，宽度守卫用）。 */
function printCol(key: string): ColumnDef {
  const col = buildDeliveryNotePrintColumnDefs().find((d) => d.key === key);
  if (!col) throw new Error(`打印列定义里没有 key=${key}`);
  return col;
}

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

  it('详情页 12 列（批次列已删），其余 key 与顺序未变', () => {
    expect(buildDeliveryNoteLineItemsColumnDefs().map((d) => d.key)).toEqual([
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
    // 批次列已下线：行是零件级折叠，一行可能代表同零件的多个批次
    expect(buildDeliveryNoteLineItemsColumnDefs().map((d) => d.key)).not.toContain('batch_label');
  });

  it('打印对话框 8 列，key 与 2026-10-08 之前完全一致（数量 / 操作列不进 defs）', () => {
    const keys = buildDeliveryNotePrintColumnDefs().map((d) => d.key);
    expect(keys).toEqual([
      'index',
      'order_no',
      // 「分厂」列的 key 是老快照里的 customer_name（行数据字段叫 l2_customer，渲染取它）
      'customer_name',
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

  it('打印对话框的列顺序快照按分组后缀分片（每张分组表一条序列）', () => {
    expect(printColumnOrderListKey('g_7')).toBe('print_preview_dialog__g_7');
    expect(printColumnOrderListKey('c_13')).toBe('print_preview_dialog__c_13');
  });
});

describe('打印表表头「不折行」的宽度预算（本次改动的价值就是这几个像素）', () => {
  /**
   * 预算公式（见 deliveryNotePrintColumnDefs.ts 文件头）：表头内容 = 列名 + 拖动手柄(16px)
   * + 排序箭头(24px，仅 sortable 列有) + `.cell` 左右 padding(24px)，而 EP 的 `.cell` 是
   * `white-space: normal` + `overflow-wrap: break-word` ⇒ 装不下就折成两段。
   * 表头字号 14px，汉字约 1em = 14px/字。
   */
  const HANDLE = 16;
  const SORT_ARROW = 24;
  const CELL_PADDING = 24;
  /** 一列「表头不折行」所需的最小宽度（px）。 */
  function needed(col: ColumnDef): number {
    return [...col.label].length * 14 + (col.sortable ? SORT_ARROW : 0) + HANDLE + CELL_PADDING;
  }

  it('「申请人」≥ 106（100 装不下 —— 用户报的两条折行之一）', () => {
    const col = printCol('applicant_name');
    // 3 个汉字 = 42px；42 + 16 + 24 + 24 = 106
    expect(needed(col)).toBe(106);
    expect(col.minWidth).toBeGreaterThanOrEqual(106);
  });

  it('「预估交期」≥ 120（110 装不下 —— 用户报的两条折行之一）', () => {
    const col = printCol('system_delivery_date');
    // 4 个汉字 = 56px；56 + 16 + 24 + 24 = 120
    expect(needed(col)).toBe(120);
    expect(col.minWidth).toBeGreaterThanOrEqual(120);
  });

  it('打印表每一列都够「表头不折行」的预算（别只修被报出来的那两列）', () => {
    for (const col of buildDeliveryNotePrintColumnDefs()) {
      // 序号列是固定 `width`、其余是 `minWidth`，两者都参与 EP 的列宽计算。
      const w = col.minWidth ?? col.width ?? 0;
      expect(w, `「${col.label}」宽 ${w} < 预算 ${needed(col)}，表头会折行`).toBeGreaterThanOrEqual(
        needed(col),
      );
    }
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
