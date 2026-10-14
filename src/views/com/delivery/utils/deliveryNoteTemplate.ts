// src/views/com/delivery/utils/deliveryNoteTemplate.ts
//
// 送货单打印模板的**版式探测** + 取字节 + 结构校验（2026-10-08 新增）。
//
// 模板来源两种形态（`TemplateSource`），**只有数据来源不同，取到字节之后的探测 / 校验 /
// 渲染链路逐字相同**：
//   · `api` —— 后端 `/api/v2/print-templates` 按**一级客户**绑定的模板，打印对话框打开时用
//              `resolve` 端点选中、再按 id 取字节。管理员在「模板编辑」页（`/print-templates`）
//              上传 / 替换 / 删除，日常打印零操作自动命中；
//   · `url` —— **预留**：后端把模板绑到 COS 后由前端按裸 URL 取。当前没有调用方，留着是为了
//              让「再换数据源」这件事将来不动任何渲染代码。
//
// ⚠️ **`api` 形态必须走 axios，不能用裸 `fetch`**：`GET /{id}/content` 要 Authorization 头
//（后端按权限点 `delivery_note.print` 判定），裸 `fetch` 带不上 ⇒ 401。取字节一律走
// `api/printTemplates.ts::fetchPrintTemplateContent(id)` —— 后端 resolve 出参里**没有**
// `content_url` 这个字段，本域因此也没有任何「拼相对路径塞 `<a href>`」的写法。
//
// ⚠️ 版式由**前端从模板结构判定**（`detectTemplateContract`，见下），不是后端给的字段：后端模板
// 行的 `kind` 恒为 `DELIVERY_TEMPLATE`，两套版式对它完全不可见。
//
// ⚠️ `assertTemplateMatches` 返回**逐条差异**（空数组 = 通过），怎么处置由调用方决定。差异
// 带「期望 / 实际」两半：用户改坏了一列位还导出成功，得到的送货单在客户那边就是废纸，逐条
// 差异就是为了让改错的人自己看出改错了哪格。
//
// 2026-10-16 新增检具版：校验按 `contract.kind` 分派到两套逐格判据（版式差异全在契约里），
// `contract` 缺省仍是零件版 ⇒ 既有调用零改动。

import { fetchPrintTemplateContent } from '@/api/printTemplates';
import type { Sheet, Workbook } from 'hucre/xlsx';
import {
  DELIVERY_NOTE_TEMPLATE_CONTRACT,
  FOOTER_DATE_ANCHOR,
  FOOTER_DRIVER_NAME_ANCHOR,
  GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT,
} from './deliveryNoteTemplateContract';
import type {
  DeliveryNoteTemplateContract,
  GaugeDeliveryNoteTemplateContract,
  PartDeliveryNoteTemplateContract,
} from './deliveryNoteTemplateContract';

export type TemplateSource =
  /** 后端库里那份（按 id 取字节；文件名走 `templateName` 那侧的展示位）。 */
  | { kind: 'api'; id: string }
  | { kind: 'url'; url: string };

/** 取模板字节。 */
export async function fetchTemplateBytes(src: TemplateSource): Promise<Uint8Array> {
  if (src.kind === 'api') return fetchPrintTemplateContent(src.id);
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

/**
 * 检具版首行数据区（0-based row 4 = Excel row 5）**应写**的占位符，逐列列明。
 *
 *  ⚠️ 显式表而不是 `expected = \`{{\${field}}}\` 反推（2026-10-16）：反推让「契约键名写错」
 *  与「模板那格没有占位符」两类问题报出同一条差异，用户无从判断该改契约还是改模板。键集由
 *  `satisfies` 与契约 `columns`（除序号列外）**绑死** —— 契约增删列而不改这张表，`tsc` 当场红。
 *  （键名与占位符**同形**在这张表里成立，是因为 C 列键名 `customer_path` 与占位符
 *  `{{customer_path}}` 是本轮一起定的；零件版那张 row3 表里就有反例 `l2_customer`。） */
const GAUGE_ROW5_PLACEHOLDERS = {
  order_no: '{{order_no}}',
  customer_path: '{{customer_path}}',
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
 *   2. row 5 的 6 个数据 placeholder（`columns` 里除 `no` 外的全部列）；
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
 * `gauge` 见 `assertGaugeMatches`）。契约缺省是零件版 —— 不传契约的老调用零改动。
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

/** 零件版契约的判别锚点表（O(1)，见 detectTemplateContract 的口径说明）。
 *
 *  坐标一律**从契约常量现推**而不是写死：锚点与校验判据同源，改契约时探测定点也跟着走，
 *  不存在「校验认 row 3、探测认 row 2」这种要人记得同步的两处。 */
const PART_ANCHORS = {
  dataOrderNo: {
    row: DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow,
    col: colIndexOf(DELIVERY_NOTE_TEMPLATE_CONTRACT.columns.order_no),
  },
  driver: parseRef(DELIVERY_NOTE_TEMPLATE_CONTRACT.footer.driver_name),
} as const;

/** 检具版契约的判别锚点表（O(1)，口径同 PART_ANCHORS）。 */
const GAUGE_ANCHORS = {
  dataOrderNo: {
    row: GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow,
    col: colIndexOf(GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT.columns.order_no),
  },
  deliveryDate: parseRef(GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT.footer.delivery_date),
} as const;

/**
 * 从模板结构判定它是哪一套版式（2026-10-18 新增），判不出返 `null`。
 *
 * ⚠️ **版式只能由前端从模板结构判断**：后端模板行的 `kind` 恒是 `DELIVERY_TEMPLATE`，
 * 零件版与检具版对它完全一样。
 *
 * 四个锚点、判别顺序与**互斥理由**（两两不可能同时命中）：
 *   1. 零件版 B3 === `{{order_no}}` —— 检具版 row 3 是表头、B 列是「订单编号」；
 *   2. 检具版 B5 === `{{order_no}}` —— 零件版契约把数据首行钉死在 row 3（`dataStartRow = 2`），
 *      模板 row 5 是「空但有样式」的数据行；
 *   3. 零件版 F15 含 `{{driver_name}}` —— 检具版 F15 在数据区之内、不含该占位符；
 *   4. 检具版 I2 含 `{{delivery_date}}` —— 零件版 I2 是表头「预估交期」，页脚那三个日期
 *      占位符在 A17。
 * 1/2 按数据首行行号分（3 vs 5）、3/4 按锚格位置分（F15 vs I2），互斥关系与锚点取自
 * 契约常量（`PART_ANCHORS` / `GAUGE_ANCHORS`），不另写一份坐标。
 *
 * **O(1)、不产生任何差异列表**：四个锚点各读一格，判不出就是 `null`。⚠️ **刻意不做
 * 「两套契约各跑一遍 `assertTemplateMatches` 看哪套零差异」** —— 那条路要么要求同时备两套
 * 判据跑两遍全表（判不出时给出的是几十条差异却分不清是哪一版坏了），要么得先有一份「版式
 * 已知」的假设；打印页要的是一个**二选一**的结论，判不出就明说判不出。
 *
 * 缺工作表返 `null`（不抛）：调用方把 `null` 当「这份模板不认识」处置，与
 * `assertTemplateMatches` 的「一条差异」是两条不同的失败语义，本函数不越界去造差异文案。
 */
export function detectTemplateContract(wb: Workbook): DeliveryNoteTemplateContract | null {
  // 取 sheet 借**零件契约**的 `sheetIndex`：两套契约的 `sheetIndex` 同为 0，取哪一份结果一样，
  // 这里与下面的锚点表同源即可。⚠️ 两者一旦分家（某套版式改用别的 sheet），这里要跟着改。
  const sheet = wb.sheets[DELIVERY_NOTE_TEMPLATE_CONTRACT.sheetIndex];
  if (!sheet) return null;
  const at = (a: { row: number; col: number }): string => cellText(sheet, a.row, a.col);
  if (at(PART_ANCHORS.dataOrderNo) === '{{order_no}}') return DELIVERY_NOTE_TEMPLATE_CONTRACT;
  if (at(GAUGE_ANCHORS.dataOrderNo) === '{{order_no}}') return GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT;
  if (at(PART_ANCHORS.driver).includes('{{driver_name}}')) {
    return DELIVERY_NOTE_TEMPLATE_CONTRACT;
  }
  if (at(GAUGE_ANCHORS.deliveryDate).includes('{{delivery_date}}')) {
    return GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT;
  }
  return null;
}
