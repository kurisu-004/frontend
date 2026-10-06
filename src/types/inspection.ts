// 2026-10-03 新增：待品检队列（`GET /api/v2/prod/inspection/queue`）的排序枚举
// 与列 prop 双向映射。形态对齐 parts 域的 `PartSortKey` / `PART_SORT_PROP_MAP`
// （同在 `@/types/parts`），使「待品检一览」页能与「零件一览」页共用同一套
// 表头点击 → 排序的服务端排序接法。
//
// ⚠️ 排序方向类型复用 `@/types/parts` 的 `SortDir`（'ASC' | 'DESC'），本文件
// **不重复导出**它 —— 两处各声明一份同形联合会让「同一个方向字段有两种来源类型」
// 的错觉，且持久化恢复处的收敛逻辑（PART_SORT_KEY_SET 同形态）会被迫写两遍。

/** 待品检队列允许的服务端排序字段（后端 `sort_by` 白名单，非法值退化为
 *  `SYSTEM_DELIVERY_DATE`）。与列表的 7 个数据列一一对应：序列号 / 图号 / 名称 /
 *  批次 / 数量 / 系统交期 / 客户。 */
export type InspectionSortKey =
  | 'SERIAL_NO'
  | 'DRAWING_NO'
  | 'NAME'
  | 'BATCH_NO'
  | 'QUANTITY'
  | 'SYSTEM_DELIVERY_DATE'
  | 'CUSTOMER_NAME';

/** `el-table` 列 `prop` → 后端 `InspectionSortKey` 映射。
 *  客户列的 prop 刻意取 `customer`（不是 `customer_name`）：该列渲染的是
 *  `l1_customer_name + customer_name` 派生的「父 / 子」两段文本，prop 名与渲染
 *  来源一致更好读，后端排序键仍是 `CUSTOMER_NAME`。 */
export const INSPECTION_SORT_PROP_MAP: Record<string, InspectionSortKey> = {
  serial_no: 'SERIAL_NO',
  drawing_no: 'DRAWING_NO',
  name: 'NAME',
  batch_no: 'BATCH_NO',
  quantity: 'QUANTITY',
  system_delivery_date: 'SYSTEM_DELIVERY_DATE',
  customer: 'CUSTOMER_NAME',
};

/** 合法排序键集合（用于排序状态持久化恢复时把越界值收敛回合法值）。 */
export const INSPECTION_SORT_KEY_SET: ReadonlySet<InspectionSortKey> = new Set(
  Object.values(INSPECTION_SORT_PROP_MAP),
);

/** InspectionSortKey → 列 prop 名（用于 default-sort / `elTableRef.sort()`）。 */
export const INSPECTION_SORT_KEY_TO_PROP: Record<InspectionSortKey, string> = Object.fromEntries(
  Object.entries(INSPECTION_SORT_PROP_MAP).map(([prop, key]) => [key, prop]),
) as Record<InspectionSortKey, string>;
