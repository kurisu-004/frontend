// src/views/com/delivery/utils/deliveryNoteTemplateContract.ts
//
// 送货单 XLSX 模板契约（2026-10-08 新增；2026-10-16 新增第二套「检具送货单」版式）。
//
// 模板来源见 deliveryNoteTemplate.ts 的 `TemplateSource`，两种形态里**一条有真实调用方**：
//   · `api` —— 后端按**一级客户**绑定的那份（2026-10-16 新增）：管理员在「模板编辑」页
//              （路由 `/print-templates`，视图 `views/printTemplates/`）上传 / 替换 / 删除；
//              打开打印对话框时按单据的一级客户调 `GET /print-templates/resolve`，命中即
//              自动选用，取回的字节**探出版式**（`detectTemplateContract`，判不出即禁导出）；
//   · `url` —— **预留**（后端把模板绑到 COS 后按裸 URL 取），当前零调用方。
//
// 契约固定为内置示例模板的形态：列位、数据行区间、页脚占位符位置全部写死，**不做列位
// 自适应**，且**不随数据来源变** —— 取到字节之后走的是同一套版式探测与渲染。
//
// ⚠️ **逐格校验（`assertTemplateMatches`）只在「模板编辑」页上传闸那一个地方跑**，打印页不跑
// （模板入库前已经过那道闸，再验一遍只会把「管理员改了一格小东西」变成要联系管理员才能打印）。
// 打印侧要的是一个**二选一**的结论 —— 探出版式就按它渲染，判不出就禁导出。
//
// 仓库里有**两套版式**（判别位 `kind`）：
//   · `kind: 'part'` —— 零件版，模板 `templates/delivery_note_fala.xlsx`（法拉），10 列。
//   · `kind: 'gauge'` —— 检具版，模板 `templates/delivery_note_gauge_bailuda.xlsx`（百路达）
//     与 `templates/delivery_note_gauge_xingnan.xlsx`（杏南）。
//
// ⚠️ 两份检具模板**不是逐字节同构**，一份契约管两份的依据是「契约关心的那几项经实测一致」：
//   · 一致（`assertTemplateMatches` 逐格实测 + spec 里同款用例）：数据行区间（row 5..29）、
//     列位与占位符、页脚锚点 I2、9 处合并区清单。
//   · 不一致（同一批实测）：列宽、sheet 名、**样式覆盖**（带样式的格子数两份不同）、
//     尾部说明区的**内容**（杏南那份是两行说明文案，百路达那份当前为空）。
//     其中**列宽已按份写死快照**（deliveryNoteWorkbook.spec.ts：两份各一份打印区 A..I 的
//     列宽、打印设置两份相同共用一份）—— 列宽直接决定排版，改模板必须连断言一起改；
//     sheet 名 / 样式覆盖 / 尾部说明区三项仍**不写具体数字**：样式那条用例是「产物不少于
//     模板原件」的自指不变式（hucre round-trip 只增不减，增量由模板里数据区之外的列宽 / 行
//     定义决定，所以既不能写死数字也不能绑「恰好相等」），写死就成了没人核的散文。
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
// 检具版模板结构（2026-10-16 实测；两份模板逐项对过；下面的占位符清单由
// deliveryNoteTemplate.spec 逐格验，合并区清单由 deliveryNoteWorkbook.spec 验，两份模板都跑）：
//   单 sheet（sheet 名随客户而异：百路达 / 杏南），9 处合并：
//     A1:I1（标题）/ G3:H3（检具状态）/ A3:A4 · B3:B4 · C3:C4 · D3:D4 · E3:E4 ·
//     F3:F4 / I3:I4
//   row 1     标题（合并 A1:I1）
//   row 2     H2「送货日期」标签 + **I2 `{{delivery_date}}`**（整格只有这一个占位符）
//   row 3-4   两行表头，**不参与渲染、不参与校验**
//   row 5-29  25 个数据行：A5:A29 全是 `{{no}}`；**只有首行 row 5** 带
//             {{order_no}}(B5) / {{customer_path}}(C5) / {{drawing_no}}(D5) / {{name}}(E5) /
//             {{quantity}}(F5) / {{system_delivery_date}}(I5)
//   row 30-31 客户版式自带的**说明区**（2026-10-18 实测：杏南那份是两行说明文案，百路达
//             那份为空）：本域既不渲染也不校验它，客户手工维护模板时增删这段不算版式变更，
//             所以契约不描述这里的内容
//   G 列（新制/返修）、H 列（NG/OK/校验备注）**故意没有占位符** —— 按客户约定由送货厂家
//   手填，渲染时清空成带边框的空列（清空范围覆盖 A..I，见 `dataColumns`，模板里可能残留
//   样例值）。
//
// ⚠️ 2026-10-17 客户无限层级改造**没有动**零件版契约的任何列位 / 占位符：`columns.l2_customer`
// 仍是 `'C'`、第 3 行表头仍写死 `{{l2_customer}}`，变的只是**填进去的值**（从叶子客户单段名
// 改成「第 2 层到叶子的 ` / ` 路径」）。`l2_customer` 这个字段名因此是**不可改的契约**：它同时
// 是模板占位符名、`PrintRow` 字段名与标签工作簿的列 key，改任何一处都会让用户已上传的模板
// 整列留空。语义见 `deliveryNotePrintRows.ts::PrintRow.l2_customer`。
//
// ⚠️ 检具版的 C 列（2026-10-18 新增）写的是**同一个值**，但键名是 `customer_path`（不是
// `l2_customer`）：这一列是本轮才给检具模板放上占位符的，键名不必与零件版的历史包袱一致。
// 渲染层两个键都映射到 `PrintSheetRow.l2Customer` 同一个字段（见 deliveryNoteWorkbook.ts 的
// COLUMN_FIELD），因此不存在第二份客户取值口径。

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
  /** 整块清空 A..I：G / H 两列是故意留给送货厂家手写的（客户样例里可能有残留值）；
   *  C 列也在清空范围内 —— 它随后会被写入实参覆盖，清空只是先把模板里的旧值（样例残留）
   *  抹掉，两步顺序与零件版一致。 */
  dataColumns: { first: 'A', last: 'I' },
  /** 有数据来源的列；**G / H 两列不在此列**（渲染时留空供手写）。
   *
   *  `customer_path` 写的是「**第 2 层到叶子的 ` / ` 路径、不含 L1**」——与零件版 C 列
   *  （`l2_customer`）是**同一个值**，键名不同只因这一列是 2026-10-18 才放上占位符的，
   *  不必背零件版的历史包袱。路径为空时后端兜底成单段名（判据是 `toPrintRow` 里那条
   *  `li.customer_path || li.customer_name || ''`，见 deliveryNotePrintRows.ts）。
   *
   *  ⚠️ 客户版式**没有单位列**（这不是漏写，2026-10-16 实测两份模板都是这样）⇒ 数量列 F 写的是
   *  **裸数字**。`PrintSheetRow` 仍强制 `applicant` / `unit` / `note` 三个字段，它们在检具版
   *  **没有消费方**（列位不在本表里，渲染层按 `columns` 反查，压根不会被读到）。
   *  将来客户要显示单位，必须先改客户版式（加列）再改本表，不是渲染层能补的。 */
  columns: {
    no: 'A',
    order_no: 'B',
    customer_path: 'C',
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
