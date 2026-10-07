// @vitest-environment happy-dom
// src/views/com/delivery/utils/__tests__/deliveryNoteWorkbook.spec.ts
//
// 2026-10-08 新增：hucre 渲染链路的**实测**守卫。
//
// 本文件同时钉死两条实测结论（详见 utils/deliveryNoteWorkbook.ts 文件头）：
//   1. `fillTemplate` **支持合并单元格内的占位符** —— 模板的 F15 在合并区 `F15:J16`、
//      A17 在合并区 `A17:J17`，两个锚点都取到实参（见「页脚占位符在合并单元格内也被替换」
//      一条）。若将来换 hucre 版本导致这条退化为「不支持」，本用例会红，届时的修法是
//      规格里给的整串写入退化路径。
//   2. **round-trip 保留未建模的 part**：8 处 merges 在渲染前后原样保留；用 writeXlsx
//      重建会全部丢掉。
//
// 覆盖：数据行写入 / 未填满的行整行清空（不漏出 {{order_no}} 字面量）/ 多 sheet /
// 数量 null 写空 / 每 sheet 行数 / 占位符零残留。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDeliveryNoteWorkbook } from '../deliveryNoteWorkbook';
import { DELIVERY_NOTE_TEMPLATE_CONTRACT } from '../deliveryNoteTemplateContract';

// ⚠️ 必须从 Buffer 构造 Uint8Array（不能用 `buf.buffer`：node 的 Buffer 可能落在
// 8MB 池化 ArrayBuffer 的一段上，`.buffer` 拿到的是**整个池**，字节不是 xlsx）。
const TEMPLATE = new Uint8Array(readFileSync('templates/delivery_note_fala.xlsx'));

function row(i: number) {
  return {
    orderNo: `SO-${i}`,
    l2Customer: '法拉',
    applicant: '张三',
    drawingNo: `C-100${i}`,
    name: '铝电解电容',
    quantity: i + 1,
    unit: '件',
    etd: '2026-11-01',
    note: '',
  };
}

async function readBack(bytes: Uint8Array) {
  const { readXlsx } = await import('hucre');
  return readXlsx(bytes);
}

/** 数据行条数（A 列非空计数；模板的数据行 A 列是 {{no}}，渲染后是序号）。 */
function dataRowCount(sheet: { rows: unknown[][] }): number {
  const c = DELIVERY_NOTE_TEMPLATE_CONTRACT;
  return sheet.rows
    .slice(c.dataStartRow, c.dataStartRow + c.dataRowCount)
    .filter((r) => String(r[0] ?? '') !== '').length;
}

describe('renderDeliveryNoteWorkbook', () => {
  it('单组 3 条 ⇒ 1 个 sheet、3 条数据行、值逐格落位', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: '二五六厂', rows: [row(0), row(1), row(2)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const wb = await readBack(out);
    expect(wb.sheets).toHaveLength(1);
    const s = wb.sheets[0]!;
    expect(s.name).toBe('二五六厂');
    expect(dataRowCount(s)).toBe(3);
    expect(s.rows[2]![1]).toBe('SO-0');
    expect(s.rows[2]![4]).toBe('C-1000');
    expect(s.rows[2]![6]).toBe(1);
    expect(s.rows[4]![1]).toBe('SO-2');
    // 第 4..12 数据行必须整行清空（否则会漏出 {{order_no}} 字面量）
    expect(s.rows[5]!.every((v) => String(v ?? '') === '')).toBe(true);
  });

  it('页脚占位符在合并单元格内也被替换（fillTemplate 支持 merges —— 实测结论）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [row(0)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const s = (await readBack(out)).sheets[0]!;
    // F15 在合并区 F15:J16、A17 在合并区 A17:J17
    expect(s.rows[14]![5]).toBe('送货人：李四');
    expect(s.rows[16]![0]).toBe('                                         送货日期：  2026年10月08日');
  });

  it('round-trip 保留 8 处 merges（用 writeXlsx 重建会全丢）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    expect((await readBack(out)).sheets[0]!.merges).toHaveLength(8);
  });

  it('多组 ⇒ 多 sheet，容量按 10 条/sheet 切、组名带分块序号', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [
        { sheetName: '二五六厂', rows: [row(0), row(1), row(2)] },
        { sheetName: '陆达电子-1', rows: Array.from({ length: 10 }, (_, i) => row(i)) },
        { sheetName: '陆达电子-2', rows: [row(0), row(1)] },
      ],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const wb = await readBack(out);
    expect(wb.sheets.map((s) => s.name)).toEqual(['二五六厂', '陆达电子-1', '陆达电子-2']);
    expect(wb.sheets.map(dataRowCount)).toEqual([3, 10, 2]);
  });

  it('每 sheet 各自跑一遍页脚占位符（fillTemplate 遍历全部 sheet）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [
        { sheetName: 'A', rows: [row(0)] },
        { sheetName: 'B', rows: [row(0)] },
      ],
      { driverName: '张三', year: '2026', month: '10', date: '08' },
    );
    const wb = await readBack(out);
    for (const s of wb.sheets) expect(s.rows[14]![5]).toBe('送货人：张三');
  });

  it('quantity 为 null（装配件「后端没给可出货套数」）⇒ 模板写空而不是 0', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [{ ...row(0), quantity: null }] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const s = (await readBack(out)).sheets[0]!;
    expect(String(s.rows[2]![6] ?? '')).toBe('');
  });

  it('零残留占位符（模板里 11 个 placeholder 全被替换或清空）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [row(0)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const s = (await readBack(out)).sheets[0]!;
    const leftover = s.rows.flat().filter((v) => typeof v === 'string' && v.includes('{{'));
    expect(leftover).toEqual([]);
  });
});
