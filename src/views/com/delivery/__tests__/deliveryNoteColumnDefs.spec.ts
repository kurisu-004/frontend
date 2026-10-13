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
import type { PartTreeRow } from '../utils/deliveryNotePartRows';
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
      // 客户列的 key 是老快照里的 customer_name（行数据字段叫 l2_customer，渲染取它）
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

// ============================================================================
// 客户列的两行形态（2026-10-17 客户无限层级改造）
// ============================================================================

describe('客户列渲染：主行 customer_path + 次行 L1', () => {
  /** cellRender 产物 → 递归纯文本 + 根 class。 */
  function renderOf(v: unknown): { text: string; cls: string } {
    const node = v as { children?: unknown; props?: { class?: unknown } };
    const cls = Array.isArray(node.props?.class)
      ? (node.props?.class as string[]).join(' ')
      : String(node.props?.class ?? '');
    const kids = node.children;
    let text = '';
    if (typeof kids === 'string') text = kids;
    else if (Array.isArray(kids)) {
      text = kids
        .map((c) => (typeof c === 'object' && c !== null ? renderOf(c).text : ''))
        .join('');
    }
    return { text, cls };
  }

  function renderCol(defs: ColumnDef[], key: string, row: unknown): { text: string; cls: string } {
    const col = defs.find((d) => d.key === key);
    if (!col?.cellRender) throw new Error(`列 ${key} 缺 cellRender`);
    return renderOf(col.cellRender({ row, column: {}, $index: 0 }));
  }

  /** 详情表行（PartTreeRow 最小可赋值形态）。 */
  function partRow(over: Partial<PartTreeRow> = {}): PartTreeRow {
    return {
      id: 'r1',
      is_part_row: true,
      seq: 1,
      serial_no: 'S-1',
      drawing_no: 'D-1',
      name: '电容',
      order_no: 'SO-1',
      applicant_name: '张三',
      customer_name: '影像组',
      customer_path: '终端BG / 手机部 / 影像组',
      parent_customer_name: '某某集团',
      note: '',
      quantity: 5,
      unit: '件',
      batch_ids: ['b1'],
      label_printed: false,
      request_date: null,
      planned_delivery_date: null,
      system_delivery_date: null,
      status: 'READY_TO_SHIP',
      part_id: 'p1',
      assembly_id: null,
      assembly_serial_no: null,
      assembly_drawing_no: null,
      assembly_name: null,
      assembly_order_no: null,
      assembly_quantity: null,
      shippable_sets: null,
      min_seq: null,
      ...over,
    };
  }

  /** 送货单本体行：`customer_name` = 单据归属的 L1 客户名（**不是**单段名）。 */
  function noteRow(over: Partial<DeliveryNoteItemData> = {}): DeliveryNoteItemData {
    return {
      id: '1',
      version: 1,
      delivery_note_no: 'DN-1',
      customer_id: 'C1',
      customer_name: '某某集团',
      customer_path: '终端BG / 手机部 / 影像组',
      status: 'DRAFT',
      submitted_at: null,
      picked_up_at: null,
      driver_worker_name: null,
      part_count: 0,
      note: null,
      delivery_date: null,
      ...over,
    };
  }

  it('C1：送货单一览主行 customer_path、次行 L1（L1 挂在 customer_name 上）', () => {
    const r = renderCol(buildDeliveryNoteColumnDefs(), 'customer', noteRow());
    expect(r.cls).toContain('customer-cell');
    expect(r.text).toBe('终端BG / 手机部 / 影像组某某集团');
  });

  it('C2：customer_path 为空串时 L1 顶上主行（不留「—」）', () => {
    const r = renderCol(buildDeliveryNoteColumnDefs(), 'customer', noteRow({ customer_path: '' }));
    expect(r.text).toBe('某某集团');
    expect(r.cls).not.toContain('customer-cell--empty');
  });

  it('C3：客户自身即 L1 时不重复渲染（两个字段返同一个名）', () => {
    const r = renderCol(
      buildDeliveryNoteColumnDefs(),
      'customer',
      noteRow({ customer_path: '某某集团', customer_name: '某某集团' }),
    );
    expect(r.text).toBe('某某集团');
    expect(r.cls).toBe('customer-cell__main');
  });

  it('C4：连 L1 都没有 → 灰色占位破折号', () => {
    const r = renderCol(
      buildDeliveryNoteColumnDefs(),
      'customer',
      noteRow({ customer_path: null, customer_name: null }),
    );
    expect(r.text).toBe('—');
    expect(r.cls).toContain('customer-cell--empty');
  });

  it('C5：详情行项主行 customer_path、次行 parent_customer_name（无限层级后 = 根名）', () => {
    const row = partRow({
      customer_name: '影像组',
      parent_customer_name: '某某集团',
      customer_path: '终端BG / 手机部 / 影像组',
    });
    const r = renderCol(buildDeliveryNoteLineItemsColumnDefs(), 'customer', row);
    expect(r.text).toBe('终端BG / 手机部 / 影像组某某集团');
  });

  it('C6：详情行项 customer_path 空串时退回单段名，L1 仍作次行', () => {
    const row = partRow({
      customer_name: '影像组',
      parent_customer_name: '某某集团',
      customer_path: '',
    });
    const r = renderCol(buildDeliveryNoteLineItemsColumnDefs(), 'customer', row);
    expect(r.text).toBe('影像组某某集团');
  });

  // 打印预览列刻意保持单行（预览必须与导出的 xlsx 单元格逐字一致，见列定义文件头）。
  it('C7：打印预览列仍是单行（不出 L1 次行，与导出到 xlsx 的单格文本一致）', () => {
    const row: PrintRow = {
      id: '1',
      order_no: 'SO-1',
      // PrintRow.l2_customer 已经是「第 2 层到叶子的路径」（deliveryNotePrintRows 补全）
      l2_customer: '终端BG / 手机部 / 影像组',
      applicant_name: '张三',
      drawing_no: 'D-1',
      name: 'N',
      quantity: 1,
      unit: '件',
      system_delivery_date: null,
      note: '',
    };
    const r = renderCol(buildDeliveryNotePrintColumnDefs(), 'customer_name', row);
    expect(r.text).toBe('终端BG / 手机部 / 影像组');
    expect(r.cls).not.toContain('customer-cell');
  });
});
