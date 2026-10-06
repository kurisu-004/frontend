// purchaseOrderExcelParser 单元测试。
//
// 钉住两个已踩过、且极易回归的坑：
//   A. sheet['!ref'] 低报真实数据范围 → readSheetRows 从实际单元格重算 extents 再切；
//   B. 每个主明细后跟的「计划行」子表头 + 序号 1 子数据 → 行准入过滤只收数字主行。
//
// 内存 workbook 用 XLSX.utils.aoa_to_sheet 造，不依赖 .xlsx 二进制 fixture
// （__fixtures__ 下现有的两个文件是招标 / 历史价模板，没有采购订单 sheet）。
//
// 坑 A 的造法有个坑：直接在内存 sheet 上改窄 sheet['!ref'] 再 XLSX.write 是
// **无效**的——write 按 !ref 落盘，外侧单元格会被直接丢掉，写出来的文件里
// 根本没有第 11 列，解析器自然"看不出"问题。所以这里写盘后再改 zip 里
// sheet XML 的 <dimension>，这才是 Excel 自身 dimension 陈旧的真实形态
// （单元格真实存在、!ref 声明偏窄）。

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';

import {
  parseDateOrNull,
  parsePurchaseOrderExcel,
  resolveExcelDeliveryDate,
  type PurchaseOrderExcelItem,
} from '../purchaseOrderExcelParser';

const DOC_NO = 'CG2026-1001';
const BASE_SHEET = '基本资料';
const DETAIL_SHEET = '采购订单明细';

/** 明细 sheet 的最后一行的 1-based Excel 行号（8 行数据 + 4 行前置）。 */
const DETAIL_LAST_ROW = 10;

/**
 * 刻意写窄的 !ref：只声明到 H 列，而真实的可出货数量在 K 列（第 11 列）。
 * 解析器若按 !ref 切，第 6 / 7 / 10 / 11 列的可选值全部解析失败。
 */
const NARROW_REF = `A1:H${DETAIL_LAST_ROW}`;

/** 「基本资料」sheet：第 4 行表头含单据编号，第 5 行是数据。 */
function buildBaseSheet(): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([
    ['采购订单'],
    [null],
    [null],
    ['单据编号', '供应商名称'],
    [DOC_NO, '哈尔滨轴承'],
  ]);
}

/**
 * 「采购订单明细」第 4 行表头：列位置对齐解析器 EXPECTED_DETAIL_COLUMNS
 * （采购订单行号 A / 已删除 C / 物料代码 D / 订单物料描述 E / 交货日期 G /
 * 含税价 H / 可出货数量 K），位置错位会额外产生「列位置不一致」warning。
 */
const DETAIL_HEADER = [
  '采购订单行号',
  '规格型号',
  '已删除',
  '物料代码',
  '订单物料描述',
  '订单数量',
  '交货日期',
  '含税价',
  '交货地点',
  '备注',
  '可出货数量',
];

/**
 * 默认明细数据（从 Excel 第 5 行起），混入三种干扰行：
 * 计划行子表头、序号 1 子数据、已删除主明细 —— 后两者是坑 B 的复现点。
 */
const DETAIL_DATA_ROWS: unknown[][] = [
  // 第 5 行：主明细，采购订单行号 10
  ['10', 'M8', '', 'PO-001', '法兰盘', 5, '2026-08-01', 12.5, '', '', 30],
  // 第 6 行：计划行子表头（非数字标记，必须跳过）
  ['计划行', '', '', '', '', '', '', '', '', '', ''],
  // 第 7 行：计划行子数据，序号 1（必须跳过）
  ['1', '', '', 'PO-001-SUB', '法兰盘子件', 5, '2026-08-01', 3, '', '', 5],
  // 第 8 行：主明细，采购订单行号 20
  ['20', 'M10', '', 'PO-002', '轴承座', 3, '2026-09-15', 88, '', '', 7],
  // 第 9 行：已删除的主明细（应跳过并给 warning）
  ['30', 'M12', '是', 'PO-003', '废弃件', 1, '2026-10-01', 10, '', '', 1],
  // 第 10 行：主明细，采购订单行号 40
  ['40', 'M16', '', 'PO-004', '齿轮', 2, '2026-11-01', 20, '', '', 4],
];

function buildDetailSheet(dataRows: unknown[][] = DETAIL_DATA_ROWS): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([['采购订单明细'], [null], [null], DETAIL_HEADER, ...dataRows]);
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView | ArrayLike<number>): ArrayBuffer {
  return new Uint8Array(data as ArrayLike<number>).buffer;
}

/**
 * 把「采购订单明细」sheet 的 <dimension> 改写为 ref（外侧单元格保持原样落盘）。
 *
 * errorLabel 只是报错文案里的可读标签，**不参与定位** —— 定位靠明细表头的
 * 「可出货数量」字面量，改 sheet 顺序也不会认错目标。
 *
 * 依赖 xlsx 的三个内部细节（0.18.5 的 d.ts 把 CFB 声明成 any，全是 any 下的断言，
 * 注释掉一个字段名也不会报错，所以这里写明）：
 *   1. zip 条目名形如 `sheet2.xml`（CFB 读出来是 FileIndex[]，路径在 FullPaths）；
 *   2. worksheet XML 的 <dimension ref="A1:K10"/> 是自闭合标签；
 *   3. FileIndex 的目录项必须**原地**改 content（并同步 size），换成新对象会写坏 zip。
 * 这三点在 package.json pin 的 xlsx 0.18.5 下不会漂（锁文件固定，且 xlsx 已停更、
 * 官方不再发新版）。失效时是响亮失败而不是静默假通过：FileIndex 变形会直接
 * TypeError，<dimension> 匹配不到或回读 !ref 没变窄都会显式 throw。
 *
 * 未来若必须升级 SheetJS：退路是提交一份脱敏的 .real.spec.ts fixture（读真实
 * xlsx 二进制走 parsePurchaseOrderExcel，不做 zip 手术），或手写最小 xlsx zip；
 * 不要把本 helper 的失败当成「可以删掉这个用例」的信号。
 */
function withNarrowedDimension(bytes: ArrayBuffer, errorLabel: string, ref: string): ArrayBuffer {
  const cfb = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' });
  for (const entry of cfb.FileIndex as { name: string; content: Uint8Array; size: number }[]) {
    // 只动 worksheet XML；用明细表头定位目标 sheet，避免硬编码 sheet1/sheet2 的序号假设
    if (!/^sheet\d+\.xml$/.test(entry.name)) continue;
    const xml = new TextDecoder().decode(entry.content);
    if (!xml.includes('可出货数量')) continue;
    const next = xml.replace(/<dimension ref="[^"]*"\s*\/>/, () => `<dimension ref="${ref}"/>`);
    if (next === xml) {
      throw new Error(`「${errorLabel}」sheet XML 里没找到 <dimension>，无法构造窄 !ref`);
    }
    // 原地改：CFB 目录项的 content 与 size 必须同步更新，不能换成新对象
    const encoded = new TextEncoder().encode(next);
    entry.content = encoded;
    entry.size = encoded.length;
  }
  const out = XLSX.CFB.write(cfb, {
    fileType: 'zip',
    type: 'array',
    compression: true,
  }) as Uint8Array;

  const readBack = XLSX.read(toArrayBuffer(out), { type: 'array' });
  if (readBack.Sheets[DETAIL_SHEET]?.['!ref'] !== ref) {
    throw new Error(
      `「${errorLabel}」sheet 的 !ref 仍是 ${readBack.Sheets[DETAIL_SHEET]?.['!ref']}，窄 !ref 构造失败`,
    );
  }
  return toArrayBuffer(out);
}

/** 造一份可喂给 parsePurchaseOrderExcel 的 ArrayBuffer；narrowRef 非空时把 !ref 改窄。 */
function buildPoWorkbookBytes(narrowRef?: string, detailRows?: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildBaseSheet(), BASE_SHEET);
  XLSX.utils.book_append_sheet(wb, buildDetailSheet(detailRows), DETAIL_SHEET);
  const bytes = toArrayBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  return narrowRef ? withNarrowedDimension(bytes, DETAIL_SHEET, narrowRef) : bytes;
}

function itemOf(items: PurchaseOrderExcelItem[], lineNo: string): PurchaseOrderExcelItem {
  const found = items.find((it) => it.lineNo === lineNo);
  if (!found) throw new Error(`没有解析到采购订单行号 ${lineNo} 的明细`);
  return found;
}

describe('parsePurchaseOrderExcel', () => {
  it('读取「基本资料」sheet 的单据编号', () => {
    const result = parsePurchaseOrderExcel(buildPoWorkbookBytes());

    expect(result.docNo).toBe(DOC_NO);
    expect(result.errors).toEqual([]);
  });

  it('!ref 低报范围时，靠外侧列的数据仍被解析出来', () => {
    // 复现坑 A：!ref 只声明到 H 列，可出货数量在 K 列。
    // 若 readSheetRows 退回按 !ref 切，K 列表头 / 数据都会被裁掉，
    // 结果是「缺少可选列」warning + shippableQty 恒 null。
    const result = parsePurchaseOrderExcel(buildPoWorkbookBytes(NARROW_REF));

    expect(result.errors).toEqual([]);
    expect(result.warnings).not.toContain(expect.stringContaining('缺少可选列「可出货数量」'));

    const first = itemOf(result.items, '10');
    expect(first.shippableQty).toBe(30); // K 列
    expect(first.deliveryDate).toBe('2026-08-01'); // G 列
    expect(first.unitPrice).toBe(12.5); // H 列

    // 外侧列不能只对首行生效，第二行同样要拿到
    expect(itemOf(result.items, '20').shippableQty).toBe(7);
  });

  it('!ref 未低报时解析结果与低报时一致', () => {
    // 对照组：同一份数据在 !ref 正常时不会出现「缺少可选列」警告，
    // 说明上一条断言拿到的是 K 列数据本身而不是兜底空值。
    const result = parsePurchaseOrderExcel(buildPoWorkbookBytes());

    expect(result.warnings).not.toContain(expect.stringContaining('缺少可选列'));
    expect(itemOf(result.items, '10').shippableQty).toBe(30);
  });

  it('跳过「计划行」子表头与序号 1 子数据，主明细保留且 rowNo 为 Excel 真实行号', () => {
    // 复现坑 B：Excel 第 6 行是计划行子表头、第 7 行是序号 1 的子数据，
    // 两行都不能进 items；留下的主明细行号必须是 Excel 真实行号（5 / 8 / 10）
    // 而不是数据序号，否则后端 match 的 row_no 对不上、候选挂不回行。
    const result = parsePurchaseOrderExcel(buildPoWorkbookBytes(NARROW_REF));

    expect(result.items.map((it) => it.lineNo)).toEqual(['10', '20', '40']);
    expect(result.items.map((it) => it.rowNo)).toEqual([5, 8, 10]);

    // 子数据行的物料代码不能混进来
    expect(result.items.map((it) => it.drawingNo)).toEqual(['PO-001', 'PO-002', 'PO-004']);
    expect(result.items.every((it) => it.deleted === false)).toBe(true);
  });

  it('跳过已删除的主明细行并给出警告', () => {
    const result = parsePurchaseOrderExcel(buildPoWorkbookBytes(NARROW_REF));

    // 第 9 行（采购订单行号 30，物料代码 PO-003）已删除
    expect(result.items.map((it) => it.drawingNo)).not.toContain('PO-003');
    expect(result.warnings).toContain('第 9 行（采购订单行号 30）已删除，已跳过');
  });

  it('缺少必需 sheet 时报错且不产出明细', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['无采购订单']]), '其他');
    const bytes = toArrayBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

    const result = parsePurchaseOrderExcel(bytes);

    expect(result.items).toEqual([]);
    expect(result.errors).toContain(`Excel 缺少 "${BASE_SHEET}" sheet`);
    expect(result.errors).toContain(`Excel 缺少 "${DETAIL_SHEET}" sheet`);
  });

  it('真实 Excel 日期单元格归一成 YYYY-MM-DD，千分位数字被剥离', () => {
    // 第 5 行：交货日期写成 Date（落盘后带 m/d/yy 数字格式），千分位含税价 / 可出货数量
    // 第 6 行：交货日期是无法识别的「待定」—— MAJOR-1 的根因输入
    // 第 7 行：交货日期留空
    const result = parsePurchaseOrderExcel(
      buildPoWorkbookBytes(undefined, [
        ['10', 'M8', '', 'PO-001', '法兰盘', 5, new Date(2026, 7, 1), '1,234.56', '', '', '1,500'],
        ['20', 'M10', '', 'PO-002', '轴承座', 3, '待定', 88, '', '', 7],
        ['30', 'M12', '', 'PO-003', '垫片', 1, '', 10, '', '', 1],
      ]),
    );
    expect(result.errors).toEqual([]);

    // Date 单元格：raw:false 路径拿到的是格式化文本（m/d/yy），仍要归一成 YYYY-MM-DD
    const dateRow = itemOf(result.items, '10');
    expect(dateRow.rowNo).toBe(5);
    expect(dateRow.deliveryDate).toBe('2026-08-01');

    // 千分位：parseNumberOrNull 剥离 ',' 后转数字
    expect(dateRow.unitPrice).toBe(1234.56);
    expect(dateRow.shippableQty).toBe(1500);

    // 透传分支：无法识别的文本原样保留（解析器不改写，由上层预填守卫兜）
    const pendingRow = itemOf(result.items, '20');
    expect(pendingRow.deliveryDate).toBe('待定');

    // 空单元格 → null
    expect(itemOf(result.items, '30').deliveryDate).toBeNull();
  });
});

describe('parseDateOrNull', () => {
  // parsePurchaseOrderExcel 走 sheet_to_json({ raw: false })，xlsx 在 read 时就会给
  // 日期单元格补 `w`，所以实例分支在主链路里不可达（文本分支已经覆盖了真实
  // Excel 日期）。直接单测这个函数是为了把那层防御性兜底钉住，别被后人删掉。
  it('Date 实例直接格式化成本地日期', () => {
    expect(parseDateOrNull(new Date(2026, 7, 1))).toBe('2026-08-01');
  });

  it('无效的 Date 实例返回 null', () => {
    expect(parseDateOrNull(new Date('不是日期'))).toBeNull();
  });

  it('可识别的日期文本归一，不可识别的原样透传', () => {
    expect(parseDateOrNull('2026-08-01')).toBe('2026-08-01');
    expect(parseDateOrNull('  2026/8/1  ')).toBe('2026-08-01');
    expect(parseDateOrNull('待定')).toBe('待定');
    expect(parseDateOrNull('')).toBeNull();
    expect(parseDateOrNull(null)).toBeNull();
  });
});

describe('resolveExcelDeliveryDate', () => {
  it('Excel 交货日期可识别时预填该值且不产生说明', () => {
    const decision = resolveExcelDeliveryDate(5, '2026-08-01');

    expect(decision.usable).toBe(true);
    expect(decision.warning).toBeNull();
    expect(decision.prefill('2026-07-01')).toBe('2026-08-01'); // 零件现有值被 Excel 值覆盖
    expect(decision.prefill(null)).toBe('2026-08-01');
  });

  it('无法识别时保持零件现有系统交期，不映射成 null，并给出说明', () => {
    // MAJOR-1：null 在后端三态里 = 清空成 NULL，把识别不了的 Excel 日期写成 null
    // 会静默抹掉零件上已有的交期，所以这里必须退回现有值。
    const decision = resolveExcelDeliveryDate(5, '待定');

    expect(decision.usable).toBe(false);
    expect(decision.warning).toBe('第 5 行交货日期「待定」无法识别，已保持零件现有系统交期不变');
    expect(decision.prefill('2026-07-01')).toBe('2026-07-01');
    // 零件本来就没有交期时保持 null（与「清空」不可区分，但语义上是同一个空值）
    expect(decision.prefill(null)).toBeNull();
  });

  it('缺失时给出「未填写」说明并同样退回零件现有值', () => {
    const decision = resolveExcelDeliveryDate(9, null);

    expect(decision.usable).toBe(false);
    expect(decision.warning).toBe('第 9 行未填写交货日期，已保持零件现有系统交期不变');
    expect(decision.prefill('2026-07-01')).toBe('2026-07-01');
  });

  it('端到端：待定行的候选默认值 = 零件现有交期，且 group 追加了说明', () => {
    // 走真实链路 Excel → 解析器 → 预填决策，对齐 buildPreviewGroups 里的取值口径。
    const result = parsePurchaseOrderExcel(
      buildPoWorkbookBytes(undefined, [
        ['10', 'M8', '', 'PO-001', '法兰盘', 5, '待定', 1, '', '', 1],
      ]),
    );
    const row = itemOf(result.items, '10');
    const existingPartDate = '2026-07-01';
    const decision = resolveExcelDeliveryDate(row.rowNo, row.deliveryDate);
    const groupWarnings = decision.warning ? [decision.warning] : [];

    expect(row.rowNo).toBe(5);
    expect(row.deliveryDate).toBe('待定'); // 根因：解析器透传
    expect(groupWarnings).toEqual(['第 5 行交货日期「待定」无法识别，已保持零件现有系统交期不变']);
    expect(decision.prefill(existingPartDate)).toBe(existingPartDate); // 关键：不是 null
  });
});
