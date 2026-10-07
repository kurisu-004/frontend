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

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { renderDeliveryNoteWorkbook } from '../deliveryNoteWorkbook';
import { DELIVERY_NOTE_TEMPLATE_CONTRACT } from '../deliveryNoteTemplateContract';

// ⚠️ 必须从 Buffer 构造 Uint8Array（不能用 `buf.buffer`：node 的 Buffer 可能落在
// 8MB 池化 ArrayBuffer 的一段上，`.buffer` 拿到的是**整个池**，字节不是 xlsx）。
const TEMPLATE = new Uint8Array(readFileSync('templates/delivery_note_fala.xlsx'));

/** 模板原件里带样式索引（`s=`）的 cell 数 —— 渲染产物必须一条不少地对上（2026-10-08 实测）。 */
const TEMPLATE_STYLED_CELLS = 172;

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

function row(i: number) {
  return {
    orderNo: `SO-${i}`,
    l2Customer: '法拉',
    applicant: '张三',
    drawingNo: `C-100${i}`,
    name: '铝电解电容',
    quantity: i + 1,
    unit: '件',
    etd: '2026-11-01',
    note: '',
  };
}

async function readBack(bytes: Uint8Array) {
  const { readXlsx } = await import('hucre');
  return readXlsx(bytes);
}

/** 数据行条数（A 列非空计数；模板的数据行 A 列是 {{no}}，渲染后是序号）。 */
function dataRowCount(sheet: { rows: unknown[][] }): number {
  const c = DELIVERY_NOTE_TEMPLATE_CONTRACT;
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

  it('零残留占位符（模板里 11 个 placeholder 全被替换或清空）', async () => {
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
