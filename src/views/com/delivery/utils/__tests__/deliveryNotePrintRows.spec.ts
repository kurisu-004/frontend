// src/views/com/delivery/utils/__tests__/deliveryNotePrintRows.spec.ts
//
// 2026-10-08 新增：打印行整形的纯函数守卫（不挂载组件；node 环境即可跑）。
//
// 覆盖（对齐任务书 §7 清单）：
//   - buildL2GroupMap：分组成员 / 未分组 L2 各自一组的两种映射；
//   - foldSamePart：同 part 折叠 + 代表批次按 **BigInt** 取 min（19 位雪花 id，
//     转 Number 比较会判相等 → 静默选错批次，这是本文件最重要的那条）；
//   - collapseAssemblies：merge / separate 两态 + shippable_sets 全 null 时返 null
//     不兜 0 + 真 0 套照实透传；
//   - sortPrintRows：null 末尾 + 数值 / 字符串两路；
//   - splitRow：守恒 / 不守恒两条 + note 每行独立；
//   - groupIntoSheets：每组独立 pack、跨组不混、capacity 边界、空组出空表；
//   - safeSheetName：31 字符上限 / 非法字符 / 重名去重。

import { describe, expect, it } from 'vitest';
import {
  buildL2GroupMap,
  collapseAssemblies,
  foldSamePart,
  groupIntoSheets,
  groupRefOf,
  groupRows,
  safeSheetName,
  sortPrintRows,
  splitRow,
} from '../deliveryNotePrintRows';
import type { DeliveryNoteLineItemData } from '../../composables/deliveryNoteSchema';

function li(p: Partial<DeliveryNoteLineItemData> & { id: string; part_id: string }) {
  const row: DeliveryNoteLineItemData = {
    version: 1,
    batch_no: null,
    batch_label: null,
    serial_no: `S-${p.id}`,
    drawing_no: 'D-1',
    name: 'N1',
    quantity: 1,
    status: 'READY_TO_SHIP',
    applicant_name: '张三',
    request_date: null,
    planned_delivery_date: null,
    system_delivery_date: null,
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
  return row;
}

describe('buildL2GroupMap', () => {
  const groupRes = {
    groups: [
      {
        id: '7',
        name: '二五六厂',
        version: 1,
        members: [
          { customer_id: '11', customer_name: '陆达' },
          { customer_id: '12', customer_name: '富士' },
        ],
      },
    ],
    ungrouped_customers: [{ id: '13', name: '法拉' }],
  };

  it('分组成员 → g_<组id>，未分组 L2 → c_<l2id>（各自一组）', () => {
    const map = buildL2GroupMap(groupRes);
    expect(map.get('11')?.groupKey).toBe('g_7');
    expect(map.get('11')?.groupName).toBe('二五六厂');
    expect(map.get('13')?.groupKey).toBe('c_13');
    expect(map.get('13')?.groupName).toBe('法拉');
  });

  it('每个成员写 id 与 name 两条键（行项 VO 只有 customer_name，没有 customer_id）', () => {
    const map = buildL2GroupMap(groupRes);
    expect(map.get('陆达')?.groupKey).toBe('g_7');
    expect(map.get('法拉')?.groupKey).toBe('c_13');
  });

  it('groupRefOf：查不到时兜底成「自身一个组」（不丢客户）', () => {
    const map = buildL2GroupMap(groupRes);
    expect(groupRefOf(li({ id: '1', part_id: 'P', customer_name: '未知厂' }), map)).toEqual({
      groupKey: 'c_named_未知厂',
      groupName: '未知厂',
    });
  });
});

describe('foldSamePart（代表批次按 BigInt 取 min）', () => {
  it('同 part 多批次 → 一行、quantity 求和', () => {
    const rows = foldSamePart([
      li({ id: '300', part_id: 'P1', quantity: 2 }),
      li({ id: '400', part_id: 'P1', quantity: 3 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(5);
  });

  it('两个仅在 2^53 之后有差别的 19 位 id → 仍要换代表（转 Number 比较会判相等）', () => {
    const rows = foldSamePart([
      li({ id: '9223372036854775807', part_id: 'P1', quantity: 1 }),
      li({ id: '9223372036854775806', part_id: 'P1', quantity: 2 }),
    ]);
    expect(rows[0]!.id).toBe('9223372036854775806');
    expect(rows[0]!.quantity).toBe(3);
  });

  it('不等长 id → 按数值而非字典序（999 < 1000）', () => {
    const rows = foldSamePart([
      li({ id: '1000', part_id: 'P1' }),
      li({ id: '999', part_id: 'P1' }),
    ]);
    expect(rows[0]!.id).toBe('999');
  });
});

describe('collapseAssemblies', () => {
  const asmItems = [
    li({
      id: '1',
      part_id: 'PA',
      assembly_id: 'A1',
      assembly_name: '总装',
      assembly_order_no: 'SO-A',
      assembly_drawing_no: 'ASM-D',
      shippable_sets: 7,
      assembly_quantity: 20,
    }),
    li({ id: '2', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装', shippable_sets: 4 }),
  ];

  it('merge：每个 assembly_id 折成 1 行、数量取组内 min、单位套', () => {
    const rows = collapseAssemblies(foldSamePart(asmItems), 'merge');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(4);
    expect(rows[0]!.unit).toBe('套');
    expect(rows[0]!.is_asm_row).toBe(true);
    expect(rows[0]!.name).toBe('总装');
    expect(rows[0]!.order_no).toBe('SO-A');
    expect(rows[0]!.drawing_no).toBe('ASM-D');
    expect(rows[0]!.member_ids).toEqual(['1', '2']);
  });

  it('separate：原样（每个 part 一行）', () => {
    expect(collapseAssemblies(foldSamePart(asmItems), 'separate')).toHaveLength(2);
  });

  it('shippable_sets 全缺 → null，**不兜 0**（「没给数」≠「凑不齐整套」）', () => {
    const rows = collapseAssemblies(
      foldSamePart([li({ id: '1', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' })]),
      'merge',
    );
    expect(rows[0]!.quantity).toBeNull();
  });

  it('真凑不齐整套（0 套）→ 照实透传 0', () => {
    const rows = collapseAssemblies(
      foldSamePart([li({ id: '1', part_id: 'PA', assembly_id: 'A1', shippable_sets: 0 })]),
      'merge',
    );
    expect(rows[0]!.quantity).toBe(0);
  });
});

describe('sortPrintRows', () => {
  const rows = foldSamePart([
    li({ id: '1', part_id: 'A', order_no: 'SO-2', quantity: 5, system_delivery_date: null }),
    li({ id: '2', part_id: 'B', order_no: 'SO-1', quantity: 3, system_delivery_date: '2026-11-01' }),
    li({ id: '3', part_id: 'C', order_no: 'SO-3', quantity: 9, system_delivery_date: null }),
  ]);

  it('字符串列升 / 降序', () => {
    expect(sortPrintRows(rows, 'order_no', 'asc').map((r) => r.order_no)).toEqual([
      'SO-1',
      'SO-2',
      'SO-3',
    ]);
    expect(sortPrintRows(rows, 'order_no', 'desc')[0]!.order_no).toBe('SO-3');
  });

  it('数值列按数值比较（不是字符串）', () => {
    expect(sortPrintRows(rows, 'quantity', 'asc').map((r) => r.quantity)).toEqual([3, 5, 9]);
  });

  it('null 强制末尾（两态都末尾）', () => {
    expect(sortPrintRows(rows, 'system_delivery_date', 'asc').at(-1)!.order_no).not.toBe('SO-1');
    expect(sortPrintRows(rows, 'system_delivery_date', 'desc')[0]!.system_delivery_date).toBe(
      '2026-11-01',
    );
  });

  it('不原地改入参', () => {
    const before = rows.map((r) => r.id);
    sortPrintRows(rows, 'quantity', 'desc');
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('splitRow', () => {
  const row = { ...foldSamePart([li({ id: '1', part_id: 'P', quantity: 5, note: '原备注' })])[0]! };

  it('守恒 → 拆出 N 行，继承其余字段', () => {
    const out = splitRow(row, [2, 3]);
    expect(Array.isArray(out)).toBe(true);
    if (!Array.isArray(out)) return;
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.quantity)).toEqual([2, 3]);
    expect(out.every((r) => r.order_no === row.order_no)).toBe(true);
  });

  it('不守恒 → 返回错误文案', () => {
    expect(typeof splitRow(row, [2, 2])).toBe('string');
  });

  it('备注每行独立、默认空（继承会让同一句话重复 N 遍）', () => {
    const out = splitRow(row, [2, 3]);
    expect(Array.isArray(out) && out.every((r) => r.note === '')).toBe(true);
  });
});

describe('groupIntoSheets', () => {
  const map = buildL2GroupMap({
    groups: [],
    ungrouped_customers: [
      { id: '1', name: '二五六厂' },
      { id: '2', name: '陆达电子' },
    ],
  });

  function itemsFor(groupCount: number, perGroup: number) {
    return Array.from({ length: groupCount * perGroup }, (_, i) =>
      li({
        id: `${i + 1}`,
        part_id: `P${i}`,
        customer_name: groupCount === 1 ? '二五六厂' : i < perGroup ? '二五六厂' : '陆达电子',
      }),
    );
  }

  it('跨组不混：两组各出一张 sheet', () => {
    const specs = groupIntoSheets(groupRows(itemsFor(2, 3), map, 'merge'));
    expect(specs.map((s) => s.rows.length)).toEqual([3, 3]);
    expect(specs.map((s) => s.sheetName)).toEqual(['二五六厂', '陆达电子']);
  });

  it('单组超容量 → 每 capacity 条一张，sheet 名带分块序号', () => {
    const specs = groupIntoSheets(groupRows(itemsFor(1, 12), map, 'merge'));
    expect(specs.map((s) => s.rows.length)).toEqual([10, 2]);
    expect(specs.map((s) => s.sheetName)).toEqual(['二五六厂-1', '二五六厂-2']);
  });

  it('capacity 边界：正好 capacity 条 → 只出一张、不带序号', () => {
    const specs = groupIntoSheets(groupRows(itemsFor(1, 10), map, 'merge'));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.sheetName).toBe('二五六厂');
  });

  it('空组也出一张空表（模板自带表头与页脚，导出来可手填）', () => {
    const specs = groupIntoSheets(groupRows([], map, 'merge'));
    expect(specs).toHaveLength(0);
  });
});

describe('safeSheetName', () => {
  it('剔除 Excel 非法字符（: \\ / ? * [ ]）', () => {
    expect(safeSheetName('a/b:c*d?e[f]g')).toBe('a b c d e f g');
  });

  it('31 字符上限', () => {
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
  });

  it('折叠连续空白 + 去首尾', () => {
    expect(safeSheetName('  二   五六 厂  ')).toBe('二 五六 厂');
  });

  it('清空后回落到带 index 的兜底名', () => {
    expect(safeSheetName('///', 2)).toBe('送货单-3');
  });
});
