// src/views/com/delivery/utils/__tests__/deliveryNotePartRows.spec.ts
//
// 2026-10-09 新增：零件 / 装配件行形的纯函数守卫（不挂载组件；node 环境即可跑）。
//
// 覆盖：
//   - 同 part 多批次折叠：数量求和 + row-key 按 (assembly_id, part_id) 而非批次；
//   - 代表行字段取舍：代表批次取**首个**（顺序即输入序，详情页的客户端排序不能被折叠还原）、
//     系统交期取组内首个非空；
//   - 装配件父子结构：父行插在首个子件位置、套数 = 组内 min shippable_sets、全 null 时
//     null 不兜 0（真 0 套照实透传）；
//   - row-key 全表唯一，且零件行 key 不与批次 id 相撞（reserve-selection 的前提）；
//   - `label_printed` 的**零件行 any / 装配件父行 all** 口径（两张表共用同一判据）；
//   - 2026-10-10 新增：「序号」列 —— `min_seq` 取组内最小（不是代表批次那个）、按值稠密排名、
//     排序不漂移、全 null 时回落数组下标、同值共享名次；
//   - `partRowsToLabelRows`：单位（件 / 套）、数量口径、`member_ids` 是**整行** batch_ids
//     （只登记代表批次会让该行其余批次永远不绿）、不写 `PrintRow.is_asm_row`（标签渲染层
//     7 列全程不读它）。

import { describe, expect, it } from 'vitest';
import { buildPartTreeRows, partRowsToLabelRows } from '../deliveryNotePartRows';
import type { DeliveryNoteLineItemData } from '../../composables/deliveryNoteSchema';

function li(p: Partial<DeliveryNoteLineItemData> & { id: string; part_id: string }) {
  const row: DeliveryNoteLineItemData = {
    batch_no: null,
    batch_label: null,
    serial_no: `S-${p.id}`,
    drawing_no: 'D-1',
    name: '铝电解电容',
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

const never = () => false;

describe('buildPartTreeRows：同 part 多批次折叠', () => {
  it('数量求和，批次 id 全量收进 batch_ids', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', quantity: 3 }),
        li({ id: '11', part_id: 'P1', quantity: 4 }),
      ],
      never,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(7);
    expect(rows[0]!.batch_ids).toEqual(['10', '11']);
  });

  it('折叠键含装配件维度：同一零件作散件 + 作装配件子件 ⇒ 两条独立行', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1' }),
        li({ id: '11', part_id: 'P1', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      never,
    );
    // 顶层两行：散件在前（它在输入里排第一），装配件父行随后
    expect(rows.map((r) => (r.is_asm_row ? 'asm' : 'part'))).toEqual(['part', 'asm']);
    const [loose, asm] = rows;
    // 同一个 P1 折成了两条独立行，key 带装配件维度区分
    expect(loose!.id).toBe('P:-:P1');
    expect(asm!.id).toBe('ASM_A1');
    expect(asm!.children!.map((c) => c.id)).toEqual(['P:A1:P1']);
  });

  it('row-key 稳定且按零件而非批次（同一 part 多批次只占一行一个 key）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1' }),
        li({ id: '11', part_id: 'P1' }),
      ],
      never,
    );
    expect(rows[0]!.id).toBe('P:-:P1');
    expect(rows[0]!.id).not.toBe('10');
    expect(rows[0]!.id).not.toBe('11');
  });

  it('全表 row-key 唯一（reserve-selection 的前提）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1' }),
        li({ id: '11', part_id: 'P1' }),
        li({ id: '12', part_id: 'P2' }),
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      never,
    );
    const flat = [rows.flatMap((r) => [r, ...(r.children ?? [])])].flat();
    const ids = flat.map((r) => r.id);
    expect(ids).toHaveLength(new Set(ids).size);
    // 装配件父行与散件行的 key 前缀不同，不可能相撞
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });
});

describe('buildPartTreeRows：代表行字段取舍', () => {
  it('代表批次取首个（顺序即行序），不按 id 排序', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '99', part_id: 'P1', name: '首个', drawing_no: 'D-A', order_no: 'SO-A' }),
        li({ id: '11', part_id: 'P1', name: '第二个', drawing_no: 'D-B', order_no: 'SO-B' }),
      ],
      never,
    );
    expect(rows[0]!.name).toBe('首个');
    expect(rows[0]!.drawing_no).toBe('D-A');
    expect(rows[0]!.order_no).toBe('SO-A');
  });

  it('输入顺序整体保留（详情页的客户端排序不被折叠还原）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '1', part_id: 'PC' }),
        li({ id: '2', part_id: 'PA' }),
        li({ id: '3', part_id: 'PB' }),
      ],
      never,
    );
    expect(rows.map((r) => r.part_id)).toEqual(['PC', 'PA', 'PB']);
  });

  it('系统交期取组内首个非空', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '1', part_id: 'P1', system_delivery_date: null }),
        li({ id: '2', part_id: 'P1', system_delivery_date: '2026-11-01' }),
      ],
      never,
    );
    expect(rows[0]!.system_delivery_date).toBe('2026-11-01');
  });

  it('可空展示字段归一成空串（PrintRow 的这几个字段是 string 而非 nullable）', () => {
    const rows = buildPartTreeRows(
      [
        li({
          id: '1',
          part_id: 'P1',
          applicant_name: null,
          order_no: null,
          customer_name: null,
          customer_path: null,
          note: null,
        }),
      ],
      never,
    );
    expect(rows[0]!.applicant_name).toBe('');
    expect(rows[0]!.order_no).toBe('');
    expect(rows[0]!.customer_name).toBe('');
    expect(rows[0]!.note).toBe('');
  });
});

describe('buildPartTreeRows：装配件父子结构', () => {
  const asmItems = [
    li({
      id: '13',
      part_id: 'PA',
      assembly_id: 'A1',
      assembly_serial_no: 'ASM-S',
      assembly_drawing_no: 'ASM-D',
      assembly_name: '总装',
      assembly_order_no: 'ASM-SO',
      assembly_quantity: 10,
      shippable_sets: 7,
    }),
    li({
      id: '14',
      part_id: 'PB',
      assembly_id: 'A1',
      assembly_serial_no: 'ASM-S',
      assembly_drawing_no: 'ASM-D',
      assembly_name: '总装',
      assembly_order_no: 'ASM-SO',
      assembly_quantity: 10,
      shippable_sets: 4,
    }),
  ];

  it('父行取组内有值的 shippable_sets 最小值，单位「套」', () => {
    const rows = buildPartTreeRows(asmItems, never);
    expect(rows).toHaveLength(1);
    const parent = rows[0]!;
    expect(parent.is_asm_row).toBe(true);
    expect(parent.has_children).toBe(true);
    expect(parent.quantity).toBe(4);
    expect(parent.unit).toBe('套');
  });

  it('父行展示值取 assembly_*（不回落子件），批次 id 由子件汇总', () => {
    const rows = buildPartTreeRows(asmItems, () => true);
    const parent = rows[0]!;
    expect(parent.name).toBe('总装');
    expect(parent.drawing_no).toBe('ASM-D');
    expect(parent.serial_no).toBe('ASM-S');
    expect(parent.order_no).toBe('ASM-SO');
    expect(parent.batch_ids).toEqual(['13', '14']);
    expect(parent.label_printed).toBe(true);
    expect(parent.children!.map((c) => c.batch_ids[0])).toEqual(['13', '14']);
  });

  it('assembly_* 缺失时回落首个子件（后端未填装配件投影的老数据不会渲染空白）', () => {
    const rows = buildPartTreeRows(
      [
        li({
          id: '13',
          part_id: 'PA',
          name: '电容',
          drawing_no: 'D-PA',
          order_no: 'SO-1',
          assembly_id: 'A1',
          assembly_name: null,
          assembly_drawing_no: null,
          assembly_order_no: null,
          assembly_serial_no: null,
        }),
      ],
      never,
    );
    expect(rows[0]!.name).toBe('电容');
    expect(rows[0]!.drawing_no).toBe('D-PA');
    expect(rows[0]!.order_no).toBe('SO-1');
  });

  it('shippable_sets 全缺 → null 不兜 0（后端没给数 ≠ 凑不齐整套）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      never,
    );
    expect(rows[0]!.quantity).toBeNull();
  });

  it('子件真凑不齐整套（0 套）→ 照实透传 0', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', shippable_sets: 0 }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', shippable_sets: 0 }),
      ],
      never,
    );
    expect(rows[0]!.quantity).toBe(0);
  });

  it('父行插在首个子件位置，散件行保持自己的相对位置', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '1', part_id: 'P-loose-before' }),
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '2', part_id: 'P-loose-after' }),
      ],
      never,
    );
    expect(rows.map((r) => r.id)).toEqual([
      'P:-:P-loose-before',
      'ASM_A1',
      'P:-:P-loose-after',
    ]);
  });

  it('子件行仍是「件」，与父行「套」区分', () => {
    const rows = buildPartTreeRows(asmItems, never);
    expect(rows[0]!.children!.map((c) => c.unit)).toEqual(['件', '件']);
  });
});

describe('buildPartTreeRows：「序号」列（加入送货单的先后顺序）', () => {
  it('折叠行取组内最小 delivery_seq，不取「代表批次（首个）」那个', () => {
    // 代表批次（输入里排第一）的 delivery_seq 是 5，而同零件的另一批是 2 —— 若沿用
    // 「取首个」口径，这行的序号会按 5 排，按状态排序一次还会再变。
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', delivery_seq: 5 }),
        li({ id: '11', part_id: 'P1', delivery_seq: 2 }),
      ],
      never,
    );
    expect(rows[0]!.min_seq).toBe(2);
    // 唯一的行 ⇒ 无论 min 是 2 还是 5，名次都是 1；再排一行把差别显出来
    const withTwo = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', delivery_seq: 5 }),
        li({ id: '11', part_id: 'P1', delivery_seq: 2 }),
        li({ id: '12', part_id: 'P2', delivery_seq: 3 }),
      ],
      never,
    );
    expect(withTwo.map((r) => [r.id, r.seq])).toEqual([
      ['P:-:P1', 1],
      ['P:-:P2', 2],
    ]);
  });

  it('已有值为 null 而新批次有值时取新值（部分批次已回填的混合态）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', delivery_seq: null }),
        li({ id: '11', part_id: 'P1', delivery_seq: 7 }),
      ],
      never,
    );
    expect(rows[0]!.min_seq).toBe(7);
    expect(rows[0]!.seq).toBe(1);
  });

  it('装配件父行取子件里最小的那个（子件各自已 min 过）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', delivery_seq: 9 }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', delivery_seq: 4 }),
        // 散件入单更早 ⇒ 父行的名次在它之后
        li({ id: '99', part_id: 'PLOOSE', delivery_seq: 1 }),
      ],
      never,
    );
    const parent = rows.find((r) => r.is_asm_row)!;
    expect(parent.min_seq).toBe(4);
    expect(parent.seq).toBe(2);
    expect(rows.find((r) => r.part_id === 'PLOOSE')!.seq).toBe(1);
  });

  it('按其它列排序后 seq 不漂移（min 是顺序无关的聚合）', () => {
    const items = [
      li({ id: '10', part_id: 'P1', delivery_seq: 3, status: 'BLOCKED' }),
      li({ id: '11', part_id: 'P2', delivery_seq: 1, status: 'READY_TO_SHIP' }),
      li({ id: '12', part_id: 'P3', delivery_seq: 2, status: 'READY_TO_SHIP' }),
    ];
    // 详情页的客户端排序：先按 status 排一次，再按 delivery_seq 倒排一次
    const byStatus = [...items].sort((a, b) => a.status.localeCompare(b.status));
    const bySeqDesc = [...items].sort((a, b) => b.delivery_seq! - a.delivery_seq!);

    const seqById = (rows: ReturnType<typeof buildPartTreeRows>) =>
      Object.fromEntries(rows.map((r) => [r.part_id, r.seq]));
    const stable = seqById(buildPartTreeRows(items, never));
    expect(stable).toEqual({ P1: 3, P2: 1, P3: 2 });
    expect(seqById(buildPartTreeRows(byStatus, never))).toEqual(stable);
    expect(seqById(buildPartTreeRows(bySeqDesc, never))).toEqual(stable);
  });

  it('全部 delivery_seq 为 null（后端未上线 / 历史数据）→ 回落数组下标', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '1', part_id: 'PB' }),
        li({ id: '2', part_id: 'PA', delivery_seq: null }),
        li({ id: '3', part_id: 'PC' }),
      ],
      never,
    );
    expect(rows.map((r) => [r.part_id, r.seq])).toEqual([
      ['PB', 1],
      ['PA', 2],
      ['PC', 3],
    ]);
    expect(rows.every((r) => r.min_seq === null)).toBe(true);
  });

  it('min_seq 相同的不同行共享同一序号（装配件父行与散件同批入单）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', delivery_seq: 2 }),
        li({ id: '99', part_id: 'PLOOSE', delivery_seq: 2 }),
        li({ id: '98', part_id: 'PZ', delivery_seq: 6 }),
      ],
      never,
    );
    expect(rows.map((r) => [r.id, r.seq])).toEqual([
      ['ASM_A1', 1],
      ['P:-:PLOOSE', 1],
      ['P:-:PZ', 2],
    ]);
  });

  it('摘掉中间一行后序号连续（稠密名次，不留 1,2,4,5 的空洞）', () => {
    // 摘单后后端仍是 1,2,4,5 四个 delivery_seq ⇒ 稠密排名给出 1,2,3
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', delivery_seq: 1 }),
        li({ id: '12', part_id: 'P3', delivery_seq: 4 }),
        li({ id: '13', part_id: 'P4', delivery_seq: 5 }),
      ],
      never,
    );
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('装配件子件行不参与排名（嵌在父行下，序号由父行代表）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', delivery_seq: 2 }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', delivery_seq: 3 }),
      ],
      never,
    );
    expect(rows[0]!.seq).toBe(1);
    // 子件行只带 min_seq（排名依据）；seq 是折叠阶段的占位值 0，由表格侧留空渲染
    // （见 DeliveryNoteLineItemsTable.vue::seqCell）
    expect(rows[0]!.children!.map((c) => [c.min_seq, c.seq])).toEqual([
      [2, 0],
      [3, 0],
    ]);
  });
});

describe('buildPartTreeRows：绿底口径（零件行 any / 装配件父行 all）', () => {
  it('零件行：任一批次打过标签即整行绿（any，不是 all）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1' }),
        li({ id: '11', part_id: 'P1' }),
      ],
      (id) => id === '11',
    );
    expect(rows[0]!.label_printed).toBe(true);
  });

  it('都没打过 → false', () => {
    const rows = buildPartTreeRows([li({ id: '10', part_id: 'P1' })], never);
    expect(rows[0]!.label_printed).toBe(false);
  });

  it('装配件父行：只打过一个子件时不绿（否则读成「整套都出过纸」）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      (id) => id === '13',
    );
    const parent = rows[0]!;
    expect(parent.is_asm_row).toBe(true);
    expect(parent.label_printed).toBe(false);
    // 打过那个子件行照常绿
    expect(parent.children!.map((c) => c.label_printed)).toEqual([true, false]);
  });

  it('装配件父行：全部子件批次都打过才绿（打印父行会把整套标记上）', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '13', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '14', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      (id) => id === '13' || id === '14',
    );
    expect(rows[0]!.label_printed).toBe(true);
  });

  it('子件行折叠多批次时，父行取的是「每个子件行」的 all（不是逐批次展开的 all）', () => {
    // PA 折成一行、含两个批次，其中只有一个打过 ⇒ PA 行绿；PB 一个批次也绿 ⇒ 父行绿
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '11', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '12', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      (id) => id === '11' || id === '12',
    );
    expect(rows[0]!.label_printed).toBe(true);
    // 全部三个批次都绿
    const all = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '11', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' }),
        li({ id: '12', part_id: 'PB', assembly_id: 'A1', assembly_name: '总装' }),
      ],
      () => true,
    );
    expect(all[0]!.label_printed).toBe(true);
  });

  it('空数组 → 空结果（看板未加载时不该造出空父行）', () => {
    expect(buildPartTreeRows([], never)).toEqual([]);
  });
});

describe('partRowsToLabelRows', () => {
  it('零件行：单位「件」、数量 = 折叠求和、member_ids 是整行批次 id', () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', quantity: 3, order_no: 'SO-1' }),
        li({ id: '11', part_id: 'P1', quantity: 4, order_no: 'SO-1' }),
      ],
      never,
    );
    const label = partRowsToLabelRows(rows);
    expect(label).toHaveLength(1);
    expect(label[0]!).toMatchObject({
      id: 'P:-:P1',
      unit: '件',
      quantity: 7,
      order_no: 'SO-1',
      l2_customer: '法拉',
      applicant_name: '张三',
      drawing_no: 'D-1',
      name: '铝电解电容',
      note: '',
    });
    // 标签行不带装配件标记：标签工作簿是 7 列，渲染层全程不读 `is_asm_row`
    // （那个字段只服务「打印送货单」的预览表，由 deliveryNotePrintRows 自己写）
    expect(label[0]!.is_asm_row).toBeUndefined();
    // 全量批次 id：只登记代表批次会让同零件的其余批次永远不绿
    expect(label[0]!.member_ids).toEqual(['10', '11']);
  });

  it('装配件父行：单位「套」、数量 = 可出货套数、同样不带 is_asm_row', () => {
    const rows = buildPartTreeRows(
      [
        li({
          id: '13',
          part_id: 'PA',
          assembly_id: 'A1',
          assembly_name: '总装',
          assembly_drawing_no: 'ASM-D',
          assembly_order_no: 'ASM-SO',
          assembly_quantity: 10,
          shippable_sets: 7,
        }),
        li({
          id: '14',
          part_id: 'PB',
          assembly_id: 'A1',
          assembly_name: '总装',
          assembly_drawing_no: 'ASM-D',
          assembly_order_no: 'ASM-SO',
          assembly_quantity: 10,
          shippable_sets: 4,
        }),
      ],
      never,
    );
    const label = partRowsToLabelRows(rows);
    expect(label[0]).toMatchObject({
      id: 'ASM_A1',
      unit: '套',
      quantity: 4,
      order_no: 'ASM-SO',
      drawing_no: 'ASM-D',
      name: '总装',
      assembly_quantity: 10,
    });
    expect(label[0]!.is_asm_row).toBeUndefined();
    expect(label[0]!.member_ids).toEqual(['13', '14']);
  });

  it('数量为 null 的行照样进映射（过滤与 skipped 计数由渲染层负责）', () => {
    const rows = buildPartTreeRows(
      [li({ id: '13', part_id: 'PA', assembly_id: 'A1', assembly_name: '总装' })],
      never,
    );
    const label = partRowsToLabelRows(rows);
    expect(label).toHaveLength(1);
    expect(label[0]!.quantity).toBeNull();
  });

  it('行序即输入序（勾选顺序 = 出纸顺序）', () => {
    const rows = buildPartTreeRows(
      [li({ id: '1', part_id: 'PB' }), li({ id: '2', part_id: 'PA' })],
      never,
    );
    expect(partRowsToLabelRows(rows).map((r) => r.id)).toEqual(['P:-:PB', 'P:-:PA']);
  });
});