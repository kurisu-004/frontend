// purchaseOrderExcelParser.ts
//
// 解析采购订单 Excel 的「基本资料」与「采购订单明细」sheet。
// 纯函数：仅依赖 xlsx/dayjs，不触发网络或 DOM。

import dayjs from 'dayjs';
import * as XLSX from 'xlsx';

import { cleanText } from './xlsxParseUtils';

export interface PurchaseOrderExcelItem {
  /** 1-based Excel 真实行号。 */
  rowNo: number;
  /** 采购订单行号，例如 10、20。 */
  lineNo: string;
  deleted: boolean;
  drawingNo: string;
  name: string;
  /** YYYY-MM-DD 或 null。 */
  deliveryDate: string | null;
  unitPrice: number | null;
  shippableQty: number | null;
}

export interface ParsedPurchaseOrder {
  docNo: string;
  items: PurchaseOrderExcelItem[];
  /** 解析失败的致命错误。 */
  errors: string[];
  /** 不阻塞导入的格式或跳行提醒。 */
  warnings: string[];
}

const BASE_SHEET_NAME = '基本资料';
const DETAIL_SHEET_NAME = '采购订单明细';
const HEADER_ROW_INDEX = 3;
const DATA_START_ROW_INDEX = 4;

const REQUIRED_DETAIL_HEADERS = ['物料代码', '订单物料描述'] as const;
const OPTIONAL_DETAIL_HEADERS = [
  '采购订单行号',
  '已删除',
  '交货日期',
  '含税价',
  '可出货数量',
] as const;

const EXPECTED_DETAIL_COLUMNS: Record<string, number> = {
  采购订单行号: 0,
  已删除: 2,
  物料代码: 3,
  订单物料描述: 4,
  交货日期: 6,
  含税价: 7,
  可出货数量: 10,
};

type SheetRows = unknown[][];

function readSheetRows(sheet: XLSX.WorkSheet): SheetRows {
  // sheet['!ref'] 由 Excel 写入：若工作簿存在合并单元格或「中间列被全列空跳过」，
  // 实际单元格可能延伸到声明范围之外（实测：含可出货数量的采购订单明细
  // 真实数据到 AG88，但 !ref 仅为 A1:H88），sheet_to_json 默认按 !ref 切，
  // 会把表头和数据都裁成 8 列 → 全部可选列解析失败。
  // 这里从实际单元格重新计算 extents，再显式传给 sheet_to_json。
  let range: XLSX.Range | undefined;
  let maxCol = -1;
  let maxRow = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    const addr = XLSX.utils.decode_cell(key);
    if (addr.c > maxCol) maxCol = addr.c;
    if (addr.r > maxRow) maxRow = addr.r;
  }
  if (maxCol >= 0 && maxRow >= 0) {
    range = { s: { c: 0, r: 0 }, e: { c: maxCol, r: maxRow } };
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    // header: 1 默认保留空行；显式声明以确保数组下标等于 Excel 行号 - 1。
    blankrows: true,
    ...(range ? { range } : {}),
  });
}

function buildHeaderMap(headerRow: unknown[]): Map<string, number> {
  const result = new Map<string, number>();
  headerRow.forEach((value, index) => {
    const header = cleanText(value);
    if (header && !result.has(header)) result.set(header, index);
  });
  return result;
}

function parseNumberOrNull(value: unknown): number | null {
  const text = cleanText(value).replace(/,/g, '');
  if (!text) return null;
  const parsed = Number.parseFloat(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 把单元格值解析成 YYYY-MM-DD；无法识别时**原样透传**，让预览阶段能展示源数据。
 *
 * 2026-10-06 导出：解析主链路用 `sheet_to_json({ raw: false })`，Date 单元格会被
 * 格式化成文本再进来（xlsx 在 read 时就会给日期单元格补 `w`），所以下面的
 * `instanceof Date` 分支在 parsePurchaseOrderExcel 里目前不可达；保留它是为了
 * 调用方哪天切 `raw: true` 时不会静默错判，导出则让单测能直接覆盖该分支。
 *
 * 已知缺口（2026-10-06 登记，本轮不修，只留痕）：日期规范化是**宽松**的，
 * 两种输入会被静默归一成另一个日期，用户和界面都看不出来 ——
 *   1. 溢出日期：`2026-02-31` → `2026-03-03`；
 *   2. 美式歧义：raw:false 拿到的是 Excel 数字格式文本，dayjs 走 new Date() 的
 *      美式解析，单元格若是 d/m/yy（`3/5/26` 表示 3 May）会被读成 5 March。
 * 修它要改解析策略（严格模式 / 形态白名单），与 resolveExcelDeliveryDate 的预填
 * 守卫不是同一层，不在守卫里兜 —— 守卫只管「这个值能不能直接用」，管不了
 * 「这个值被归一成了什么」。
 */
export function parseDateOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
  }

  const text = cleanText(value);
  if (!text) return null;

  // raw:false 通常返回 Excel 已格式化的日期字符串；可解析时统一成 YYYY-MM-DD，
  // 无法识别时保留原值，让后续预览/匹配阶段能够展示源数据。
  const parsed = dayjs(text);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : text;
}

/** 解析结果里能直接当系统交期用的日期形态：parseDateOrNull 的合格输出。 */
const USABLE_DELIVERY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** resolveExcelDeliveryDate 的判定结果。 */
export interface ExcelDeliveryDatePrefill {
  /**
   * 给该行追加的中文说明（供 warnings 列 tooltip 汇总），null = 不追加。
   * 注意只有「无法识别」会追加；「没填」不追加 —— 没填是采购订单常态，
   * 塞进与后端异常同构的 warnings 通道会稀释真正要看的异常。
   */
  warning: string | null;
  /**
   * 候选行的系统交期默认值：Excel 值可用时用它，否则用传入的 partDeliveryDate
   * （零件当前已有值，即「不动这一列」）。
   */
  prefill: (partDeliveryDate: string | null) => string | null;
}

/**
 * 判定 Excel 交货日期能不能直接当作系统交期预填。
 *
 * 2026-10-06 新增（MAJOR-1）：parseDateOrNull 对「待定」「2026年8月1日」这类
 * 无法识别的文本是原样透传的，原文会一路流进 batch-update 的 system_delivery_date
 * —— 后端该字段是三态 NaiveDate，反序列化阶段就 400，body 还是纯文本而不是 R
 * 信封，用户已勾选的整批回填全部作废。（el-date-picker 侧不构成来源：2.14.6 的
 * handleChange 只在解析成功时才 emitInput，非法输入只 debugWarn。）
 *
 * 取舍：不可解析时**不能**映射成 null。CandidateRow.systemDeliveryDate 的语义是
 * 「要写入的新值」，而 null 在后端三态里等于**清空成 NULL**；把识别不了的
 * Excel 日期写成 null 会静默抹掉零件上已有的系统交期，比整批 400 更危险。
 * 所以这里退回零件现有的 system_delivery_date（该行这一列不动），并给该行追加
 * 一条中文 warning，用户在预览表的「警告」列能看见。
 *
 * 可用性只看形态（正则）：2026-10-06 曾在这里叠一道 `dayjs(excelValue).isValid()`，
 * 实测是恒真的死条件 —— 2024–2027 全月全日 1848 组 + 边界年份/月份/日期抽样共
 * 2000 余组里「正则放行而 dayjs 判 invalid」的值一个都没有（dayjs 对 2026-02-31、
 * 2026-13-45、0000-00-00 全判 valid，滚成 03-03 / 2027-02-14 / 1899-11-30），
 * 所以已删。
 */
export function resolveExcelDeliveryDate(
  rowNo: number,
  excelValue: string | null,
): ExcelDeliveryDatePrefill {
  if (excelValue != null && USABLE_DELIVERY_DATE.test(excelValue)) {
    return { warning: null, prefill: () => excelValue };
  }
  // 没填不是数据异常（2026-10-06）：采购订单模板里交货日期本就可空，
  // 照常退回零件现有值，但不往 warnings 里塞一条「未填写」去稀释真异常。
  if (excelValue == null || excelValue === '') {
    return { warning: null, prefill: (partDeliveryDate) => partDeliveryDate };
  }
  return {
    warning: `第 ${rowNo} 行交货日期「${excelValue}」无法识别，已保持零件现有系统交期不变`,
    prefill: (partDeliveryDate) => partDeliveryDate,
  };
}

function emptyResult(errors: string[] = []): ParsedPurchaseOrder {
  return { docNo: '', items: [], errors, warnings: [] };
}

/**
 * 解析采购订单 Excel，返回单据编号、有效明细以及错误/警告。
 *
 * @param buf ArrayBuffer（来自 el-upload onChange 的 raw.arrayBuffer()）
 */
export function parsePurchaseOrderExcel(buf: ArrayBuffer): ParsedPurchaseOrder {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buf, { type: 'array', cellDates: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return emptyResult([`无法读取采购订单 Excel：${detail}`]);
  }

  const result: ParsedPurchaseOrder = {
    docNo: '',
    items: [],
    errors: [],
    warnings: [],
  };

  const baseSheet = workbook.Sheets[BASE_SHEET_NAME];
  if (!baseSheet) {
    result.errors.push(`Excel 缺少 "${BASE_SHEET_NAME}" sheet`);
  } else {
    const rows = readSheetRows(baseSheet);
    const headerMap = buildHeaderMap(rows[HEADER_ROW_INDEX] ?? []);
    const docNoColumn = headerMap.get('单据编号');

    if (docNoColumn == null) {
      result.errors.push(`"${BASE_SHEET_NAME}" sheet 缺少必需列：单据编号`);
    } else {
      result.docNo = cleanText(rows[DATA_START_ROW_INDEX]?.[docNoColumn]);
      if (!result.docNo) {
        result.errors.push(`"${BASE_SHEET_NAME}" sheet 第 5 行的单据编号为空`);
      }
    }
  }

  const detailSheet = workbook.Sheets[DETAIL_SHEET_NAME];
  if (!detailSheet) {
    result.errors.push(`Excel 缺少 "${DETAIL_SHEET_NAME}" sheet`);
    return result;
  }

  const rows = readSheetRows(detailSheet);
  const headerMap = buildHeaderMap(rows[HEADER_ROW_INDEX] ?? []);
  const missingRequired = REQUIRED_DETAIL_HEADERS.filter((header) => !headerMap.has(header));
  if (missingRequired.length > 0) {
    result.errors.push(`"${DETAIL_SHEET_NAME}" sheet 缺少必需列：${missingRequired.join('、')}`);
    return result;
  }

  for (const header of [...REQUIRED_DETAIL_HEADERS, ...OPTIONAL_DETAIL_HEADERS]) {
    const actualColumn = headerMap.get(header);
    const expectedColumn = EXPECTED_DETAIL_COLUMNS[header];
    if (actualColumn != null && actualColumn !== expectedColumn) {
      result.warnings.push(
        `"${DETAIL_SHEET_NAME}" sheet 的「${header}」列位置与标准模板不一致，已按表头识别`,
      );
    }
  }

  for (const header of OPTIONAL_DETAIL_HEADERS) {
    if (!headerMap.has(header)) {
      result.warnings.push(`"${DETAIL_SHEET_NAME}" sheet 缺少可选列「${header}」，对应字段将留空`);
    }
  }

  const lineNoColumn = headerMap.get('采购订单行号') ?? 0;
  const deletedColumn = headerMap.get('已删除');
  const drawingNoColumn = headerMap.get('物料代码')!;
  const nameColumn = headerMap.get('订单物料描述')!;
  const deliveryDateColumn = headerMap.get('交货日期');
  const unitPriceColumn = headerMap.get('含税价');
  const shippableQtyColumn = headerMap.get('可出货数量');

  for (let rowIndex = DATA_START_ROW_INDEX; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    const marker = cleanText(row[lineNoColumn]);

    // 每个主明细后跟「计划行」子表头和序号为 1 的子数据；只保留数字主行。
    if (marker === '计划行' || marker === '1' || !/^\d+$/.test(marker)) continue;

    const rowNo = rowIndex + 1;
    const deleted = deletedColumn != null && cleanText(row[deletedColumn]) === '是';
    if (deleted) {
      result.warnings.push(`第 ${rowNo} 行（采购订单行号 ${marker}）已删除，已跳过`);
      continue;
    }

    const drawingNo = cleanText(row[drawingNoColumn]);
    const name = cleanText(row[nameColumn]);
    if (!drawingNo && !name) continue;

    result.items.push({
      rowNo,
      lineNo: marker,
      deleted: false,
      drawingNo,
      name,
      deliveryDate: deliveryDateColumn == null ? null : parseDateOrNull(row[deliveryDateColumn]),
      unitPrice: unitPriceColumn == null ? null : parseNumberOrNull(row[unitPriceColumn]),
      shippableQty: shippableQtyColumn == null ? null : parseNumberOrNull(row[shippableQtyColumn]),
    });
  }

  return result;
}
