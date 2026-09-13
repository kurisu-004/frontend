// 打印模板编辑器：共享类型定义（2026-09-14 新增）。
//
// 设计要点：
// - 模板结构刻意只覆盖「自定义表格」最小子集：纸张/方向/边距 + 列定义 + 二维表格（表头行 + 数据行）。
// - 单元格内容为纯字符串，支持 {{row.x}} / {{row.x.y}} / {{$index}} 占位（见 interpolate.ts）。
// - 后续接入其他组件（文本框 / 图片 / 二维码 / 分页符）时再扩 PrintTemplate 字段，
//   本期实现不预留虚位。

export type PaperSize = 'A4' | 'A5' | 'B5' | 'custom';
export type Orientation = 'portrait' | 'landscape';

export interface PaperMargin {
  /** 单位 mm，与 CSS mm 一致；打印介质浏览器默认走 mm。 */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 列定义：模板设计期的列结构。label = 表头显示文本；width = 列宽（mm 或 fr）。 */
export interface TemplateColumn {
  /** 列稳定 key（保存到模板），用于数据绑定列号定位。 */
  key: string;
  /** 表头显示文本（设计期可编辑）。 */
  label: string;
  /** 列宽：CSS grid 风格的 `fr` 单位字符串（如 '1fr' / '120mm'），默认 '1fr'。 */
  width: string;
}

/**
 * 单元格占位符语法（interpolate.ts 解析）：
 *   {{row.field}}         → 当前行 row.field
 *   {{row.field.sub}}     → 嵌套字段（点路径）
 *   {{$index}}            → 行号（从 1 开始）
 *   {{$index0}}           → 行号（从 0 开始）
 *   其它文本              → 原样输出
 */
export interface PrintTemplate {
  id: string;
  name: string;
  paper: PaperSize;
  /** custom 纸张时的尺寸（mm）；paper !== 'custom' 时忽略。 */
  customWidthMm?: number;
  customHeightMm?: number;
  orientation: Orientation;
  margin: PaperMargin;
  columns: TemplateColumn[];
  /** 表头行单元格内容：长度应等于 columns.length；与 columns 一一对应。 */
  headerCells: string[];
  /**
   * 数据行模板：长度 = 设计期「行数」；每一行长度应等于 columns.length。
   * 每个单元格字符串内可写 {{row.x}} 占位，打印时按当前行数据替换。
   */
  rowCells: string[][];
  /**
   * 数据来源标识：
   *   'mock'   → 使用模板内置 mock 数据（默认）
   *   'manual' → 使用用户手动粘贴的 JSON
   *   'api:<endpoint>' → 后续后端联动接入时使用（如 'api:/api/v1/delivery-notes/:id'）
   */
  dataSource: string;
  /** dataSource === 'manual' 时使用：用户粘贴的 JSON 字符串，运行时 JSON.parse。 */
  manualDataJson: string;
  createdAt: string;
  updatedAt: string;
}

/** 打印预览 / 实际打印时使用的扁平行（与后端返回的数据条目形态对齐）。 */
export interface PrintRowData {
  [key: string]: unknown;
}

/** 模板存储于 localStorage 的 schema 版本：未来字段不兼容时 bump 版本号做迁移。 */
export const TEMPLATE_STORAGE_VERSION = 1;
export const TEMPLATE_STORAGE_KEY = `print_templates_v${TEMPLATE_STORAGE_VERSION}`;

export interface TemplateStorageEnvelope {
  version: number;
  templates: PrintTemplate[];
}
