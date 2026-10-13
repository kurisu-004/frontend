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
//
// 2026-10-16 新增检具版：校验按 `contract.kind` 分派到两套逐格判据（版式差异全在
// 契约里），`contract` 缺省仍是零件版 ⇒ 打印对话框的既有调用零改动。

import type { Sheet, Workbook } from 'hucre/xlsx';
import {
  DELIVERY_NOTE_TEMPLATE_CONTRACT,
  FOOTER_DATE_ANCHOR,
  FOOTER_DRIVER_NAME_ANCHOR,
} from './deliveryNoteTemplateContract';
import type {
  DeliveryNoteTemplateContract,
  GaugeDeliveryNoteTemplateContract,
  PartDeliveryNoteTemplateContract,
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

/** 列字母 → 0-based 列下标（'A' → 0，'J' → 9）。
 *  ⚠️ 只认**单字母**列：模板契约的数据列全在 A..J 内，多字母（'AA'）被静默
 *  当成 'A' 会把值写错列且不发任何错 —— 故显式拒绝。 */
export function colIndexOf(letter: string): number {
  if (!/^[A-Z]$/.test(letter)) throw new Error(`模板契约的列字母必须是单个 A-Z：${letter}`);
  return letter.charCodeAt(0) - 65;
}

/** A1 记法 → 0-based 行列（'F15' → { row: 14, col: 5 }）。页脚锚点用的是整格引用。 */
export function parseRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z])(\d+)$/.exec(ref);
  if (!m) throw new Error(`模板契约的单元格引用格式不对：${ref}`);
  return { row: Number(m[2]) - 1, col: colIndexOf(m[1]!) };
}

/** 读一格的文本（null / undefined / 非字符串都归一成串，便于比对与报错）。
 *  取 sheet 形参而不读 `wb.sheets[0]`：调用方已按契约的 `sheetIndex` 取过并判过存在。 */
function cellText(sheet: Sheet, row: number, col: number): string {
  const v = sheet.rows[row]?.[col];
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

/** 0-based 下标 → Excel 记法（2 → 'B3'），报错文案里给用户看的锚。 */
function excelRef(row: number, col: number): string {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/** 一格比对不通过的统一文案（两套版式逐格差异共用同一条格式）。
 *
 *  `note` 是可选的**补充说明**：检具版用它把「契约声明的哪一列该写什么」摊开 —— 用户看到的
 *  要么是「模板那格被改坏了」，要么是「契约说这一列该有占位符而模板里没有」，两类问题不该
 *  报出同一条差异。 */
function diffText(ref: string, expected: string, actual: string, note?: string): string {
  const head = `${ref} 期望 ${expected}，实际为${actual === '' ? '「空」' : `「${actual}」`}`;
  return note ? `${head}${note}` : head;
}

/**
 * 逐格比对**零件版**模板结构，返回差异清单（**空数组 = 通过**）。
 *
 * 检查项：
 *   1. 第 0 个 sheet 存在（在 `assertTemplateMatches` 里查）；
 *   2. row 3 的 B3..J3 恰好是 9 个数据 placeholder；
 *   3. row 3..12 的 A 列都是 `{{no}}`（10 格）；
 *   4. F15 含 `{{driver_name}}`；A17 含 `{{year}}` / `{{month}}` / `{{date}}`。
 */
function assertPartMatches(
  sheet: Sheet,
  c: PartDeliveryNoteTemplateContract,
): string[] {
  const diffs: string[] = [];

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
    const actual = cellText(sheet, c.dataStartRow, col);
    if (actual !== expected) {
      diffs.push(diffText(excelRef(c.dataStartRow, col), expected, actual));
    }
  }

  // 序号列：10 个数据行都要有 `{{no}}`。
  const noCol = colIndexOf(c.columns.no);
  for (let k = 0; k < c.dataRowCount; k += 1) {
    const row = c.dataStartRow + k;
    const actual = cellText(sheet, row, noCol);
    if (actual !== '{{no}}') {
      diffs.push(diffText(excelRef(row, noCol), '{{no}}', actual));
    }
  }

  // 页脚：占位符嵌在整串文案里，只查「包含」。锚点用整格引用（A1 记法）。
  const driverRef = c.footer.driver_name;
  const driverAt = parseRef(driverRef);
  if (!cellText(sheet, driverAt.row, driverAt.col).includes('{{driver_name}}')) {
    diffs.push(
      `${driverRef} 应包含 {{driver_name}}（锚文案「${FOOTER_DRIVER_NAME_ANCHOR}」）`,
    );
  }
  const dateRef = c.footer.year;
  const dateAt = parseRef(dateRef);
  const dateCell = cellText(sheet, dateAt.row, dateAt.col);
  for (const ph of ['{{year}}', '{{month}}', '{{date}}']) {
    if (!dateCell.includes(ph)) {
      diffs.push(`${dateRef} 应包含 ${ph}（锚文案「${FOOTER_DATE_ANCHOR}」）`);
    }
  }

  return diffs;
}

/** 检具版首行数据区（0-based row 4 = Excel row 5）**应写**的占位符，逐列列明。
 *
 *  ⚠️ 显式表而不是 `expected = \`{{\${field}}}\` 反推（2026-10-16）：反推让「契约键名写错」
 *  与「模板那格没有占位符」两类问题报出同一条差异，用户无从判断该改契约还是改模板。键集由
 *  `satisfies` 与契约 `columns`（除序号列外）**绑死** —— 契约增删列而不改这张表，`tsc` 当场红。 */
const GAUGE_ROW5_PLACEHOLDERS = {
  order_no: '{{order_no}}',
  drawing_no: '{{drawing_no}}',
  name: '{{name}}',
  quantity: '{{quantity}}',
  system_delivery_date: '{{system_delivery_date}}',
} satisfies Record<Exclude<keyof GaugeDeliveryNoteTemplateContract['columns'], 'no'>, string>;

/**
 * 逐格比对**检具版**模板结构，返回差异清单（**空数组 = 通过**）。
 *
 * 检查项（2026-10-16 实测版式）：
 *   1. 第 0 个 sheet 存在（在 `assertTemplateMatches` 里查）；
 *   2. row 5 的 5 个数据 placeholder（`columns` 里除 `no` 外的全部列）；
 *   3. row 5..29 的 A 列都是 `{{no}}`（25 格）；
 *   4. I2 含 `{{delivery_date}}`。
 *
 * ⚠️ row 3-4 是**两行表头**、row 30-31 是填写说明：**不参与校验** —— 表头文案随客户
 * 措辞调整（列名、列宽都按客户样例来），拿来当判据只会在客户改措辞时误报。
 */
function assertGaugeMatches(sheet: Sheet, c: GaugeDeliveryNoteTemplateContract): string[] {
  const diffs: string[] = [];

  // row 5（0-based 4）的数据列：走显式占位符表（序号列不在表内，25 行单独全查）。
  for (const field of Object.keys(GAUGE_ROW5_PLACEHOLDERS) as Array<
    keyof typeof GAUGE_ROW5_PLACEHOLDERS
  >) {
    const expected = GAUGE_ROW5_PLACEHOLDERS[field];
    const letter = c.columns[field];
    const col = colIndexOf(letter);
    const actual = cellText(sheet, c.dataStartRow, col);
    if (actual !== expected) {
      diffs.push(
        diffText(
          excelRef(c.dataStartRow, col),
          expected,
          actual,
          `（契约声明列 ${field} 在第 ${c.dataStartRow + 1} 行应写占位符 ${expected}，落在 ${letter} 列）`,
        ),
      );
    }
  }

  // 序号列：25 个数据行都要有 `{{no}}`。
  const noCol = colIndexOf(c.columns.no);
  for (let k = 0; k < c.dataRowCount; k += 1) {
    const row = c.dataStartRow + k;
    const actual = cellText(sheet, row, noCol);
    if (actual !== '{{no}}') {
      diffs.push(diffText(excelRef(row, noCol), '{{no}}', actual));
    }
  }

  // 送货日期锚在表头右侧的 I2（不是页脚区），整格只有这一个占位符，只查「包含」。
  const ddRef = c.footer.delivery_date;
  const ddAt = parseRef(ddRef);
  if (!cellText(sheet, ddAt.row, ddAt.col).includes('{{delivery_date}}')) {
    diffs.push(`${ddRef} 应包含 {{delivery_date}}`);
  }

  return diffs;
}

/**
 * 逐格比对模板结构，返回差异清单（**空数组 = 通过**）。
 *
 * 按 `contract.kind` 分派到对应版式的校验（`part` 见 `assertPartMatches`、
 * `gauge` 见 `assertGaugeMatches`）。契约缺省是零件版 —— 现有调用方（打印对话框
 * 校验用户上传的模板）零改动继续走老口径。
 *
 * 异步只是为了与「打开工作簿」这一步同形（调用方拿到 bytes 后先 openXlsx 再断言），
 * 内部是同步计算。
 */
export async function assertTemplateMatches(
  wb: Workbook,
  contract: DeliveryNoteTemplateContract = DELIVERY_NOTE_TEMPLATE_CONTRACT,
): Promise<string[]> {
  const sheet = wb.sheets[contract.sheetIndex];
  if (!sheet) {
    return [`缺少第 ${contract.sheetIndex + 1} 个工作表（模板必须是单 sheet 结构）`];
  }
  return contract.kind === 'gauge'
    ? assertGaugeMatches(sheet, contract)
    : assertPartMatches(sheet, contract);
}