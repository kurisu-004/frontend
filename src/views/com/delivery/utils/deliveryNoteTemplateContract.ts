// src/views/com/delivery/utils/deliveryNoteTemplateContract.ts
//
// 送货单 XLSX 模板契约（2026-10-08 新增；2026-10-16 新增第二套「检具送货单」版式）。
//
// 模板**由用户上传**（`el-upload`，见 deliveryNoteTemplate.ts）。契约固定为内置示例
// 模板的形态：列位、数据行区间、页脚占位符位置全部写死，**不做列位自适应**。将来若改成
// 后端绑定 COS 模板 URL，契约不变、只换数据来源（`TemplateSource` 的 `url` 形态已预留）。
//
// 仓库里有**两套版式**（判别位 `kind`）：
//   · `kind: 'part'` —— 零件版，模板 `templates/delivery_note_fala.xlsx`（法拉），10 列。
//   · `kind: 'gauge'` —— 检具版，模板 `templates/delivery_note_gauge_bailuda.xlsx`（百路达）
//     与 `templates/delivery_note_gauge_xingnan.xlsx`（杏南）。两份**版式完全一致**，只有
//     列宽与 sheet 名不同 ⇒ 一份契约同时管这两份模板。
//
// 零件版模板结构（已实测，见 assertTemplateMatches）：
//   单 sheet `Sheet1`，打印区 A1:J17，8 处合并：
//     A1:J1（标题）/ A13:E13 / A14:E14 / A15:E15 / A16:E16 / A17:J17 /
//     F13:J14 / F15:J16
//   row 1  标题（合并 A1:J1）
//   row 2  表头：A 序号 · B 订单号 · C 分厂 · D 申请人 · E 编码 · F 名称 ·
//           G 数量 · H 单位 · I 预估交期 · J 备注
//   row 3-12  10 个数据行：A3:A12 全是 `{{no}}`，B3:J3 有 9 个 placeholder，
//             B4:J12 空但有样式
//   row 13-17 页脚：收货单位 / 地址电话 / 收货人 / 送货单位 / 地址电话 /
//             「送货人：{{driver_name}}」（F15:J16）/ 「送货日期：{{year}}年{{month}}月{{date}}日」（A17:J17）
//
// 检具版模板结构（2026-10-16 实测）：
//   单 sheet（sheet 名随客户而异：百路达 / 杏南），9 处合并：
//     A1:I1（标题）/ G3:H3（检具状态）/ A3:A4 · B3:B4 · C3:C4 · D3:D4 · E3:E4 ·
//     F3:F4 / I3:I4
//   row 1     标题（合并 A1:I1）
//   row 2     H2「送货日期」标签 + **I2 `{{delivery_date}}`**（整格只有这一个占位符）
//   row 3-4   两行表头，**不参与渲染、不参与校验**
//   row 5-29  25 个数据行：A5:A29 全是 `{{no}}`；**只有首行 row 5** 带
//             {{order_no}}(B5) / {{drawing_no}}(D5) / {{name}}(E5) /
//             {{quantity}}(F5) / {{system_delivery_date}}(I5)
//   row 30-31 「填写说明」，不参与
//   C 列（申请部门/人）、G 列（新制/返修）、H 列（NG/OK/校验备注）**故意没有占位符**
//   —— 按客户约定由送货厂家手填，渲染时清空成带边框的空列（清空范围覆盖 A..I，
//   见 `dataColumns`，模板里可能残留样例值）。

export const DELIVERY_NOTE_TEMPLATE_CONTRACT = {
  /** 版式判别位（2026-10-16 新增）。 */
  kind: 'part',
  /** 只用第 0 个工作表（用户上传的模板若有多 sheet，其余忽略）。 */
  sheetIndex: 0,
  /** 数据行：0-based row 2..11（即 Excel 的 row 3..12），每 sheet 容量 10。 */
  dataStartRow: 2,
  dataRowCount: 10,
  /** 数据区**整块清空**的列范围（2026-10-16 新增）：渲染时这批列逐格写空，模板里
   *  残留的样例值 / placeholder 不会被打出去。范围必须**覆盖** `columns` 的全部列。 */
  dataColumns: { first: 'A', last: 'J' },
  /** 数据列：列字母 → 字段名（严格一致，不做列位自适应）。 */
  columns: {
    no: 'A',
    order_no: 'B',
    l2_customer: 'C',
    applicant: 'D',
    drawing_no: 'E',
    name: 'F',
    quantity: 'G',
    unit: 'H',
    system_delivery_date: 'I',
    note: 'J',
  },
  /** 页脚：占位符嵌在整串文案里（如「送货人：{{driver_name}}」）。 */
  footer: {
    driver_name: 'F15',
    year: 'A17',
    month: 'A17',
    date: 'A17',
  },
} as const;

/** 检具送货单版式契约（2026-10-16 新增，管百路达 / 杏南两份同版式模板）。 */
export const GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT = {
  kind: 'gauge',
  /** 只用第 0 个工作表（sheet 名是「百路达」/「杏南」，由渲染层按分组改名覆盖）。 */
  sheetIndex: 0,
  /** 数据行：0-based row 4..28（即 Excel 的 row 5..29），每 sheet 容量 25。 */
  dataStartRow: 4,
  dataRowCount: 25,
  /** 整块清空 A..I：含故意留给手写的 C / G / H 三列（客户样例里这几列可能有残留值）。 */
  dataColumns: { first: 'A', last: 'I' },
  /** 只有 6 个列有数据来源；C / G / H 三列不在此列（渲染时留空供手写）。 */
  columns: {
    no: 'A',
    order_no: 'B',
    drawing_no: 'D',
    name: 'E',
    quantity: 'F',
    system_delivery_date: 'I',
  },
  /** 页脚只有一个占位符，且不在页脚区 —— 是表头右侧的 I2（送货日期）。 */
  footer: {
    delivery_date: 'I2',
  },
} as const;

export type PartDeliveryNoteTemplateContract = typeof DELIVERY_NOTE_TEMPLATE_CONTRACT;
export type GaugeDeliveryNoteTemplateContract = typeof GAUGE_DELIVERY_NOTE_TEMPLATE_CONTRACT;

/**
 * 两套版式的判别联合（`kind` 是判别位）。
 *
 * ⚠️ `columns` / `footer` 的**键集随 kind 变化**（检具版没有 `l2_customer` / `unit` /
 * `note`，页脚只有一个 `delivery_date`）⇒ 消费方必须先按 `kind` 收窄再取字段。
 */
export type DeliveryNoteTemplateContract =
  | PartDeliveryNoteTemplateContract
  | GaugeDeliveryNoteTemplateContract;

/** 数据区最后一行的 0-based 下标（`dataStartRow + dataRowCount - 1`，零件版）。 */
export const DELIVERY_NOTE_LAST_DATA_ROW =
  DELIVERY_NOTE_TEMPLATE_CONTRACT.dataStartRow + DELIVERY_NOTE_TEMPLATE_CONTRACT.dataRowCount - 1;

/** 页脚三处占位符的锚点文本（assertTemplateMatches 的判据，也是退化路径的整串写入源）。
 *
 *  这些文本是从模板实测抄下来的：写进 hucre 之前它们长这样，`fillTemplate` 把
 *  `{{...}}` 换成实参后得到成品那一格。
 *  A17 的前缀是 **41 个空格**（不是 40 个空格 + 一个全角空格，也不是 tab）——
 *  整串写入退化路径要一字不差地还原，否则打印出来日期会顶到行首。 */
export const FOOTER_DRIVER_NAME_ANCHOR = '送货人：{{driver_name}}';
export const FOOTER_DATE_ANCHOR = '送货日期：  {{year}}年{{month}}月{{date}}日';
/** A17 锚点在模板里的前导空白（0-based 长度见下方常量，改模板时同步）。 */
export const FOOTER_DATE_LEADING_SPACES = ' '.repeat(41);
/** A17 锚点里「送货日期：」之后的两个空格（模板原文如此）。 */
export const FOOTER_DATE_LABEL_GAP = '  ';

/** xlsx MIME（Blob / download 用）。 */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';