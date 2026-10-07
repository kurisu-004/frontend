// src/views/com/delivery/utils/deliveryNoteWorkbook.ts
//
// 用 **hucre** 在用户提供的模板上就地渲染打印内容（2026-10-08 新增）。
//
// 打印链路本次整体从后端搬回前端：后端两条打印端点（`/{id}/print` 与
// `/print-labels`）随送货单域重构下线，xlsx 由本文件生成。
//
// **为什么用 openXlsx/saveXlsx 而不是 writeXlsx**：round-trip 路径保留未建模的 part
// byte-for-byte —— 模板的合并单元格 / 边框 / 列宽 / 打印区域 / 字体 hucre 都没建模，
// 用 writeXlsx 重建会把这些全丢掉（打印出来是一张没有框线、没有合并的裸表）。
// 我们的写入只碰「值」，样式一律沿用模板。
//
// **数据行不走 fillTemplate**：fillTemplate 只吃 flat 的标量 record（hucre README 唯一
// 示例就是 `{company, date, total}`），没有数组 / 循环 / 多 sheet 概念。每行 10 列 ×
// N sheet × M 组全靠 fillTemplate 表达是不存在的用法，所以数据行由本文件按
// 契约的列下标逐格写；fillTemplate 只负责**页脚**那几个嵌在整串文案里的占位符。
//
// ⚠️ **实测结论（2026-10-08，`templates/delivery_note_fala.xlsx` + hucre 1.2.0）**：
//   `fillTemplate` **支持合并单元格内的占位符**。实测依据：模板的 F15 在合并区
//   `F15:J16`、A17 在合并区 `A17:J17`，两者都是「合并区左上角单元格持有值」的形态；
//   fillTemplate 逐 sheet 遍历 `sheet.rows[r][c]` 并对字符串做 `{{key}}` 替换
//   （`node_modules/hucre/dist/template.mjs`），完全不感知 merges，因此只要占位符在
//   锚格里就会被替换。渲染产物读回校验：F15 = 「送货人：李四」、
//   A17 = 「<41 空格>送货日期：  2026年10月08日」，8 处 merges 原样保留。
//   ⇒ 走 fillTemplate，**不**退化成整串写入。

import type * as HUCRE_MODULE from 'hucre';
import {
  DELIVERY_NOTE_TEMPLATE_CONTRACT,
  XLSX_MIME,
} from './deliveryNoteTemplateContract';
import { colIndexOf } from './deliveryNoteTemplate';

/** 打印表头行（与模板 row 2 的表头一一对应；字段名沿用 line item 的 snake_case）。 */
export interface PrintSheetRow {
  orderNo: string;
  l2Customer: string;
  applicant: string;
  drawingNo: string;
  name: string;
  /** 装配件「后端没给可出货套数」时是 null，模板里写**空**而不是 0 —— 0 会被读成
   *  「这套打不了」（口径见 utils/assemblySets）。 */
  quantity: number | null;
  unit: string;
  /** 系统交期；无值写 null（模板该格留空，不写字符串 '—'）。 */
  etd: string | null;
  note: string;
}

export interface PrintSheetSpec {
  sheetName: string;
  rows: PrintSheetRow[];
}

export interface PrintFooterSpec {
  driverName: string;
  year: string;
  month: string;
  date: string;
}

export type { Workbook as HucreWorkbook } from 'hucre/xlsx';


/**
 * 动态 import hucre 把它挤出主 bundle。
 *
 * `hucre/xlsx` 的 `{ readXlsx, writeXlsx }` 体积不小（README 的 size budget 量级），
 * 静态 import 会进首屏 bundle —— 绝大多数用户打开送货单列表页时根本不会点打印。
 * 动态 import 让 vite/rolldown 把它切成独立 chunk，只在点「导出」时才拉。
 *
 * ⚠️ `fillTemplate` 与 `cloneSheet` **只在根入口 `hucre` 上导出**，`hucre/xlsx` 子路径
 * 没有（子路径只导出 read/write + roundtrip + 一批 cell 工具）。因此这里必须 import
 * 根入口 —— hucre 标了 `"sideEffects": false` 且 index.mjs 只是 re-export，
 * rolldown 仍会按用到哪些符号做 tree-shake，不会把整个引擎拉进来。
 *
 * ⚠️ **代价（有意接受）**：根入口切出的 chunk 实测 484 kB raw / **142 kB gzip**，
 * 接近规格体积预算（68 kB）的两倍。**不要**改成一部分符号走 `hucre/xlsx` 子入口 ——
 * 两个入口混用会把两个 chunk 都拉进来，比只走根入口更大。
 */
async function loadHucre(): Promise<typeof HUCRE_MODULE> {
  // ⚠️ specifier 必须是**字面量**：写成变量 / 加 `/* @vite-ignore */` 都会让打包器
  // 无法静态分析，产物里留下一句运行时 `import('hucre')` —— node 单测能跑（node 会
  // 原生解析 bare specifier），**浏览器里必 404**，而 dist 里也不会出现 hucre chunk
  // （体积假装省掉了，其实是根本没打进去）。字面量才能切出独立 chunk。
  return import('hucre');
}

/** 打印产物的 MIME（Blob / download 用，从契约文件再导出一次省得调用方多 import）。 */
export { XLSX_MIME };

/**
 * 在模板字节上渲染打印内容，返回新的 xlsx 字节。
 *
 * - 第一个 sheet 用模板本体并改名成第 1 组的 sheet 名；
 * - 后续每组 `cloneSheet(base, name)` 克隆一份（深拷贝 rows / cells / columns /
 *   rowDefs / merges / dataValidations，见 hucre 的 sheet-ops::cloneSheet）；
 * - 数据行按契约列下标逐格写；**未填满的行整行清空**（模板第 3 行有 9 个 placeholder，
 *   不清的话没数据的行会漏出 `{{order_no}}` 字面量）；
 * - 页脚 4 个占位符交给 fillTemplate（嵌在整串文案里，正是它的目标场景）。
 */
export async function renderDeliveryNoteWorkbook(
  templateBytes: Uint8Array,
  sheets: PrintSheetSpec[],
  footer: PrintFooterSpec,
): Promise<Uint8Array> {
  const { openXlsx, saveXlsx, cloneSheet, fillTemplate } = await loadHucre();
  const c = DELIVERY_NOTE_TEMPLATE_CONTRACT;

  const wb = await openXlsx(templateBytes);
  const base = wb.sheets[c.sheetIndex];
  if (!base) throw new Error('模板缺少数据工作表');

  const list = sheets.length > 0 ? sheets : [{ sheetName: base.name, rows: [] }];
  const targets = list.map((spec, i) => {
    if (i === 0) {
      base.name = spec.sheetName;
      return base;
    }
    const cloned = cloneSheet(base, spec.sheetName);
    // cloneSheet 已带 newName；再赋一次是防御（万一将来换实现忘了传 name）。
    cloned.name = spec.sheetName;
    wb.sheets.push(cloned);
    return cloned;
  });

  const col = {
    no: colIndexOf(c.columns.no),
    order_no: colIndexOf(c.columns.order_no),
    l2_customer: colIndexOf(c.columns.l2_customer),
    applicant: colIndexOf(c.columns.applicant),
    drawing_no: colIndexOf(c.columns.drawing_no),
    name: colIndexOf(c.columns.name),
    quantity: colIndexOf(c.columns.quantity),
    unit: colIndexOf(c.columns.unit),
    system_delivery_date: colIndexOf(c.columns.system_delivery_date),
    note: colIndexOf(c.columns.note),
  };
  const width = col.note - col.no + 1;

  for (const [sheet, spec] of targets.map((t, i) => [t, list[i]] as const)) {
    // 整块数据区先清空（模板首行数据带 placeholder，其余行是空但有样式的格子）
    for (let k = 0; k < c.dataRowCount; k += 1) {
      const y = c.dataStartRow + k;
      const row = sheet.rows[y];
      if (!row) continue;
      for (let j = 0; j < width; j += 1) row[col.no + j] = '';
    }
    spec.rows.slice(0, c.dataRowCount).forEach((r, k) => {
      const y = c.dataStartRow + k;
      const row = sheet.rows[y];
      if (!row) return;
      row[col.no] = k + 1;
      row[col.order_no] = r.orderNo;
      row[col.l2_customer] = r.l2Customer;
      row[col.applicant] = r.applicant;
      row[col.drawing_no] = r.drawingNo;
      row[col.name] = r.name;
      row[col.quantity] = r.quantity ?? '';
      row[col.unit] = r.unit;
      row[col.system_delivery_date] = r.etd ?? '';
      row[col.note] = r.note;
    });
  }

  // 页脚占位符嵌在整串文案里（「送货人：{{driver_name}}」），fillTemplate 正对这种场景。
  // 键名必须与模板里的 placeholder **逐字一致**（driver_name / year / month / date），
  // 所以这里显式改名而不是直接 spread —— PrintFooterSpec 的驼峰字段只是视图侧读起来
  // 顺，写进模板的键是 snake_case。
  fillTemplate(wb, {
    driver_name: footer.driverName,
    year: footer.year,
    month: footer.month,
    date: footer.date,
  });
  return await saveXlsx(wb);
}