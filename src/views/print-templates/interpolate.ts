// 单元格内容占位符插值（2026-09-14 新增）。
//
// 支持的语法：
//   {{row.field}}         → row[field]
//   {{row.field.sub.path}}→ 嵌套点路径
//   {{$index}}            → 行号（从 1 开始）
//   {{$index0}}           → 行号（从 0 开始）
//   其它文本              → 原样输出
//
// 设计要点：
// - 用正则扫描 {{...}} 区段，按上下文纯字符串替换，不走 eval / new Function。
// - 解析失败（语法错、字段缺失） → 渲染为空串并在 dev mode 下 console.warn，
//   避免打印时整页崩溃；这是「打印模板」的容错基线。
// - 本期未做「自定义函数」 / 「条件渲染」，保持语法面最小，避免打印期解析爆炸。

import type { PrintRowData, PrintTemplate } from './types';

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** 取点路径：row.a.b.c。中间任一环节为 undefined → 返回 undefined。 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 把任意值规范化为可打印字符串：null/undefined → ''，其它 String()。 */
function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 对象/数组：fallback JSON，避免 [object Object]
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export interface InterpolateContext {
  row: PrintRowData | null;
  /** 0-based 行索引。 */
  index0: number;
}

/**
 * 插值入口：
 *   - 单元格文本 = template；row = 当前数据行；index0 = 0-based 行号。
 *   - 返回替换完的字符串；不抛错，解析失败返回原模板或空串（按警告策略）。
 */
export function interpolate(template: string, ctx: InterpolateContext): string {
  if (!template) return '';
  return template.replace(PLACEHOLDER_RE, (_match, expr: string) => {
    const trimmed = expr.trim();
    if (trimmed === '$index') return String(ctx.index0 + 1);
    if (trimmed === '$index0') return String(ctx.index0);
    if (trimmed.startsWith('row.')) {
      const path = trimmed.slice(4);
      const v = ctx.row == null ? undefined : getByPath(ctx.row, path);
      if (v === undefined && import.meta.env.DEV) {
        // dev 模式提示：模板里写了 row.xxx 但当前行没有这个字段。
        console.warn(`[print-template] 字段缺失：{{${trimmed}}} in row ${ctx.index0}`);
      }
      return stringifyValue(v);
    }
    // 未知语法：原样保留（让用户看到自己写错的内容），不静默吞掉
    return `{{${trimmed}}}`;
  });
}

/** 打印预览 / 实际打印时消费的渲染结果。 */
export interface RenderedTable {
  header: string[];
  rows: string[][];
}

/**
 * 把 mock data + 模板渲染成预览用的二维结构。
 *
 * 模板设计期往往只配 1-3 个 rowCells（重复模式），打印时按数据行数循环复用；
 * 用户也可以让 rowCells.length === 数据行数 做一一映射。
 */
export function renderTable(template: PrintTemplate, data: PrintRowData[]): RenderedTable {
  const header = template.columns.map((_c, i) => template.headerCells[i] ?? '');
  const colCount = template.columns.length;
  const repeatCount = Math.max(template.rowCells.length, 1);

  const filledRows = data.map((row, idx) => {
    const tplRow = template.rowCells[idx % repeatCount] ?? [];
    const cells: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      cells.push(interpolate(tplRow[c] ?? '', { row, index0: idx }));
    }
    return cells;
  });
  return { header, rows: filledRows };
}
