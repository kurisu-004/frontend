// src/views/com/delivery/utils/deliveryNoteTemplate.ts
//
// 送货单打印模板的取字节 + 结构校验（2026-10-08 新增）。
//
// 模板来源三种形态（`TemplateSource`），**只有数据来源不同，渲染与校验链路逐字相同**：
//   · `local` —— 用户在打印对话框里临时上传的文件（el-upload 给的 raw File → bytes）；
//   · `api`   —— **2026-10-16 新增**：后端 `/api/v2/print-templates` 按**一级客户**绑定的
//                模板，打印对话框打开时用 `resolve` 端点选中、再按 id 取字节。管理员在
//                「模板编辑」页（`/print-templates`）上传 / 替换 / 删除，日常打印零操作自动
//                命中；
//   · `url`   —— **预留**：后端把模板绑到 COS 后由前端按裸 URL 取。当前没有调用方，
//                留着是为了让「再换数据源」这件事将来不动任何渲染代码。
//
// ⚠️ **`api` 形态必须走 axios，不能用裸 `fetch`**：`GET /{id}/content` 要 Authorization 头
//（后端按权限点 `delivery_note.print` 判定），裸 `fetch` 带不上 ⇒ 401。同理 `resolve`
// 出参里那条 `content_url` 是**不含 `/api/v2` 的相对路径**、也不带鉴权头，不能塞进
// `<a href>` —— 取字节一律走 `api/printTemplates.ts::fetchPrintTemplateContent(id)`。
//
// ⚠️ 校验失败**不静默**：assertTemplateMatches 返回逐条差异，由对话框把「导出」按钮
// 置 disabled 并把差异原文摆进 tooltip。用户改坏了一列位还导出成功，得到的送货单在
// 客户那边就是废纸 —— 逐条差异（含「期望 / 实际」）就是为了让用户自己看出改错了哪格。
//
// ⚠️ **服务端取回的字节必须复验**：`api` 形态的字节是别人（管理员）上传的，可能在被绑定
// 之后又被改坏。打印对话框打开时那次 `assertTemplateMatches` 就是这条护栏 —— 它与本地
// 上传那份逐格同判，不因「它来自我们自己的服务器」而放行。

import { fetchPrintTemplateContent } from '@/api/printTemplates';
import type { Workbook } from 'hucre/xlsx';
import {
  DELIVERY_NOTE_TEMPLATE_CONTRACT,
  FOOTER_DATE_ANCHOR,
  FOOTER_DRIVER_NAME_ANCHOR,
} from './deliveryNoteTemplateContract';

export type TemplateSource =
  | { kind: 'local'; bytes: Uint8Array; filename: string }
  /** 后端库里那份（按 id 取字节；文件名走 `templateName` 那侧的展示位）。 */
  | { kind: 'api'; id: string }
  | { kind: 'url'; url: string };

/** 取模板字节。 */
export async function fetchTemplateBytes(src: TemplateSource): Promise<Uint8Array> {
  if (src.kind === 'local') return src.bytes;
  if (src.kind === 'api') return fetchPrintTemplateContent(src.id);
  const resp = await fetch(src.url);
  if (!resp.ok) throw new Error(`模板下载失败（HTTP ${resp.status}）`);
  return new Uint8Array(await resp.arrayBuffer());
}

/** 列字母 → 0-based 列下标（'A' → 0，'J' → 9）。
 *  ⚠️ 只认**单字母**列：模板契约的 10 个数据列全在 A..J 内，多字母（'AA'）被静默
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

  // 页脚：占位符嵌在整串文案里，只查「包含」。锚点用整格引用（A1 记法）。
  const driverRef = c.footer.driver_name;
  const driverAt = parseRef(driverRef);
  if (!cellText(wb, driverAt.row, driverAt.col).includes('{{driver_name}}')) {
    diffs.push(
      `${driverRef} 应包含 {{driver_name}}（锚文案「${FOOTER_DRIVER_NAME_ANCHOR}」）`,
    );
  }
  const dateRef = c.footer.year;
  const dateAt = parseRef(dateRef);
  const dateCell = cellText(wb, dateAt.row, dateAt.col);
  for (const ph of ['{{year}}', '{{month}}', '{{date}}']) {
    if (!dateCell.includes(ph)) {
      diffs.push(`${dateRef} 应包含 ${ph}（锚文案「${FOOTER_DATE_ANCHOR}」）`);
    }
  }

  return diffs;
}