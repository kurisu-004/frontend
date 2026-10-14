// @vitest-environment happy-dom
// src/views/com/delivery/utils/__tests__/deliveryNoteWorkbook.spec.ts
//
// 2026-10-08 新增：hucre 渲染链路的**实测**守卫。
//
// 本文件同时钉死三条实测结论（详见 utils/deliveryNoteWorkbook.ts 文件头）：
//   1. `fillTemplate` **支持合并单元格内的占位符** —— 模板的 F15 在合并区 `F15:J16`、
//      A17 在合并区 `A17:J17`，两个锚点都取到实参（见「页脚占位符在合并单元格内也被替换」
//      一条）。若将来换 hucre 版本导致这条退化为「不支持」，本用例会红，届时的修法是
//      规格里给的整串写入退化路径。
//   2. **round-trip 保住 merges / 列宽 / 打印设置**：8 处 merges 在渲染前后原样保留；用
//      writeXlsx 重建会全部丢掉。
//   3. **样式必须靠 `readStyles: true` 才进模型**（hucre 的 ReadOptions 默认 false）。
//      下面的「样式」两条用例是**字节级**断言：直接解 zip 数 `<c s=`，不是读回 hucre
//      模型（模型里样式是解析后的对象，styles.xml 被换成空壳它也能"看起来有样式"）。
//
// 覆盖：数据行写入 / 未填满的行整行清空（不漏出 {{order_no}} 字面量）/ 多 sheet /
// 数量 null 写空 / 每 sheet 行数 / 占位符零残留 / 单元格样式与空行边框字节级保真。
//
// 2026-10-16 新增检具版一批：6 列落位 / G·H 手写列清空 / I2 拿送货日期 / 25 行满载
// 拆 sheet / 零残留 / merges 保真 / 字节级样式计数，以及两条守卫 ——「数据列必须被整块清空
// 范围覆盖」（越界即抛错，不静默留残值）与「契约与页脚必须配套」（**主要在编译期**，
// 运行时断言只作兜底）。
//
// 2026-10-18：检具版 C 列也落位（键名 `customer_path`，与零件版 C 列同落一个
// `PrintSheetRow.l2Customer`），手写列只剩 G / H；新增一条「同一组行数据在两套契约下 C 列
// 都拿到同一个客户路径值」。
//
// 2026-10-18 另补检具模板的**保真项守卫**三条（此前「只改 C5 一格、版式原样」这条承诺零断言）：
// 数据区最后一行的 A..I 清空后仍带 `s=` / 打印区列宽与打印设置逐项等于写死快照 / C5 的实参
// 写穿 `cells` 侧表（带样式模板上漏出 `{{...}}` 字面量的那条成因）。
//
// ⚠️ 2026-10-18 换模板基准（百路达那份改成客户手工维护的版本）后，两条守卫的**锚点**跟着换，
// 性质不变：
//   · 「清空不得越界到数据区之后」改成**自带哨兵**（GAUGE_TAIL_SENTINELS，哨兵由用例写进
//     内存副本）—— 原先拿模板尾部那行说明文案当锚点，而客户维护的模板不保证有它。
//   · 「带 `s=` 的格数」从「与模板原件**同值**」放宽成「**不少于**模板原件」+ 一条位置级的
//     正向断言 —— hucre round-trip 只增不减，增量由模板里数据区之外的列宽 / 行定义决定，
//     绑死相等会让任何一份非本仓生成的模板假红。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { renderDeliveryNoteWorkbook } from '../deliveryNoteWorkbook';
import type { GaugeFooterSpec, PartFooterSpec } from '../deliveryNoteWorkbook';
import {
  DELIVERY_NOTE_TEMPLATE_CONTRACT,
  GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT,
} from '../deliveryNoteTemplateContract';
import { colIndexOf } from '../deliveryNoteTemplate';

// ⚠️ 必须从 Buffer 构造 Uint8Array（不能用 `buf.buffer`：node 的 Buffer 可能落在
// 8MB 池化 ArrayBuffer 的一段上，`.buffer` 拿到的是**整个池**，字节不是 xlsx）。
const TEMPLATE = new Uint8Array(readFileSync('templates/delivery_note_fala.xlsx'));
/** 内置检具模板**两份**（百路达 / 杏南）。两份的一致项 / 不一致项以契约文件头那份清单
 *  为准（deliveryNoteTemplateContract.ts），这里不复述一份；逐格校验另有同款一条在
 *  deliveryNoteTemplate.spec.ts。 */
const GAUGE_TEMPLATE_FILES = [
  'templates/delivery_note_gauge_bailuda.xlsx',
  'templates/delivery_note_gauge_xingnan.xlsx',
] as const;
/** 默认取百路达（其余用例用它当输入）；「两份都验」的用例走 `GAUGE_TEMPLATE_FILES`。 */
const GAUGE_TEMPLATE = new Uint8Array(readFileSync(GAUGE_TEMPLATE_FILES[0]));

/** 模板原件里带样式索引（`s=`）的 cell 数 —— 渲染产物必须一条不少地对上（2026-10-08 实测）。 */
const TEMPLATE_STYLED_CELLS = 172;

/** 两份检具模板的打印设置实测值（A4 横向 + 定制页边距）。两份逐项相同 ⇒ 只有这一份。 */
const GAUGE_PAGE_SETUP = {
  paperSize: 'a4',
  orientation: 'landscape',
  horizontalDpi: 600,
  verticalDpi: 300,
  margins: {
    left: 0.271527777777778,
    right: 0.271527777777778,
    top: 0,
    bottom: 0,
    header: 0.118055555555556,
    footer: 0.161111111111111,
  },
} as const;

/**
 * 两份检具模板的版式快照（2026-10-18 实测写死）：打印区列宽 + 打印设置。
 *
 * 与上面那条「带 `s=` 的 cell 数」用例不同，那条是**自指比较**（产物 vs 模板原件）⇒
 * 模板侧变了它跟着一起变、抓不到。这里改成把定值写死：模板列宽 / 打印设置被换掉（或 hucre
 * 升版后 round-trip 丢掉它们）时当场红。
 *
 * 断言落在**渲染产物**上（不是模板原件）：这两项的承诺本来就是「渲染不改版式」，钉产物
 * 一次把「模板的值」与「round-trip 保住」两半都盖住。
 *
 * 列宽只钉打印区 A..I（契约 `dataColumns` 的范围）—— 其后 hucre 补齐到 16384 列的默认
 * 宽度与排版无关。两份模板的列宽**彼此不同**（与契约文件头「不一致」清单一致）⇒ 各存一份。
 */
const GAUGE_LAYOUT_SNAPSHOT = {
  'templates/delivery_note_gauge_bailuda.xlsx': {
    columnWidths: [6, 22, 34.25, 16, 18.375, 5.125, 12.375, 14.875, 16.25],
    pageSetup: GAUGE_PAGE_SETUP,
  },
  'templates/delivery_note_gauge_xingnan.xlsx': {
    columnWidths: [7.25, 24.5, 28.75, 16, 18.625, 6.125, 13.25, 15.375, 15.25],
    pageSetup: GAUGE_PAGE_SETUP,
  },
} as const;

// ============================================================
// 最小 zip 读取器（仅本文件用；纯内存，不落临时文件）
// ============================================================
//
// ⚠️ **不 import fflate**：hucre 是 **zero-dependency**（它 package.json 里没有
// dependencies），`fflate@0.6.11` 是本仓 devDependencies 中 `@types/three@^0.160.0`
// 的 **dev-only** 传递依赖（`package-lock.json` 里带 `"dev": true`）—— dev-only ⇒
// 生产安装根本没有它，也没有理由把它提为运行时依赖。另外 fflate 的 package.json
// `exports` 没写 `types` 条件 —— 本仓 `moduleResolution: "Bundler"` 下
// `import { unzipSync } from 'fflate'` 直接 TS7016（实测），深路径
// `fflate/lib/node.cjs` 也没被 exports 放行。所以这里用 `node:zlib` 手写最小读取：
// EOCD → 中央目录 → 本地头算数据偏移 → inflateRawSync。
//
// 适用前提（xlsx 都是小文件，不触发）：无 zip64（条目数 < 65535、单条目 < 4 GB）、
// 不用压缩方法 8 以外的加密条目。

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

/** xlsx 字节 → `part 路径 → 内容`（全量解包；模板与产物都只有十几个条目）。 */
function unzipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // EOCD 在文件尾，前面最多跟 65535 字节的注释。
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到 EOCD 记录');

  const total = dv.getUint16(eocd + 10, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < total; k += 1) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('中央目录项签名不对');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // 本地头的 extra 长度与中央目录那份**可以不同**，数据偏移必须按本地头重算。
    const dataStart =
      localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function partOf(bytes: Uint8Array, path: string): string {
  const entry = unzipEntries(bytes).get(path);
  if (!entry) throw new Error(`xlsx 里没有 ${path}`);
  return new TextDecoder().decode(entry);
}

/** sheet XML 里带样式索引的 `<c ... s="n">` 个数。 */
function styledCellCount(sheetXml: string): number {
  return (sheetXml.match(/<c [^>]*\ss="[^"]*"/g) ?? []).length;
}

/** sheet XML 里某个 Excel 行号（`<row r="12">`）的整段 XML。 */
function rowXml(sheetXml: string, excelRow: number): string {
  const hit = sheetXml.match(new RegExp(`<row r="${excelRow}"[^>]*>[\\s\\S]*?</row>`));
  if (!hit) throw new Error(`sheet XML 里没有第 ${excelRow} 行`);
  return hit[0];
}

/** 列字母区间（'A'..'I' → 9 个字母）。⚠️ **不能**用 `Object.values(contract.columns)` 代替：
 *  检具版 G / H 两列是留给送货厂家手写的、刻意不在 `columns` 里，而数据区清空与边框保真
 *  的范围是 `dataColumns`（A..I）。 */
function columnLetters(first: string, last: string): string[] {
  const out: string[] = [];
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    out.push(String.fromCharCode(code));
  }
  return out;
}

/** 故意造一个畸形页脚实参（绕过类型去够运行时守卫）。
 *  断言落在**形参**上而不是对象字面量上 —— lint 的 `consistent-type-assertions` 禁的是后者。 */
function malformed<T>(value: unknown): T {
  return value as T;
}

/** 合并区列表 → A1 记法数组，**按字典序排序**（写死数字前先看清模板里到底有什么，
 *  别靠注释里的清单）。
 *
 *  ⚠️ 排序是必需的：hucre 按 XML 文档序保存 / 回写 `merges`（不排序），客户用 Excel 重存一次
 *  就可能把 `<mergeCell>` 的顺序改掉 —— 集合没变、顺序变了时按序比会假红。所以两侧都走本函数
 *  取值，比较的是**集合**而不是顺序。`merges` 在 hucre 的 Sheet 上是可选的，缺省按「没有合并区」
 *  的空清单算。 */
function mergeList(
  merges: { startRow: number; startCol: number; endRow: number; endCol: number }[] | undefined,
): string[] {
  const cell = (row0: number, col0: number) => `${String.fromCharCode(65 + col0)}${row0 + 1}`;
  return (merges ?? []).map((m) =>
    m.startRow === m.endRow && m.startCol === m.endCol
      ? cell(m.startRow, m.startCol)
      : `${cell(m.startRow, m.startCol)}:${cell(m.endRow, m.endCol)}`,
  ).sort();
}

function row(i: number) {
  return {
    orderNo: `SO-${i}`,
    l2Customer: '法拉',
    applicant: '张三',
    drawingNo: `C-100${i}`,
    name: '铝电解电容',
    quantity: i + 1,
    unit: '件',
    etd: '11月1日',
    note: '',
  };
}

/** 客户列给一条**多级路径**（2026-10-18 客户无限层级后的真实取值形态：
 *  「第 2 层到叶子的 ` / ` 拼接、不含 L1」），用它断言 C 列拿到的是路径而不是单段名。 */
function rowWithPath(i: number) {
  return { ...row(i), l2Customer: '终端BG / 手机部 / 影像组' };
}

/**
 * 检具版「整块清空不得越界」守卫的**自带哨兵**（0-based 行列号，位置全在数据区之外）。
 *
 * 为什么不用模板自己的内容当锚点：数据区之后那两行是**客户版式自带的说明区**，它有没有内容、
 * 写的是什么，随客户手工维护模板而变（百路达那份当前就是空的）。拿模板原文当锚点时，模板
 * 一改这条守卫就退化成「两个空数组比较、永远绿」。哨兵由用例自己写进内存副本
 * （openXlsx → 改值 → saveXlsx），守卫因此与模板内容彻底解耦。
 *
 * 位置刻意贴着清空范围的**后一行**而不是随便挑一行：清空范围只要多写一行，第一个哨兵
 * 当场被清掉（少写几行则由整块尾部快照比对抓住）。
 */
const GAUGE_DATA_END_ROW =
  GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow +
  GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT.dataRowCount;
const GAUGE_TAIL_SENTINELS = [
  { row: GAUGE_DATA_END_ROW, col: 1, text: '哨兵-清空边界后第一行' },
  { row: GAUGE_DATA_END_ROW + 1, col: 0, text: '哨兵-清空边界后第二行' },
] as const;

/** 检具版页脚实参：判别位 `kind` **必填**（契约与页脚在编译期绑定，见 FooterFor），
 *  且检具版只消费 `deliveryDate` —— 不再带零件版那四个永不消费的字段。 */
const GAUGE_FOOTER = { kind: 'gauge' as const, deliveryDate: '2026-10-16' };

/** 零件版页脚实参。判别位 `kind` 可省略（缺省按 'part' 记）：既有三参调用就是这个形态。 */
const PART_FOOTER = { driverName: '李四', year: '2026', month: '10', date: '08' };

async function readBack(bytes: Uint8Array) {
  const { readXlsx } = await import('hucre');
  return readXlsx(bytes);
}

/** 数据行条数（A 列非空计数；模板的数据行 A 列是 {{no}}，渲染后是序号）。 */
function dataRowCount(sheet: { rows: unknown[][] }): number {
  return countDataRows(sheet, DELIVERY_NOTE_TEMPLATE_CONTRACT);
}

/** 同上，契约可传（检具版区间是 row 5..29、容量 25）。序号列两套版式都在 A 列。 */
function countDataRows(
  sheet: { rows: unknown[][] },
  c: { dataStartRow: number; dataRowCount: number },
): number {
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
    // I 列「预估交期」：`PrintSheetRow.etd` 由 toSheetRows 预格式化（口径见那边），
    // 渲染层原样落格 —— 这里只锁「原样写、不二次加工」。
    expect(s.rows[2]![8]).toBe('11月1日');
    expect(s.rows[2]![7]).toBe('件');
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
    // 克隆出来的 sheet 同样带样式（真实打印单子常有 5 张 sheet，样式丢在 clone 上一样是事故）
    expect(styledCellCount(partOf(out, 'xl/worksheets/sheet2.xml'))).toBe(TEMPLATE_STYLED_CELLS);
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

  it('零残留占位符（模板里 23 处 / 14 类 placeholder 全被替换或清空）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [row(0)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const s = (await readBack(out)).sheets[0]!;
    const leftover = s.rows.flat().filter((v) => typeof v === 'string' && v.includes('{{'));
    expect(leftover).toEqual([]);
  });

  // ---- 样式字节级回归锁（2026-10-08）----
  //
  // `readStyles` 是 `openXlsx` 的入参，一旦被「优化」掉，下面两条立刻转红：产物
  // styles.xml 缩回 829 B 空壳（1 个宋体、0 边框），`<c>` 上的 `s=` 全部消失。
  it('渲染后模板的单元格样式仍在（字节级：sheet1.xml 里 172 个 cell 仍全带 s=）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [row(0), row(1)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    expect(styledCellCount(partOf(out, 'xl/worksheets/sheet1.xml'))).toBe(TEMPLATE_STYLED_CELLS);
  });

  it('styles.xml 不是被重生成的空壳（有真实的 border / font 记录）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [row(0)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const styles = partOf(out, 'xl/styles.xml');
    // 空壳形态是 `<borders count="1">` + `<cellXfs count="1">`；模板实测 10 borders /
    // 27 cellXfs。断言 borders 记录数 > 1 即可判别，绑死具体数字会让 hucre 升版假红。
    expect(Number(styles.match(/<borders count="(\d+)"/)?.[1] ?? 0)).toBeGreaterThan(1);
    expect(Number(styles.match(/<fonts count="(\d+)"/)?.[1] ?? 0)).toBeGreaterThan(1);
  });

  it('零件版 C 列仍取 l2_customer 键的值（键名被老模板的 {{l2_customer}} 占位符钉死）', async () => {
    // 守卫的是「检具版给 C 列新增 `customer_path` 键之后，零件版那条路一个字没动」：
    // 列位声明 + 渲染产物两半都在这里。未填满的数据行 C 列必须为空（清空范围含 C）。
    expect(DELIVERY_NOTE_TEMPLATE_CONTRACT.columns.l2_customer).toBe('C');
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [rowWithPath(0)] }],
      PART_FOOTER,
    );
    const s = (await readBack(out)).sheets[0]!;
    const start = DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow;
    expect(s.rows[start]![2]).toBe('终端BG / 手机部 / 影像组');
    expect(String(s.rows[start + 1]![2] ?? '')).toBe('');
  });

  it('数据区整块清空覆盖到最后一列 J（往 J4 塞客户残留 ⇒ 渲染后必须为空）', async () => {
    // 「清空按 dataColumns 走、写入按 columns 走」是本层的核心前提：把 `dataColumns` 写窄成
    // A..I，未填满的行 J 列就会漏出模板原值。本条把该列钉死（渲染层另有一条守卫会在越界时
    // 直接抛错，两条配对：写窄了要么看到残留值、要么当场抛错，不会静默通过）。
    const { openXlsx, saveXlsx } = await import('hucre');
    const wb = await openXlsx(TEMPLATE);
    // 0-based row 3 = Excel 第 4 行（第一个未填满的数据行）、col 9 = J 列（备注）。
    wb.sheets[0]!.rows[3]![9] = '客户残留';
    const dirty = await saveXlsx(wb);

    const out = await renderDeliveryNoteWorkbook(
      dirty,
      [{ sheetName: 'S', rows: [row(0)] }],
      PART_FOOTER,
    );
    const s = (await readBack(out)).sheets[0]!;
    expect(String(s.rows[3]![9] ?? '')).toBe('');
  });

  it('空数据行仍保留边框（整块清空只清值、不踩样式）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows: [row(0)] }],
      { driverName: '李四', year: '2026', month: '10', date: '08' },
    );
    const sheetXml = partOf(out, 'xl/worksheets/sheet1.xml');
    const c = DELIVERY_NOTE_TEMPLATE_CONTRACT;
    // 数据区最后一行（0-based row 11 = Excel row 12）被整行清空成 10 个空值，
    // 但这 10 个格仍必须带 s= —— 清空的是**值**，样式挂在 cells 侧表上。
    const lastExcelRow = c.dataStartRow + c.dataRowCount;
    const cleared = rowXml(sheetXml, lastExcelRow);
    for (const letter of Object.values(c.columns)) {
      const cell = cleared.match(new RegExp(`<c r="${letter}${lastExcelRow}"[^>]*>`))?.[0];
      expect(cell, `列 ${letter} 在清空行里没写出来`).toBeDefined();
      expect(cell, `列 ${letter} 的样式索引丢了`).toMatch(/\ss="\d+"/);
    }
    // 全表一条不少：清空不该让任何一格掉出 cell 列表。
    expect(styledCellCount(sheetXml)).toBe(TEMPLATE_STYLED_CELLS);
  });
});

// ============================================================
// 检具版（2026-10-16 新增）
// ============================================================
describe('renderDeliveryNoteWorkbook（检具版）', () => {
  const G = GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT;

  it('7 列按 PrintSheetRow 落位、C 列拿到客户路径、G/H 两列留白、I2 拿到送货日期', async () => {
    const out = await renderDeliveryNoteWorkbook(
      GAUGE_TEMPLATE,
      [{ sheetName: '百路达', rows: [rowWithPath(0), rowWithPath(1)] }],
      GAUGE_FOOTER,
      G,
    );
    const s = (await readBack(out)).sheets[0]!;
    // row 5（0-based 4）：A 序号 / B 订单号 / C 客户路径 / D 图号 / E 名称 / F 数量 /
    // G·H 手写列（留白）/ I 交货日期
    expect(s.rows[4]).toEqual([
      1, 'SO-0', '终端BG / 手机部 / 影像组', 'C-1000', '铝电解电容', 1, '', '', '11月1日',
    ]);
    // row 6 同形，序号续排（清空后逐格覆写，不会漏出模板里 row5 才有的占位符）
    expect(s.rows[5]).toEqual([
      2, 'SO-1', '终端BG / 手机部 / 影像组', 'C-1001', '铝电解电容', 2, '', '', '11月1日',
    ]);
    // 第 7..29 行未填 ⇒ 整行清空（含 A 列序号占位符、C 列的客户路径占位符）
    expect(s.rows[6]!.every((v) => String(v ?? '') === '')).toBe(true);
    // 送货日期在 I2（表头右侧），不是页脚区
    expect(s.rows[1]![8]).toBe('2026-10-16');
    // H2 的标签是模板原文，不被动过
    expect(s.rows[1]![7]).toBe('送货日期');
  });

  it('quantity / etd 为 null ⇒ 写空而不是 0 或 "null"', async () => {
    const out = await renderDeliveryNoteWorkbook(
      GAUGE_TEMPLATE,
      [{ sheetName: 'S', rows: [{ ...row(0), quantity: null, etd: null }] }],
      GAUGE_FOOTER,
      G,
    );
    const s = (await readBack(out)).sheets[0]!;
    expect(String(s.rows[4]![5] ?? '')).toBe('');
    expect(String(s.rows[4]![8] ?? '')).toBe('');
  });

  it('模板样例残留值不会被打出去（G / H 两列按客户约定清空、边框留着手写）', async () => {
    // 造一份「客户样例残留」的模板：数据区 G / H 两列塞上样例值，C 列也塞一条（验证 C 列
    // **被实参覆盖**而不是靠清空躲过去 —— 清空在前、写入在后，顺序反了就会漏出样例）。
    const { openXlsx, saveXlsx } = await import('hucre');
    const wb = await openXlsx(GAUGE_TEMPLATE);
    const sh = wb.sheets[0]!;
    sh.rows[4]![2] = '样例：采购部/张三';
    sh.rows[4]![6] = '新制';
    sh.rows[7]![7] = 'OK';
    sh.rows[8]![6] = '返修';
    sh.rows[8]![7] = 'NG';
    // 数据区**之外**再塞两个哨兵（见 GAUGE_TAIL_SENTINELS）：它们是这条「清空不越界」守卫
    // 的锚点，由用例自己写进去 ⇒ 守卫与模板尾部有没有那几行说明文案无关。
    // ⚠️ 本例的 `openXlsx` **不开** readStyles：那一路的 `rows` 是稠密矩形，只到「最后一行有
    // 值」的位置为止（模板尾部是空的 ⇒ 行数组根本不存在），所以要先补出那一行再写哨兵。
    for (const sent of GAUGE_TAIL_SENTINELS) {
      const line = (sh.rows[sent.row] ??= []);
      line[sent.col] = sent.text;
    }
    const dirty = await saveXlsx(wb);

    const out = await renderDeliveryNoteWorkbook(
      dirty,
      [{ sheetName: 'S', rows: [rowWithPath(0)] }],
      GAUGE_FOOTER,
      G,
    );
    const s = (await readBack(out)).sheets[0]!;
    // C 列：填了实参的那一行是路径，其余 24 行是空（样例残留不得漏出）
    expect(s.rows[G.dataStartRow]![2]).toBe('终端BG / 手机部 / 影像组');
    for (let k = 1; k < G.dataRowCount; k += 1) {
      expect(String(s.rows[G.dataStartRow + k]![2] ?? ''), `第 ${k + 1} 行 C 列`).toBe('');
    }
    // G / H 两列整列扫一遍：25 行数据区里全部空
    for (const colIdx of [6, 7]) {
      for (let k = 0; k < G.dataRowCount; k += 1) {
        expect(String(s.rows[G.dataStartRow + k]![colIdx] ?? ''), `第 ${k + 1} 行第 ${colIdx} 列`).toBe(
          '',
        );
      }
    }
    // 清空范围不得越界到数据区之后：**渲染前后的尾部整行快照必须逐格相同** —— 只钉一格的话，
    // 清空行数多写 / 少写几行都测不出来。快照锚在**用例自带的哨兵**上而不是模板的说明文案
    // 上：客户手工维护模板时增删说明区不算版式变更，拿模板原文当锚点会让这条空转。
    const tailOf = (sheet: { rows: unknown[][] }) =>
      sheet.rows.slice(GAUGE_DATA_END_ROW).map((r) => [...r]);
    const tailBefore = tailOf((await readBack(dirty)).sheets[0]!);
    const tailAfter = tailOf(s);
    expect(tailAfter).toEqual(tailBefore);
    // 两个哨兵逐字未变（第一个正好贴在清空范围的边界行上：清空多写一行就会被清掉）
    for (const sent of GAUGE_TAIL_SENTINELS) {
      expect(
        String(tailAfter[sent.row - GAUGE_DATA_END_ROW]![sent.col] ?? ''),
        `数据区之后第 ${sent.row - GAUGE_DATA_END_ROW + 1} 行第 ${sent.col + 1} 列的哨兵被越界清空了`,
      ).toBe(sent.text);
    }
  });

  it('26 条按检具容量切成两组 ⇒ 第一张填满 25 行、第二张承接第 26 条', async () => {
    // 切分这一步在本文件里按检具容量（25）显式做，不走 `groupIntoSheets`：那个函数的
    // `capacity` 形参**默认取零件版契约的 `dataRowCount`（10）**，检具版要 25 条一页就得由
    // 调用方显式给（该形参在 deliveryNotePrintRows 的 spec 里有 25 → [25, 1] 的专条钉住）。
    // 本条守的是渲染层：满载 25 行不丢第 26 条、换 sheet 后序号从 1 重排。
    const specs = [
      { sheetName: '百路达-1', rows: Array.from({ length: 25 }, (_, i) => row(i)) },
      { sheetName: '百路达-2', rows: [row(25)] },
    ];
    expect(G.dataRowCount).toBe(25);

    const out = await renderDeliveryNoteWorkbook(GAUGE_TEMPLATE, specs, GAUGE_FOOTER, G);
    const wb = await readBack(out);
    expect(wb.sheets.map((s) => s.name)).toEqual(['百路达-1', '百路达-2']);
    expect(wb.sheets.map((s) => countDataRows(s, G))).toEqual([25, 1]);
    // 首行取实参、第一张最后一行是第 25 条（0-based row 28）
    expect(wb.sheets[0]!.rows[4]![1]).toBe('SO-0');
    expect(wb.sheets[0]!.rows[28]![1]).toBe('SO-24');
    expect(wb.sheets[0]!.rows[28]![0]).toBe(25);
    // 第 26 条落在第二张的第 1 个数据行，序号从头排
    expect(wb.sheets[1]!.rows[4]).toEqual([
      1, 'SO-25', '法拉', 'C-10025', '铝电解电容', 26, '', '', '11月1日',
    ]);
  });

  it('零残留占位符（每个 sheet 都扫：8 类 placeholder 共 32 处全被替换或清空）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      GAUGE_TEMPLATE,
      [
        { sheetName: 'A', rows: [row(0)] },
        { sheetName: 'B', rows: [row(1)] },
      ],
      GAUGE_FOOTER,
      G,
    );
    for (const s of (await readBack(out)).sheets) {
      expect(s.rows.flat().filter((v) => typeof v === 'string' && v.includes('{{'))).toEqual([]);
    }
  });

  // C 列在两套版式下**键名不同、落点相同、值相同**：零件版走 `l2_customer`、检具版走
  // `customer_path`，两者都映射到 `PrintSheetRow.l2Customer`。这条把三件事一次钉住 ——
  // 契约的列位声明、COLUMN_FIELD 的映射、以及渲染产物里那一格的实际文本。
  it('同一组行数据：零件版与检具版的 C 列都拿到同一个客户路径值（键名不同）', async () => {
    // 列位声明本身：两个键都在 C 列
    expect(DELIVERY_NOTE_TEMPLATE_CONTRACT.columns.l2_customer).toBe('C');
    expect(G.columns.customer_path).toBe('C');

    const rows = [rowWithPath(0)];
    const partOut = await renderDeliveryNoteWorkbook(
      TEMPLATE,
      [{ sheetName: 'S', rows }],
      PART_FOOTER,
    );
    const gaugeOut = await renderDeliveryNoteWorkbook(
      GAUGE_TEMPLATE,
      [{ sheetName: 'S', rows }],
      GAUGE_FOOTER,
      G,
    );
    const partSheet = (await readBack(partOut)).sheets[0]!;
    const gaugeSheet = (await readBack(gaugeOut)).sheets[0]!;
    // 数据首行位置不同（row 3 vs row 5），列位置相同（都是 col 2 = C）
    expect(partSheet.rows[DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow]![2]).toBe(
      '终端BG / 手机部 / 影像组',
    );
    expect(gaugeSheet.rows[G.dataStartRow]![2]).toBe('终端BG / 手机部 / 影像组');
    // 未填满的数据行：两套版式的 C 列都必须是空（零件版第二行 C / 检具版第二行 C）
    expect(String(partSheet.rows[DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow + 1]![2] ?? '')).toBe('');
    expect(String(gaugeSheet.rows[G.dataStartRow + 1]![2] ?? '')).toBe('');
  });

  // 下面两条分别守两件事：**清单**（哪几格合并）与 **round-trip 不丢**（渲染前后不变）。
  // 契约文件头那份「9 处合并」清单写在注释里没人验，两份模板任一份改了合并区而注释没跟上，
  // 读代码的人就被带偏 —— 所以把清单做成断言（两份模板都跑），注释与断言同源于此。
  it.each(GAUGE_TEMPLATE_FILES)('两份内置检具模板的合并区清单一致：%s', async (file) => {
    const { openXlsx } = await import('hucre');
    const tpl = await openXlsx(new Uint8Array(readFileSync(file)));
    // 实测清单（已按字典序排好，与 mergeList 的输出口径一致）：A1:I1 是标题；A..F 与 I 这
    // 七列是「两行表头」纵向合并；G3:H3 是「检具状态」横向合并（只占 row 3 一行）。
    expect(mergeList(tpl.sheets[0]!.merges)).toEqual([
      'A1:I1',
      'A3:A4',
      'B3:B4',
      'C3:C4',
      'D3:D4',
      'E3:E4',
      'F3:F4',
      'G3:H3',
      'I3:I4',
    ]);
  });

  it.each(GAUGE_TEMPLATE_FILES)(
    'round-trip 保留 merges 且清单逐条不变（两份都验；writeXlsx 重建会全丢）：%s',
    async (file) => {
      const { openXlsx } = await import('hucre');
      const template = new Uint8Array(readFileSync(file));
      const tpl = await openXlsx(template);
      const out = await renderDeliveryNoteWorkbook(
        template,
        [{ sheetName: 'S', rows: [] }],
        GAUGE_FOOTER,
        G,
      );
      expect(mergeList((await readBack(out)).sheets[0]!.merges)).toEqual(
        mergeList(tpl.sheets[0]!.merges),
      );
    },
  );

  it('数据列越出整块清空范围 ⇒ 抛中文错误（守卫在写数据行之前：工作簿已打开、一格未改）', async () => {
    // 把清空范围写窄成 A..H：I 列（系统交期）不再被清空 ⇒ 未填满的行会漏出模板原值。
    // 「清空按 dataColumns 走、写入按 columns 走」两者互不参照，所以必须有人验这条。
    // ⚠️ 契约常量是 `as const`，类型是**单例字面量**（`last: 'I'`），故意造错的变体表达不出来
    // ⇒ 这里断一次类型。这是「故意违约」的用例，与生产路径的契约无关。
    const narrow = { ...G, dataColumns: { first: 'A', last: 'H' } } as unknown as typeof G;
    await expect(
      renderDeliveryNoteWorkbook(
        GAUGE_TEMPLATE,
        [{ sheetName: 'S', rows: [row(0)] }],
        GAUGE_FOOTER,
        narrow,
      ),
    ).rejects.toThrow(/整块清空范围 A\.\.H/);
    // 错误文案带上越界列的单元格记法（数据区首行那一格），便于对着模板找
    await expect(
      renderDeliveryNoteWorkbook(
        GAUGE_TEMPLATE,
        [{ sheetName: 'S', rows: [row(0)] }],
        GAUGE_FOOTER,
        narrow,
      ),
    ).rejects.toThrow(/I5/);
  });

  it('渲染后模板的单元格样式仍在（字节级：产物带 s= 的格数不少于模板原件）', async () => {
    const out = await renderDeliveryNoteWorkbook(
      GAUGE_TEMPLATE,
      [{ sheetName: 'S', rows: [row(0), row(1)] }],
      GAUGE_FOOTER,
      G,
    );
    // 判据是「**不少**」而不是「恰好相等」：hucre round-trip **只增不减** —— 模板里数据区
    // **之外**的行 / 列（显式列宽定义、尾部那几行）经 round-trip 会被补出模板侧表里没有的空格，
    // 增量完全由模板自身决定（百路达那份实测 274 → 372）。绑「恰好相等」的话，任何一份不是
    // 本仓生成的模板（客户用 Excel / WPS 手工另存过）都会红，而模板本身并没有坏。
    // `readStyles` 被「优化」掉时两边一起塌成 0 ⇒ 先用 `toBeGreaterThan(0)` 钉住模板侧确实
    // 有样式，否则「0 ≤ 0」让这条守卫永远绿。
    const templateStyled = styledCellCount(partOf(GAUGE_TEMPLATE, 'xl/worksheets/sheet1.xml'));
    expect(templateStyled).toBeGreaterThan(0);
    const outXml = partOf(out, 'xl/worksheets/sheet1.xml');
    expect(styledCellCount(outXml)).toBeGreaterThanOrEqual(templateStyled);
    // 与「不少」配对的正向断言：数据区最后一行的 A..I 九格被整块清空后仍带 s=（清的是**值**、
    // 不是边框）。上面那条是自指比较、只管总量，这条把承诺落到**具体位置**上；同一性质在
    // 下面保真项的 each 用例里对两份模板各跑一遍（那边是逐模板钉的版本）。
    const lastExcelRow = G.dataStartRow + G.dataRowCount;
    const cleared = rowXml(outXml, lastExcelRow);
    for (const letter of columnLetters(G.dataColumns.first, G.dataColumns.last)) {
      const cell = cleared.match(new RegExp(`<c r="${letter}${lastExcelRow}"[^>]*>`))?.[0];
      expect(cell, `列 ${letter} 在清空行里没写出来`).toBeDefined();
      expect(cell, `列 ${letter} 的样式索引丢了`).toMatch(/\ss="\d+"/);
    }
  });

  // ---- 检具模板的保真项（2026-10-18：此前这三条承诺零断言）----
  //
  // 承诺是「只改 C5 一格、列宽 / 行高 / 打印设置 / 样式原样」。三条各守一半：下面 ① 守边框
  // （样式）、② 守列宽与打印设置、③ 守 C5 那一格写穿 cells 侧表；行高由 rowDefs 承载，
  // 与列宽同属 `openXlsx → saveXlsx` 的 round-trip 模型，见 ② 的注释。
  it.each(GAUGE_TEMPLATE_FILES)(
    '数据区最后一行的 A..I 九格被整块清空后仍带 s=（清的是值、不是边框）：%s',
    async (file) => {
      const out = await renderDeliveryNoteWorkbook(
        new Uint8Array(readFileSync(file)),
        [{ sheetName: 'S', rows: [row(0)] }],
        GAUGE_FOOTER,
        G,
      );
      const sheetXml = partOf(out, 'xl/worksheets/sheet1.xml');
      // 数据区最后一行（Excel 行号 = dataStartRow + dataRowCount）：只填了 1 条数据，其余 24
      // 行整块清空过。这 9 格的**值**是空的，**样式索引**必须还在 —— 样式挂在 cells 侧表上，
      // setCell 只改 value。少一格 s= 就是打印时边框缺一段。
      const lastExcelRow = G.dataStartRow + G.dataRowCount;
      const cleared = rowXml(sheetXml, lastExcelRow);
      for (const letter of columnLetters(G.dataColumns.first, G.dataColumns.last)) {
        const cell = cleared.match(new RegExp(`<c r="${letter}${lastExcelRow}"[^>]*>`))?.[0];
        expect(cell, `列 ${letter} 在清空行里没写出来`).toBeDefined();
        expect(cell, `列 ${letter} 的样式索引丢了`).toMatch(/\ss="\d+"/);
      }
    },
  );

  it.each(GAUGE_TEMPLATE_FILES)(
    '渲染不改版式：打印区列宽与打印设置逐项等于写死的模板快照：%s',
    async (file) => {
      const snapshot = GAUGE_LAYOUT_SNAPSHOT[file];
      const out = await renderDeliveryNoteWorkbook(
        new Uint8Array(readFileSync(file)),
        [{ sheetName: 'S', rows: [row(0)] }],
        GAUGE_FOOTER,
        G,
      );
      const sheet = (await readBack(out)).sheets[0]!;
      // 列宽只取打印区 A..I（契约 dataColumns 的范围）；其后 hucre 补齐到 16384 列的默认
      // 宽度与排版无关，不逐条钉。
      const widths = (sheet.columns ?? [])
        .slice(0, columnLetters(G.dataColumns.first, G.dataColumns.last).length)
        .map((c) => c.width);
      expect(widths).toEqual(snapshot.columnWidths);
      expect(sheet.pageSetup).toEqual(snapshot.pageSetup);
    },
  );

  // C5 的实参必须**写穿 cells 侧表**：开了 readStyles 之后值与样式分挂两处，saveXlsx 是
  // 「先按 rows 建网格、再用 cells 逐格覆盖」（cells 赢）。只改 rows 的话，侧表里那条模板
  // 旧值会把新值盖回去 —— 而带样式模板里这正是数据区漏出 `{{...}}` 字面量的成因。
  // 这里先把侧表那条值改成别的（rows 不动），渲染后 C5 必须仍是实参。
  it.each(GAUGE_TEMPLATE_FILES)(
    'C5 的实参写穿 cells 侧表：侧表被改成陈旧值时产物仍拿实参：%s',
    async (file) => {
      const { openXlsx, saveXlsx } = await import('hucre');
      const wb = await openXlsx(new Uint8Array(readFileSync(file)), { readStyles: true });
      const c5col = colIndexOf(G.columns.customer_path);
      const stale = '侧表陈旧值';
      const cell = wb.sheets[0]!.cells!.get(`${G.dataStartRow},${c5col}`);
      expect(cell, '模板 C5 必须有 cells 侧表条目（没有的话这条用例会空转）').toBeDefined();
      cell!.value = stale;
      // 前提钉住：这一路**只**动了侧表，`rows` 侧仍是模板里的占位符。
      expect(wb.sheets[0]!.rows[G.dataStartRow]![c5col]).toBe('{{customer_path}}');

      const out = await renderDeliveryNoteWorkbook(
        await saveXlsx(wb),
        [{ sheetName: 'S', rows: [rowWithPath(0)] }],
        GAUGE_FOOTER,
        G,
      );
      const written = (await readBack(out)).sheets[0]!.rows[G.dataStartRow]![c5col];
      expect(written).toBe('终端BG / 手机部 / 影像组');
      expect(String(written)).not.toBe(stale);
    },
  );

  // ⚠️ 本组用例守的是「运行时兜底」。**主要防线是编译期**：两条 `@ts-expect-error` 在
  // `npm run typecheck` 下把「检具契约配零件页脚 / 零件契约配检具页脚」钉成编译错误 ——
  // 去掉泛型 `FooterFor<C>` 或让某个页脚形态变宽，这条 expect-error 会变成「本该报错却没报」，
  // `typecheck` 当场红。下面两段 `as never` 只是为了**绕过**类型去够运行时断言。
  it('契约与页脚不配套 ⇒ 编译期就报错（两条 @ts-expect-error 钉住）', () => {
    const sheetsArg = [{ sheetName: 'S', rows: [] }];
    // 两个调用**只参与类型检查、不执行**（关在没被调用的箭头函数里）：真跑起来会命中运行时
    // 兜底抛错，留下没人接的 rejected promise，污染整个测试文件的输出。
    const _neverCalled = () => {
      // @ts-expect-error 检具契约只配 GaugeFooterSpec：零件页脚缺判别位与送货日期
      renderDeliveryNoteWorkbook(GAUGE_TEMPLATE, sheetsArg, PART_FOOTER, G);
      // @ts-expect-error 零件契约只配 PartFooterSpec：检具页脚带的是送货日期
      renderDeliveryNoteWorkbook(TEMPLATE, sheetsArg, GAUGE_FOOTER);
    };
    expect(typeof _neverCalled).toBe('function');
  });

  it('页脚缺字段（判别位对、字段是 undefined）⇒ 抛中文错误，不把 undefined 印到单据上', async () => {
    // fillTemplate 对内嵌占位符走 String(replacement)：漏一个键就会印出「送货人：undefined」。
    // 守卫在配套判据之后**再**验必填键，这里绕开类型去够那条运行时断言。
    await expect(
      renderDeliveryNoteWorkbook(
        TEMPLATE,
        [{ sheetName: 'S', rows: [] }],
        malformed<PartFooterSpec>({ driverName: undefined, year: '2026', month: '10', date: '08' }),
      ),
    ).rejects.toThrow(/driverName 不是字符串（收到 undefined）/);
    await expect(
      renderDeliveryNoteWorkbook(
        GAUGE_TEMPLATE,
        [{ sheetName: 'S', rows: [] }],
        malformed<GaugeFooterSpec>({ kind: 'gauge', deliveryDate: undefined }),
        G,
      ),
    ).rejects.toThrow(/deliveryDate 不是字符串（收到 undefined）/);
  });

  it('契约与页脚不配套（绕过类型后）⇒ 抛中文错误，不静默渲染半成品', async () => {
    // 检具契约配零件版页脚 ⇒ I2 会原样输出 {{delivery_date}} 字面量
    await expect(
      renderDeliveryNoteWorkbook(
        GAUGE_TEMPLATE,
        [{ sheetName: 'S', rows: [] }],
        PART_FOOTER as never,
        G,
      ),
    ).rejects.toThrow(/deliveryDate/);
    // 反之：零件契约配检具版页脚 ⇒ 送货人 / 年月日会一起丢
    await expect(
      renderDeliveryNoteWorkbook(
        TEMPLATE,
        [{ sheetName: 'S', rows: [] }],
        GAUGE_FOOTER as never,
      ),
    ).rejects.toThrow(/零件版模板页脚/);
  });
});
