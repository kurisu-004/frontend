// src/views/com/delivery/utils/deliveryNoteLabelWorkbook.ts
//
// 「打印标签」的工作簿渲染（2026-10-08 新增）：**单 sheet、无模板**，7 列一行一标签，
// 前端用 hucre 本地生成。行序 = 对话框里的勾选顺序（tabs 顺序 → 组内当前行序），
// 调用方决定传什么顺序进来，这里不做任何重排。
//
// **为什么不用模板 round-trip（openXlsx/saveXlsx）**：标签不是合同，是一张张贴在零件上
// 的小纸条 —— 用户要的是「7 列、按需打印」，不是「一张带合并单元格的表」。走
// writeXlsx 从零建表正好把「无需上传模板」这件事做实，也省掉一次用户交互。
//
// ⚠️ 文件放**域内** utils（不放 `src/utils/`）：它 import 了 `PrintRow`（域内类型），
// 放通用目录会让 `src/utils/` 反向依赖 `views/`（CLAUDE.md §目录归位）。
//
// ⚠️ **动态 import hucre 是硬约束**：静态 import 会把 xlsx 写引擎拉进主 bundle，
// 而绝大多数用户打开送货单详情页时根本不会点打印。specifier 必须是**字面量**
// （写成变量 / 加 `/* @vite-ignore */` 都会让产物里留下一句运行时裸 import，浏览器 404）。

import { XLSX_MIME } from './deliveryNoteTemplateContract';
import type { PrintRow } from './deliveryNotePrintRows';

/** 标签工作簿的 MIME（与送货单一致，都是 xlsx zip）。 */
export const DELIVERY_NOTE_LABEL_XLSX_MIME: string = XLSX_MIME;

/** 单个标签列。`key` 是 `PrintRow` 字段名（渲染时直接由行投影取值）。 */
export interface LabelColumn {
  key: string;
  label: string;
}

/** 7 列，**顺序即 xlsx 输出列序**（客户 / 订单号 / 申请人 / 名称 / 图号 / 数量 / 单位）。 */
export const DELIVERY_NOTE_LABEL_COLUMNS: readonly LabelColumn[] = [
  { key: 'l2_customer', label: '客户' },
  { key: 'order_no', label: '订单号' },
  { key: 'applicant_name', label: '申请人' },
  { key: 'name', label: '名称' },
  { key: 'drawing_no', label: '图号' },
  { key: 'quantity', label: '数量' },
  { key: 'unit', label: '单位' },
];

/** sheet 名（单 sheet，无模板可继承）。 */
const LABEL_SHEET_NAME = '标签';

type LabelRecord = Record<string, string | number>;

/** 一行 `PrintRow` → 标签行的 7 个单元格（quantity 为 null 的行不进来）。 */
function toLabelRecord(r: PrintRow): LabelRecord {
  return {
    l2_customer: r.l2_customer,
    order_no: r.order_no,
    applicant_name: r.applicant_name,
    name: r.name,
    drawing_no: r.drawing_no,
    quantity: r.quantity as number,
    unit: r.unit,
  };
}

/**
 * 渲染标签工作簿（单 sheet、无模板）。
 *
 * - `columns` 每项 `{ header, key, autoWidth: true }`（`autoWidth` 让列宽跟着内容走，
 *   客户名 / 名称长度差异大，写死宽度必然有一头截断）；
 * - **`quantity === null` 的行整行跳过**并计入 `skipped`：装配件父行的数量是「后端没给
 *   可出货套数」，打出来是一张数量空的标签，贴到零件上只会让人以为这批没货；
 * - 装配件父行不用额外处理：`quantity` 是可出货套数、`unit` 是「套」，与散件行走同一
 *   套 `PrintRow`。
 *
 * 返回 `skipped` 是为了让调用方在 toast 里如实说出跳过了几条，而不是静悄悄少打几张；
 * 返回 `written`（**实际写进 xlsx 的那些行**，按写入顺序）是给「已打印标签」标记用的 ——
 * 跳过的行根本没出纸，标成已打印就是绿底骗人（2026-10-08 修）。
 */
export async function renderDeliveryNoteLabelWorkbook(
  rows: readonly PrintRow[],
): Promise<{ bytes: Uint8Array; skipped: number; written: PrintRow[] }> {
  const data: LabelRecord[] = [];
  const written: PrintRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.quantity === null) {
      skipped += 1;
      continue;
    }
    data.push(toLabelRecord(r));
    written.push(r);
  }

  const { writeXlsx } = await import('hucre');
  const bytes = await writeXlsx({
    sheets: [
      {
        name: LABEL_SHEET_NAME,
        columns: DELIVERY_NOTE_LABEL_COLUMNS.map((c) => ({
          header: c.label,
          key: c.key,
          autoWidth: true,
        })),
        data,
      },
    ],
  });
  return { bytes, skipped, written };
}
