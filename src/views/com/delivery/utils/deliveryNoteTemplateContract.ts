// src/views/com/delivery/utils/deliveryNoteTemplateContract.ts
//
// 送货单 XLSX 模板契约（2026-10-08 新增）。
//
// 模板**由用户上传**（`el-upload`，见 deliveryNoteTemplate.ts）。契约固定为内置示例
// 模板（templates/delivery_note_fala.xlsx）的形态：列位、数据行区间、页脚占位符位置
// 全部写死，**不做列位自适应**。将来若改成后端绑定 COS 模板 URL，契约不变、只换数据
// 来源（`TemplateSource` 的 `url` 形态已预留）。
//
// 模板结构（已实测，见 assertTemplateMatches）：
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

export const DELIVERY_NOTE_TEMPLATE_CONTRACT = {
  /** 只用第 0 个工作表（用户上传的模板若有多 sheet，其余忽略）。 */
  sheetIndex: 0,
  /** 数据行：0-based row 2..11（即 Excel 的 row 3..12），每 sheet 容量 10。 */
  dataStartRow: 2,
  dataRowCount: 10,
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

/** 数据区最后一行的 0-based 下标（`dataStartRow + dataRowCount - 1`）。 */
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