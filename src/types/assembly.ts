// types/assembly.ts
//
// 与后端 schema/assembly.py 对齐的 TypeScript 类型。

import type { PartListItem } from '@/types/parts';
import type { DrawingFileItem } from './file';

// 2026-09-29 修复：装配件详情响应实际 wire 形态是平铺（后端 `#[serde(flatten)]`
// quirk），前端类型契约保持嵌套 `{assembly, children, files}`（最小爆炸半径），
// 由 src/api/assembly.ts::parseAssemblyDetail mapper 在 api 边界消化该 quirk。
// 此处仅追加 AssemblyChildItem 类型 + AssemblyItem 4 派生字段改 optional。

export type AssemblySortKey =
  'PLANNED_DELIVERY_DATE' | 'REQUEST_DATE' | 'CREATED_AT' | 'SERIAL_NO' | 'DRAWING_NO' | 'NAME';

export type SortDir = 'ASC' | 'DESC';

/** 装配件状态枚举（与后端 model/enums.py::AssemblyStatus 对齐，2026-08-03 扩 7 态）。 */
export type AssemblyStatus =
  | 'PENDING'
  | 'IN_PROCESS'
  | 'INSPECTION'
  | 'READY_TO_SHIP'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED';

/** 装配件状态 → 中文 label（与 PartsList 同款模式）。 */
export const ASSEMBLY_STATUS_LABEL: Record<AssemblyStatus, string> = {
  PENDING: '待生产',
  IN_PROCESS: '生产中',
  INSPECTION: '待品检',
  READY_TO_SHIP: '待送货',
  DELIVERED: '已送货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

/** 装配件状态 → el-tag type（与 ORDER_STATUS_TAG_TYPE 视觉语义对齐）。 */
export const ASSEMBLY_STATUS_TAG_TYPE: Record<
  AssemblyStatus,
  'info' | 'warning' | 'success' | 'danger' | 'primary'
> = {
  PENDING: 'info',
  IN_PROCESS: 'primary',
  INSPECTION: 'warning',
  READY_TO_SHIP: 'primary',
  DELIVERED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'info',
};

/** 装配件（与后端 TAssembly 对齐） */
export interface AssemblyItem {
  id: string;
  /** 乐观锁版本号；每次 UPDATE 自增（后端 SQLAlchemy version_id_col）；
   *  当前端暂不消费，后续可用于冲突检测。 */
  version: number;
  /** 装配件流水号；老装配件为 null */
  serial_no: string | null;
  drawing_no: string;
  name: string;
  applicant_name: string | null;
  customer_id: string;
  // 2026-09-29 修复：detail 端点（backend-rust `AssemblyDetail`）不带这 4 派生字段
  // （后端 `AssemblyOut` 平铺，无 customer_name / parent_customer_name / customer_path /
  // child_count），由 mapper 置 null 后由 useAssemblyDetail composable 在 fetchData
  // 后用 useCustomersQuery 派生补全。list 端点（`AssemblyListItem`）仍冗余返这 4 字段，
  // 故用 optional 兼容两端点。
  customer_name?: string | null;
  parent_customer_name?: string | null;
  customer_path?: string | null;
  child_count?: number;
  request_date: string;
  planned_delivery_date: string;
  // PR-2 2026-09-16 t_assembly 瘦身：actual_delivery_date 随后端列下线从出参删除。
  is_urgent: boolean;
  /** PENDING / IN_PROCESS / INSPECTION / READY_TO_SHIP / DELIVERED / COMPLETED / CANCELLED */
  status: AssemblyStatus;
  // —— 2026-07-24 新增：装配体自身价格 + 送货单字段 ——
  /** 装配体套数（默认 1） */
  quantity: number;
  /** 装配体单价（后端写接口 AssemblyOut 返 Decimal string，mapper 用
   *  Number()/null 兜底；null = 后端未落库，UI 用 — 占位）。 */
  unit_price: number | null;
  /** 装配体总价 = quantity * unit_price（后端落库；语义同 unit_price）。 */
  total_price: number | null;
  /** 订单号（法拉/路达共用） */
  order_no: string | null;
  /** 订单方系统内部交期 */
  system_delivery_date: string | null;
  /** 备注 */
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** 列表窄出参（与 AssemblyItem 字段一致 + serial_no）。 */
export type AssemblyListItem = AssemblyItem;

export interface AssemblyListQuery {
  /** 雪花 ID 字符串（CLAUDE.md §3 — 19 位 > JS Number.MAX_SAFE_INTEGER） */
  customer_id?: string;
  status?: AssemblyStatus | string;
  is_urgent?: boolean;
  drawing_no_like?: string;
  name_like?: string;
  sort_by?: AssemblySortKey;
  sort_dir?: SortDir;
  limit?: number;
  offset?: number;
}

export interface AssemblyListResult {
  items: AssemblyListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 创建装配件时的子零件条目（PDF 按页拆分后，前端只需要填基础字段）。 */
export interface AssemblyChildPayload {
  drawing_no: string;
  name: string;
  quantity?: number;
  applicant_name?: string | null;
}

/** 创建装配件的 JSON body（不含文件；文件单独 multipart 传） */
export interface AssemblyCreatePayload {
  name: string;
  drawing_no: string;
  applicant_name?: string | null;
  /**
   * 申请人表 id（雪花 ID 字符串）。必须是字符串：
   * 同 parts.ts 的 PartCreatePayload.applicant_id，详见 CLAUDE.md「雪花 ID 溢出」一节。
   */
  applicant_id?: string | null;
  /** 雪花 ID 字符串（CLAUDE.md §3） */
  customer_id: string;
  request_date: string;
  planned_delivery_date: string;
  is_urgent?: boolean;
  /** 子件；可空（创建空装配体到详情页再补） */
  children?: AssemblyChildPayload[];
  // —— 2026-07-24 新增：装配体自身价格 + 送货单字段 ——
  quantity?: number;
  unit_price?: number;
  /** 不传时由 service 按 unit_price * quantity 计算 */
  total_price?: number | null;
  order_no?: string | null;
  system_delivery_date?: string | null;
  note?: string | null;
}

/** 创建结果（创建响应需要完整数据；子件用 PartListItem 即可，详情页用窄版） */
export interface AssemblyCreateResult {
  assembly: AssemblyItem;
  children: PartListItem[];
  files: DrawingFileItem[];
}

/** 装配件详情：自身 + 子件 + 文件 */
// 2026-09-29 修复：children 类型从 PartListItem[] 改为 AssemblyChildItem[]。
// PartListItem 是列表窄出参（含 holder_name / process_chain_id / batch_id 等列表
// 专用字段），装配件子件实际只有 13 字段（AssemblyChildOut），且 PartListItem 缺
// current_batch_id（子件专用）；旧 bug 走类型欺骗 detail.children 当 PartListItem 用。
// 新类型结构与 PartListItem 同构（同样的列展示需求），但**新增** current_batch_id +
// __is_child 标记字段，所有 PartListItem 必填字段都补齐（mapper 在 api 边界做对齐）。
export interface AssemblyDetail {
  assembly: AssemblyItem;
  children: AssemblyChildItem[];
  files: DrawingFileItem[];
}

/** 装配件子件展示项（与 PartListItem 同构 + 子件专属字段）。
 *
 * 2026-09-29 修复：从 AssemblyDetail.children 的 PartListItem[] 升级而来。
 * mapper（api/assembly.ts::childToAssemblyChildItem）字段对齐：
 *   - 子件后端 13 字段 → 14 字段展示项（+ current_batch_id）
 *   - PartListItem 必填字段全补齐（applicant_name / quantity / unit_price='0' /
 *     total_price='0' / request_date / planned_delivery_date / status / order_no /
 *     system_delivery_date / note=null / customer_name=null / l1_customer_name=null
 *     / location=null / row_type='PART' / has_children=false）
 *   - __is_child: true literal type 给消费者做窄化判断
 *
 * 字段类型语义保持与 PartListItem 一致（string for unit_price/total_price 沿 2026-09-27
 * 前后端字段对齐约定）；is_urgent 在子件里固定 false（兜底，沿 mapper 实现）。
 */
export interface AssemblyChildItem extends PartListItem {
  /** 2026-09-29 修复：子件当前激活批次 id（后端 AssemblyChildOut.current_batch_id）。
   *  子件无活跃批次时为 null。PartListItem 同名字段已 optional，保持兼容。 */
  current_batch_id: string | null;
  /** literal type 标记：本行是装配件子件（来自 AssemblyDetail.children）。
   *  消费者用 `row.__is_child === true` 做窄化（如 PartsTable.rowKey 派生 CHILD_${id}）。 */
  __is_child: true;
}
/** 编辑装配件的 payload（field-level partial；POST /assemblies/{id}/update）。 */
export interface AssemblyUpdatePayload {
  /** 2026-09-28 契约修复：乐观锁必填。后端 `AssemblyUpdateRequest.version: i32`
   *  **无 `#[serde(default)]`**（backend-rust `src/modules/assembly/dto.rs`），
   *  缺字段时 axum `Json` extractor 直接拒 → HTTP 422 `missing field version`。
   *  必须取自 `AssemblyItem.version`（= t_assembly.version）。 */
  version: number;
  drawing_no?: string | null;
  name?: string | null;
  /** 雪花 ID 字符串（CLAUDE.md §3） */
  customer_id?: string | null;
  applicant_name?: string | null;
  /** 雪花 ID 字符串 */
  applicant_id?: string | null;
  /** YYYY-MM-DD */
  request_date?: string | null;
  planned_delivery_date?: string | null;
  // PR-2 2026-09-16 t_assembly 瘦身：更新请求体不再接受 actual_delivery_date。
  is_urgent?: boolean | null;
  // —— 2026-07-24 新增 ——
  quantity?: number | null;
  unit_price?: number | null;
  /**
   * 2026-09-28 契约修正 + 关键 null 语义警告：
   * 后端 `AssemblyUpdateRequest.total_price` 是三态 `Option<Option<Decimal>>`
   * （`deserialize_optional_optional_decimal`），语义为
   * 「缺省 = 不动 / `null` = 置 NULL / 有值 = 覆盖」，且
   * `t_assembly.total_price` 是 `NOT NULL` 列 —— 显式发 `null` 会解成
   * `Some(None)` → SQL `total_price = NULL` → Postgres 23502 → HTTP 500。
   * **要「不动」就省略该 key，绝不能发 `null`。**
   *
   * 同时修正旧注释：后端 `assembly/service/crud.rs::update_assembly` 与
   * `part/repo/sql/part_sql.rs::update_part` 一样**只写 caller 传的值，
   * 不会按 unit_price * quantity 自动重算**（该重算仅存在于 create 路径）。
   * 故改数量/单价时必须由前端算好一并送。
   */
  total_price?: number;
  order_no?: string | null;
  system_delivery_date?: string | null;
  note?: string | null;
}
