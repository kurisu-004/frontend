// 后端零件 API 封装 —— 应标 / 采购订单导入（PO Excel 解析后与系统零件匹配 + 回填订单号/系统交期）。
// 2026-08-25：从原 1165 行 api/parts.ts 拆分到 ./ 子文件；本文件是 ./bid 子域。
//
// 注：`parseBidExcel` / `matchBidColumns` 之类的本地 Excel 解析逻辑在
// `utils/bidExcelParser.ts`，不归本文件（前端 utils 域，非 API）。

import { api } from '@/api/http';

// 2026-10-06 删：这里的 PurchaseOrderExcelItem。
// 它是解析器域类型被放进了 API 层，与本文件头「解析逻辑在 utils/，不归本文件」的
// 分层约定直接冲突；又与 utils/purchaseOrderExcelParser.ts 的同名接口同构却零
// 引用，还经 index.ts 的 `export *` 暴露在 `@/api/parts` 桶上 —— 未来有人从 API
// 层 import 会拿到一个与 parser 解耦的副本，drift 完全不可见。解析结果一律从
// `@/utils/purchaseOrderExcelParser` 取类型。

/**
 * match-by-excel-items 的单行入参。
 * 2026-10-06 删：delivery_date / unit_price / quantity 三个键后端不声明。
 * 交货日期无法识别的文本会被解析器原样透传，后端若声明日期字段会被任意文本打挂
 * 整个请求；后端也确实用不到这三个值（系统交期由前端本地预填进 date-picker）。
 */
export interface PartBatchOrderInfoMatchItem {
  /** 与响应里的 row_no 一一对应，前端按它把候选挂回 Excel 行。 */
  row_no: number;
  line_no?: string | null;
  drawing_no?: string | null;
  name?: string | null;
}

/** 后端按图号 / 名称在零件表与装配件表里查出的候选零件。 */
export interface PartMatchInfo {
  /** 雪花 ID，全链路 string，禁止 Number() 转换（会丢精度）。 */
  part_id: string;
  /** OCC 版本号，前端回填时原样传回。 */
  version: number;
  /** 非空：t_part.drawing_no 是 NOT NULL 列。 */
  drawing_no: string;
  name: string;
  order_no: string | null;
  system_delivery_date: string | null;
  /** 所属装配件的雪花 ID，同样按 string 传输。 */
  assembly_id: string | null;
  assembly_name: string | null;
  // 2026-10-06 删：unit_price / quantity。
  // unit_price 此前声明为 number 本身就是类型谎言：后端 TPart.unit_price 是
  // Decimal，按 rust_decimal::serde::str 序列化成 string。两个字段 UI 都不读，
  // 留着只会诱导调用方按 number 去用实际拿到的是 string 的值。
}

export interface PartBatchOrderInfoMatchResult {
  row_no: number;
  match_type: 'PART_CODE' | 'PART_NAME' | 'ASSEMBLY_CODE' | 'ASSEMBLY_NAME' | 'NONE';
  parts: PartMatchInfo[];
  warnings: string[];
}

export interface PartBatchOrderInfoMatchRequest {
  // 2026-10-06 删：doc_no。匹配只按行内图号 / 名称做，后端不需要单据号。
  items: PartBatchOrderInfoMatchItem[];
}

export interface PartBatchOrderInfoUpdateItem {
  part_id: string;
  version: number;
  order_no?: string | null;
  /**
   * 三态日期：字符串 = 写入该日期，null = 清空成 NULL，undefined = 不动这一列。
   * 2026-10-06：前端已在预填处过滤（utils 的 resolveExcelDeliveryDate —— Excel
   * 交货日期不可识别 / 缺失时退回零件现有值，不发 null 也不发原文），但过滤只覆盖
   * 预填路径，用户手输的非法值仍会带着走，所以后端逐行校验，不可解析的行按
   * failed 返回而不是让整批反序列化失败。
   */
  system_delivery_date?: string | null;
  skip?: boolean;
}

export interface PartBatchOrderInfoUpdateFailure {
  part_id: string;
  code: number;
  message: string;
}

export interface PartBatchOrderInfoUpdateResult {
  // 2026-10-06 由 PartItem[] 改为数量：UI 只读这一个数字，
  // 返回完整零件实体还得让后端补 customer_name / location / holder_name 等
  // UI 从不读的字段。
  updated_count: number;
  failed: PartBatchOrderInfoUpdateFailure[];
  skipped_count: number;
}

export async function matchPartsByExcelItems(
  payload: PartBatchOrderInfoMatchRequest,
): Promise<PartBatchOrderInfoMatchResult[]> {
  const resp = await api.post<PartBatchOrderInfoMatchResult[]>(
    '/parts/match-by-excel-items',
    payload,
  );
  return resp.data;
}

export async function batchUpdatePartsOrderInfo(payload: {
  items: PartBatchOrderInfoUpdateItem[];
}): Promise<PartBatchOrderInfoUpdateResult> {
  const resp = await api.post<PartBatchOrderInfoUpdateResult>(
    '/parts/batch-update-order-info',
    payload,
  );
  return resp.data;
}
