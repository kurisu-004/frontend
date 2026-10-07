// @vitest-environment happy-dom
// src/views/com/delivery/utils/__tests__/deliveryNoteLabelWorkbook.spec.ts
//
// 「打印标签」工作簿渲染的守卫（2026-10-08 新增）。
//
// 用 readXlsx 把产物读回来验，而不是只断言「writeXlsx 没抛」—— 标签是拿去打印、贴到
// 零件上的实物，列序错一位、unit 丢成空串都是现场事故，单测必须在**字节层面**兜住。
//
// 覆盖：7 列表头与列序 / 单 sheet / autoWidth 生效 / quantity=null 整行跳过 + skipped 计数 +
// written 只含写出去的行 / unit 透传（散件空串 + 装配件「套」）/ 装配件行只出 1 行 /
// 行序按传入顺序。

import { describe, expect, it } from 'vitest';
import { readXlsx } from 'hucre';
import type { Sheet } from 'hucre/xlsx';
import {
  DELIVERY_NOTE_LABEL_COLUMNS,
  DELIVERY_NOTE_LABEL_XLSX_MIME,
  renderDeliveryNoteLabelWorkbook,
} from '../deliveryNoteLabelWorkbook';
import type { PrintRow } from '../deliveryNotePrintRows';

function row(over: Partial<PrintRow> = {}): PrintRow {
  return {
    id: '1',
    order_no: 'SO-1',
    l2_customer: '法拉',
    applicant_name: '张三',
    drawing_no: 'D-1',
    name: '铝电解电容',
    quantity: 5,
    unit: '',
    system_delivery_date: '2026-11-01',
    note: '',
    member_ids: ['1'],
    ...over,
  };
}

/** 渲染并读回唯一那个 sheet，同时带回 skipped / written（调用方据此写「已打印」标记）。 */
async function render(
  rows: readonly PrintRow[],
): Promise<{ sheet: Sheet; skipped: number; written: PrintRow[] }> {
  const { bytes, skipped, written } = await renderDeliveryNoteLabelWorkbook(rows);
  const wb = await readXlsx(bytes);
  return { sheet: wb.sheets[0]!, skipped, written };
}

describe('标签列定义', () => {
  it('7 列且顺序固定（客户 / 订单号 / 申请人 / 名称 / 图号 / 数量 / 单位）', () => {
    expect(DELIVERY_NOTE_LABEL_COLUMNS.map((c) => c.label)).toEqual([
      '客户',
      '订单号',
      '申请人',
      '名称',
      '图号',
      '数量',
      '单位',
    ]);
  });

  it('MIME 与送货单一致（同一个 xlsx zip）', () => {
    expect(DELIVERY_NOTE_LABEL_XLSX_MIME).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});

describe('renderDeliveryNoteLabelWorkbook', () => {
  it('单 sheet，表头 7 列 + 一行数据，列序与定义一致', async () => {
    const { bytes } = await renderDeliveryNoteLabelWorkbook([row()]);
    const wb = await readXlsx(bytes);
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0]!.name).toBe('标签');
    expect(wb.sheets[0]!.rows[0]).toEqual([
      '客户',
      '订单号',
      '申请人',
      '名称',
      '图号',
      '数量',
      '单位',
    ]);
    expect(wb.sheets[0]!.rows[1]).toEqual(['法拉', 'SO-1', '张三', '铝电解电容', 'D-1', 5, '']);
  });

  it('autoWidth 生效（读回的 columns 带算出来的列宽，没有它就没有 widths）', async () => {
    const { sheet } = await render([
      row({ l2_customer: '中国台湾某某某某某某某某某某某某有限公司' }),
    ]);
    expect(sheet.columns).toHaveLength(7);
    expect(sheet.columns!.every((c) => typeof c.width === 'number' && c.width > 0)).toBe(true);
    // 第 0 列是那个超长客户名 ⇒ 宽度应明显大于第 5 列（数量，值只有 5）
    expect(sheet.columns![0]!.width!).toBeGreaterThan(sheet.columns![5]!.width!);
  });

  it('行序 = 传入顺序（勾选顺序由调用方决定，渲染层不重排）', async () => {
    const { sheet } = await render([
      row({ id: 'a', order_no: 'SO-A' }),
      row({ id: 'b', order_no: 'SO-B' }),
      row({ id: 'c', order_no: 'SO-C' }),
    ]);
    expect(sheet.rows.slice(1).map((r) => r[1])).toEqual(['SO-A', 'SO-B', 'SO-C']);
  });

  it('quantity === null 的行整行跳过，且 skipped 计数正确', async () => {
    const { sheet, skipped } = await render([
      row({ id: 'a', order_no: 'SO-A' }),
      row({ id: 'b', order_no: 'SO-B', quantity: null }),
      row({ id: 'c', order_no: 'SO-C' }),
    ]);
    expect(skipped).toBe(1);
    expect(sheet.rows).toHaveLength(3); // 表头 + 2 行
    expect(sheet.rows.slice(1).map((r) => r[1])).toEqual(['SO-A', 'SO-C']);
  });

  it('written 只含真正写出去的行（跳过的不在其中：标记「已打印」靠它，没出纸就不算打印）', async () => {
    const { sheet, skipped, written } = await render([
      row({ id: 'a', order_no: 'SO-A' }),
      row({ id: 'b', order_no: 'SO-B', quantity: null }),
      row({ id: 'c', order_no: 'SO-C' }),
    ]);
    expect(written.map((r) => r.id)).toEqual(['a', 'c']);
    // written 与 xlsx 里的数据行一一对应（防「改了 skip 判据忘了同步 written」的半修）
    expect(written).toHaveLength(sheet.rows.length - 1);
    expect(skipped).toBe(1);
  });

  it('全部行数量未知 → 只剩表头，skipped 等于行数，written 为空', async () => {
    const { sheet, skipped, written } = await render([
      row({ id: 'a', quantity: null }),
      row({ id: 'b', quantity: null }),
    ]);
    expect(skipped).toBe(2);
    expect(sheet.rows).toHaveLength(1);
    expect(written).toEqual([]);
  });

  it('空行数组 → 只有表头（导出按钮的 disabled 由调用方守，这里不抛）', async () => {
    const { sheet, skipped } = await render([]);
    expect(skipped).toBe(0);
    expect(sheet.rows).toHaveLength(1);
  });

  it('unit 透传：散件行空串、装配件行「套」', async () => {
    const { sheet } = await render([
      row({ id: 'a', unit: '' }),
      row({ id: 'b', is_asm_row: true, unit: '套', quantity: 3 }),
    ]);
    expect(sheet.rows[1]![6]).toBe('');
    expect(sheet.rows[2]![6]).toBe('套');
  });

  it('装配件父行只出 1 行（父行是 1 条打印投影，渲染层不再折叠）', async () => {
    const { sheet } = await render([
      row({
        id: 'ASM_A1',
        is_asm_row: true,
        quantity: 3,
        unit: '套',
        name: '总装',
        drawing_no: 'ASM-D',
        member_ids: ['11', '12', '13'],
      }),
    ]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1]).toEqual(['法拉', 'SO-1', '张三', '总装', 'ASM-D', 3, '套']);
  });

  it('送货单独有的列不进标签（交期 / 备注 / 系统交期一律不出现）', async () => {
    const { sheet } = await render([row({ note: '加急', system_delivery_date: '2026-11-01' })]);
    const flat = JSON.stringify(sheet.rows);
    expect(flat).not.toContain('加急');
    expect(flat).not.toContain('2026-11-01');
  });
});