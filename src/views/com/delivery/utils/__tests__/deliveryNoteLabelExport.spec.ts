// @vitest-environment happy-dom
// src/views/com/delivery/utils/__tests__/deliveryNoteLabelExport.spec.ts
//
// 「打印标签」导出实现（草稿卡片与详情页共用那一份）的守卫，2026-10-09 新增。
//
// 守的是三件用户直接看见、且失败时不报错的语义：
//   1. **空选不导出**：warning 说清怎么补救，零请求零下载（按钮本身不做 disabled）；
//   2. **markPrinted 收到整行 batch_ids**：折叠行代表同零件的多个批次，只登记一个就
//      会让该行其余批次永远不绿（旧的 `toPrintRow` 就是这么漏的）；
//   3. **只标记真正出纸的行**：装配件父行在「后端没给可出货套数」时数量为空、渲染层整行
//      跳过，标成已打印就是绿底骗人。
//
// 产物本身（7 列 / 列序 / 单位）由 deliveryNoteLabelWorkbook.spec.ts 在字节层面守，
// 本文件只守「行从哪来 + 标记写到哪去 + 提示怎么说」这三段接线。

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readXlsx } from 'hucre';
import type { DeliveryNoteLineItemData } from '../../composables/deliveryNoteSchema';

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
}));

/** 下载桩：happy-dom 没有真实下载。 */
const downloads: { filename: string; blob: Blob }[] = [];
vi.mock('@/utils/download', () => ({
  triggerBrowserDownload: (blob: Blob, filename: string) => {
    downloads.push({ filename, blob });
  },
}));

const { ElMessage } = await import('element-plus');
const { usePrintedLabels } = await import('../../composables/usePrintedLabels');
const printedLabels = usePrintedLabels();
const { buildPartTreeRows } = await import('../deliveryNotePartRows');
const { exportPartRowsLabels } = await import('../deliveryNoteLabelExport');

const NOTE = { id: 'N1', delivery_note_no: 'DN-001' };

function li(p: Partial<DeliveryNoteLineItemData> & { id: string; part_id: string }) {
  return {
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
  } satisfies DeliveryNoteLineItemData;
}

/** localStorage 里 N1 单被登记为「已打印标签」的批次 id（升序）。 */
function markedBatchIds(): string[] {
  const raw = localStorage.getItem('delivery_scan_printed_labels_v1');
  expect(raw).toBeTruthy();
  const store = JSON.parse(raw!) as Record<string, Record<string, true>>;
  return Object.keys(store['N1'] ?? {}).sort();
}

/** 产物读回唯一那个 sheet。 */
async function sheetOf(index = 0) {
  const wb = await readXlsx(new Uint8Array(await downloads[index]!.blob.arrayBuffer()));
  return wb.sheets[0]!;
}

beforeEach(() => {
  downloads.length = 0;
  localStorage.clear();
  printedLabels.store.value = {};
  for (const fn of ['error', 'success', 'warning'] as const) {
    (ElMessage[fn] as unknown as { mock: { calls: unknown[] } }).mock.calls.length = 0;
  }
});

describe('exportPartRowsLabels 空选', () => {
  it('零勾选 → warning 说清怎么补救，零下载零标记', async () => {
    await exportPartRowsLabels(NOTE, []);
    expect(ElMessage.warning).toHaveBeenCalledWith('请先勾选要打印标签的零件/装配件');
    expect(downloads).toHaveLength(0);
    expect(localStorage.getItem('delivery_scan_printed_labels_v1')).toBeNull();
  });
});

describe('exportPartRowsLabels 导出与标记', () => {
  it('导出单 sheet、7 列、文件名 `<单号>-标签.xlsx`，单位「件」', async () => {
    const rows = buildPartTreeRows(
      [li({ id: '10', part_id: 'P1', quantity: 3, customer_name: '法拉' })],
      () => false,
    );
    await exportPartRowsLabels(NOTE, rows);

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe('DN-001-标签.xlsx');
    const sheet = await sheetOf();
    expect(sheet.rows[0]).toEqual([
      '客户',
      '订单号',
      '申请人',
      '名称',
      '图号',
      '数量',
      '单位',
    ]);
    expect(sheet.rows[1]).toEqual(['法拉', 'SO-1', '张三', '铝电解电容', 'D-1', 3, '件']);
    expect(ElMessage.success).toHaveBeenCalledWith('已导出标签');
  });

  it('markPrinted 收到**整行** batch_ids（同零件多批次折叠成一行也要全标）', async () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '10', part_id: 'P1', quantity: 3 }),
        li({ id: '11', part_id: 'P1', quantity: 4 }),
      ],
      () => false,
    );
    expect(rows).toHaveLength(1);
    await exportPartRowsLabels(NOTE, rows);
    expect(markedBatchIds()).toEqual(['10', '11']);
  });

  it('装配件父行导出「套」+ 可出货套数，并标记它代表的全部子件批次', async () => {
    const rows = buildPartTreeRows(
      [
        li({
          id: '13',
          part_id: 'PA',
          assembly_id: 'A1',
          assembly_name: '总装',
          assembly_drawing_no: 'ASM-D',
          assembly_order_no: 'ASM-SO',
          assembly_serial_no: 'ASM-S',
          shippable_sets: 3,
        }),
        li({
          id: '14',
          part_id: 'PB',
          assembly_id: 'A1',
          assembly_name: '总装',
          assembly_drawing_no: 'ASM-D',
          assembly_order_no: 'ASM-SO',
          assembly_serial_no: 'ASM-S',
          shippable_sets: 3,
        }),
      ],
      () => false,
    );
    expect(rows).toHaveLength(1);
    await exportPartRowsLabels(NOTE, rows);

    const sheet = await sheetOf();
    expect(sheet.rows[1]).toEqual(['法拉', 'ASM-SO', '张三', '总装', 'ASM-D', 3, '套']);
    expect(markedBatchIds()).toEqual(['13', '14']);
  });

  it('数量未知的行不写进 xlsx、也不进标记（没出纸就不算打印过），toast 如实说跳过 1 条', async () => {
    const rows = buildPartTreeRows(
      [
        li({ id: '31', part_id: 'P1', customer_name: '法拉' }),
        li({
          id: '32',
          part_id: 'P2',
          customer_name: '陆达电子',
          assembly_id: 'A1',
          assembly_name: '总装',
          shippable_sets: null,
        }),
      ],
      () => false,
    );
    await exportPartRowsLabels(NOTE, rows);

    const sheet = await sheetOf();
    expect(sheet.rows).toHaveLength(2);
    expect(ElMessage.success).toHaveBeenCalledWith('已导出标签（跳过 1 条数量为空的行）');
    expect(markedBatchIds()).toEqual(['31']);
  });
});