// src/views/com/delivery/utils/deliveryNoteTemplate.ts
//
// 送货单打印模板的取字节 + 结构校验（2026-10-08 新增）。
//
// 模板来源两种形态（`TemplateSource`）：
//   · `local` —— 用户在打印对话框里上传的文件（el-upload 给的 raw File → bytes）；
//   · `url`   —— **预留**：后端把模板绑到 COS 后由前端按 URL 取。当前没有调用方，
//                留着是为了让「换数据源」这件事将来不动任何渲染代码。
//
// ⚠️ 校验失败**不静默**：assertTemplateMatches 返回逐条差异，由对话框把「导出」按钮
// 置 disabled 并把差异原文摆进 tooltip。用户改坏了一列位还导出成功，得到的送货单在
// 客户那边就是废纸 —— 逐条差异（含「期望 / 实际」）就是为了让用户自己看出改错了哪格。

import type { Workbook } from 'hucre/xlsx';
import {
  DELIVERY_NOTE_TEMPLATE_CONTRACT,
  FOOTER_DATE_ANCHOR,
  FOOTER_DRIVER_NAME_ANCHOR,
} from './deliveryNoteTemplateContract';

export type TemplateSource =
  | { kind: 'local'; bytes: Uint8Array; filename: string }
  | { kind: 'url'; url: string };

/** 取模板字节。 */
export async function fetchTemplateBytes(src: TemplateSource): Promise<Uint8Array> {
  if (src.kind === 'local') return src.bytes;
  const resp = await fetch(src.url);
  if (!resp.ok) throw new Error(`模板下载失败（HTTP ${resp.status}）`);
  return new Uint8Array(await resp.arrayBuffer());
}

/** 列字母 → 0-based 列下标（'A' → 0，'J' → 9）。不认 >26 列，模板契约用不到。 */
export function colIndexOf(letter: string): number {
  const n = letter.charCodeAt(0) - 65;
  if (n < 0 || n > 25) throw new Error(`模板契约的列字母越界：${letter}`);
  return n;
}

/** 读一格的文本（null / undefined / 非字符串都归一成串，便于比对与报错）。 */
function cellText(wb: Workbook, row: number, col: number): string {
  const v = wb.sheets[0]?.rows[row]?.[col];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

/** 0-based 下标 → Excel 记法（2 → 'B3'），报错文案里给用户看的锚。 */
function excelRef(row: number, col: number): string {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/**
 * 逐格比对模板结构，返回差异清单（**空数组 = 通过**）。
 *
 * 检查项：
 *   1. 第 0 个 sheet 存在；
 *   2. row 3 的 B3..J3 恰好是 9 个数据 placeholder；
 *   3. row 3..12 的 A 列都是 `{{no}}`（10 格）；
 *   4. F15 含 `{{driver_name}}`；A17 含 `{{year}}` / `{{month}}` / `{{date}}`。
 *
 * 异步只是为了与「打开工作簿」这一步同形（调用方拿到 bytes 后先 openXlsx 再断言），
 * 内部是同步计算。
 */
export async function assertTemplateMatches(wb: Workbook): Promise<string[]> {
  const c = DELIVERY_NOTE_TEMPLATE_CONTRACT;
  const diffs: string[] = [];

  const sheet = wb.sheets[c.sheetIndex];
  if (!sheet) {
    return [`缺少第 ${c.sheetIndex + 1} 个工作表（模板必须是单 sheet 结构）`];
  }

  // row 3（0-based 2）的 9 个数据列。no 列单独查（10 行都要有）。
  const row3: [keyof typeof c.columns, string][] = [
    ['order_no', '{{order_no}}'],
    ['l2_customer', '{{l2_customer}}'],
    ['applicant', '{{applicant}}'],
    ['drawing_no', '{{drawing_no}}'],
    ['name', '{{name}}'],
    ['quantity', '{{quantity}}'],
    ['unit', '{{unit}}'],
    ['system_delivery_date', '{{system_delivery_date}}'],
    ['note', '{{note}}'],
  ];
  for (const [field, expected] of row3) {
    const col = colIndexOf(c.columns[field]);
    const actual = cellText(wb, c.dataStartRow, col);
    if (actual !== expected) {
      diffs.push(
        `${excelRef(c.dataStartRow, col)} 期望 ${expected}，实际为${
          actual === '' ? '「空」' : `「${actual}」`
        }`,
      );
    }
  }

  // 序号列：10 个数据行都要有 `{{no}}`。
  const noCol = colIndexOf(c.columns.no);
  for (let k = 0; k < c.dataRowCount; k += 1) {
    const row = c.dataStartRow + k;
    const actual = cellText(wb, row, noCol);
    if (actual !== '{{no}}') {
      diffs.push(
        `${excelRef(row, noCol)} 期望 {{no}}，实际为${
          actual === '' ? '「空」' : `「${actual}」`
        }`,
      );
    }
  }

  // 页脚：占位符嵌在整串文案里，只查「包含」。
  const driverRef = c.footer.driver_name;
  const driverRow = 14; // F15
  const driverCol = colIndexOf(driverRef);
  if (!cellText(wb, driverRow, driverCol).includes('{{driver_name}}')) {
    diffs.push(
      `${driverRef} 应包含 {{driver_name}}（锚文案「${FOOTER_DRIVER_NAME_ANCHOR}」）`,
    );
  }
  const dateRef = c.footer.year;
  const dateRow = 16; // A17
  const dateCol = colIndexOf(dateRef);
  const dateCell = cellText(wb, dateRow, dateCol);
  for (const ph of ['{{year}}', '{{month}}', '{{date}}']) {
    if (!dateCell.includes(ph)) {
      diffs.push(`${dateRef} 应包含 ${ph}（锚文案「${FOOTER_DATE_ANCHOR}」）`);
    }
  }

  return diffs;
}