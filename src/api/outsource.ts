// 外协公司 (OutsourceCompany) API 封装。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import {
  outsourceInFlightListResultSchema,
  outsourcePoolByProcessResultSchema,
  outsourcePoolCountsResultSchema,
  outsourcePoolStateResultSchema,
  outsourceQuotablePartListResultSchema,
  outsourceSendableListResultSchema,
  outsourceSentPartListResultSchema,
} from '@/composables/queries/schemas';
import type {
  OutsourceCompany,
  OutsourceCompanyCreatePayload,
  OutsourceCompanyListResult,
  OutsourceCompanyUpdatePayload,
  OutsourceCompanyWithProcesses,
  OutsourceInFlightListResult,
  OutsourcePoolCountsResult,
  OutsourcePoolDetailResult,
  OutsourcePoolStateResult,
  OutsourceQuote,
  OutsourceQuoteApprovePayload,
  OutsourceQuoteCreatePayload,
  OutsourceQuoteListResult,
  OutsourceQuoteRejectPayload,
  OutsourceQuoteStatus,
  OutsourceQuoteUpdatePayload,
  OutsourceReconciliationUpdatePayload,
  OutsourceSendableListResult,
  OutsourceSentPartListResult,
  OutsourceSentPartSortKey,
  QuotablePartListResult,
  SetOutsourceCompanyProcessesPayload,
} from '@/types/outsource';
import type { SortDir } from '@/types/parts';

export async function listOutsourceCompanies(
  params: {
    name_like?: string;
    is_active?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<OutsourceCompanyListResult> {
  const resp = await api.get<OutsourceCompanyListResult>('/outsource-companies', {
    params: cleanParams(params),
  });
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 OutsourceCompanyListOut 当前是 i64 number，但本 helper 兜底未来漂移到
  // serialize_i64 字符串的场景。schema 类型保持不变。
  return normalizeListResult(resp.data);
}

export async function getOutsourceCompany(id: string): Promise<OutsourceCompanyWithProcesses> {
  const resp = await api.get<OutsourceCompanyWithProcesses>(
    `/outsource-companies/${encodeURIComponent(id)}`,
  );
  return resp.data;
}

/** 按工序反查能做此 OUTSOURCE 工序的活跃公司（发送外协对话框用） */
export async function listCompaniesByProcess(processId: string): Promise<OutsourceCompany[]> {
  const resp = await api.get<OutsourceCompany[]>(
    `/outsource-companies/by-process/${encodeURIComponent(processId)}`,
  );
  return resp.data;
}

export async function createOutsourceCompany(
  payload: OutsourceCompanyCreatePayload,
): Promise<OutsourceCompanyWithProcesses> {
  const resp = await api.post<OutsourceCompanyWithProcesses>('/outsource-companies', payload);
  return resp.data;
}

export async function updateOutsourceCompany(
  id: string,
  payload: OutsourceCompanyUpdatePayload,
): Promise<OutsourceCompanyWithProcesses> {
  const resp = await api.post<OutsourceCompanyWithProcesses>(
    `/outsource-companies/${encodeURIComponent(id)}/update`,
    payload,
  );
  return resp.data;
}

export async function softDeleteOutsourceCompany(id: string): Promise<void> {
  await api.post(`/outsource-companies/${encodeURIComponent(id)}/soft-delete`);
}

export async function setOutsourceCompanyProcesses(
  id: string,
  payload: SetOutsourceCompanyProcessesPayload,
): Promise<OutsourceCompanyWithProcesses> {
  const resp = await api.post<OutsourceCompanyWithProcesses>(
    `/outsource-companies/${encodeURIComponent(id)}/processes`,
    payload,
  );
  return resp.data;
}
// ============================================================
// 外协报价 (OutsourceQuote) API — 2026-07-16 新增
// ============================================================

export async function listOutsourceQuotes(
  params: {
    status?: OutsourceQuoteStatus;
    statuses?: OutsourceQuoteStatus[];
    part_id?: string;
    outsource_company_id?: string;
    customer_id?: string;
    keyword?: string;
    sort_by?: 'CREATED_AT' | 'PRICE' | 'REVIEWED_AT';
    sort_dir?: 'ASC' | 'DESC';
    limit?: number;
    offset?: number;
  } = {},
): Promise<OutsourceQuoteListResult> {
  const resp = await api.get<OutsourceQuoteListResult>('/outsource-quotes', {
    params: cleanParams(params),
  });
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 OutsourceQuoteListOut 当前是 i64 number，但本 helper 兜底未来漂移到
  // serialize_i64 字符串的场景。schema 类型保持不变。
  return normalizeListResult(resp.data);
}

export async function getOutsourceQuote(id: string): Promise<OutsourceQuote> {
  const resp = await api.get<OutsourceQuote>(`/outsource-quotes/${encodeURIComponent(id)}`);
  return resp.data;
}

export async function createOutsourceQuote(
  payload: OutsourceQuoteCreatePayload,
): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>('/outsource-quotes', payload);
  return resp.data;
}

export async function updateOutsourceQuote(
  id: string,
  payload: OutsourceQuoteUpdatePayload,
): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>(
    `/outsource-quotes/${encodeURIComponent(id)}/update`,
    payload,
  );
  return resp.data;
}

export async function submitOutsourceQuote(id: string): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>(`/outsource-quotes/${encodeURIComponent(id)}/submit`);
  return resp.data;
}

export async function approveOutsourceQuote(
  id: string,
  payload: OutsourceQuoteApprovePayload,
): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>(
    `/outsource-quotes/${encodeURIComponent(id)}/approve`,
    payload,
  );
  return resp.data;
}

export async function rejectOutsourceQuote(
  id: string,
  payload: OutsourceQuoteRejectPayload,
): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>(
    `/outsource-quotes/${encodeURIComponent(id)}/reject`,
    payload,
  );
  return resp.data;
}

export async function softDeleteOutsourceQuote(id: string): Promise<void> {
  await api.post(`/outsource-quotes/${encodeURIComponent(id)}/soft-delete`);
}

/**
 * 新建报价 picker 的可选零件。
 *
 * 2026-10-03 契约对齐：出参是分页信封 `QuotablePartListOut`；筛选条件是「有活跃
 * `status='PENDING'` 批次的在制件」（报价是给还没下发的零件提前锁价），行粒度是
 * **一个零件一行**，VO 不再带 `shelf_*` / `next_process_*` ⇒ 前端无从推断报价工序，
 * 工序由操作员在独立的工序下拉里手选。
 */
export async function listQuotableParts(
  params: { keyword?: string; limit?: number; offset?: number } = {},
): Promise<QuotablePartListResult> {
  const resp = await api.get<unknown>('/outsource-quotes/quotable-parts', {
    params: cleanParams(params),
  });
  // 2026-10-03 修正：Zod 守门 + 形态对齐。此前按 PartListItem[] 消费，而真实响应是
  // 分页信封 —— `raw.length` 恒 undefined，picker 恒空且不报错。
  return outsourceQuotablePartListResultSchema.parse(
    // 兜底后端未来把 i64（total/limit/offset）序列化成字符串的漂移，与本文件
    // listOutsourceCompanies / listOutsourceQuotes 同款处理。
    normalizeListResult(resp.data as Parameters<typeof normalizeListResult>[0]),
  ) as QuotablePartListResult;
}

/**
 * 外协对账一览：列出发送给某外协公司的所有零件 + 当前状态。
 * 用于与外协公司发来的对账单核对。
 */
export async function listCompanySentParts(
  companyId: string,
  params: {
    keyword?: string;
    sent_from?: string; // ISO datetime
    sent_to?: string; // ISO datetime
    received_from?: string; // ISO datetime
    received_to?: string; // ISO datetime
    sort_by?: OutsourceSentPartSortKey;
    sort_dir?: SortDir;
    limit?: number;
    offset?: number;
  } = {},
): Promise<OutsourceSentPartListResult> {
  const resp = await api.get<unknown>(
    `/outsource-companies/${encodeURIComponent(companyId)}/sent-parts`,
    { params: cleanParams(params) },
  );
  // 2026-10-03 修正：Zod 守门（此前无守门 ⇒ 路由漏注册返 404 时列表静默空白）。
  return outsourceSentPartListResultSchema.parse(
    normalizeListResult(resp.data as Parameters<typeof normalizeListResult>[0]),
  ) as OutsourceSentPartListResult;
}

/**
 * PR-H 2026-07-30：对账页行编辑（双击单价/数量/对账标记，Enter 确认 / Esc 取消）。
 * POST /outsource-shipments/{shipmentId}/reconcile-update
 */
export async function reconcileUpdateShipment(
  shipmentId: string,
  payload: OutsourceReconciliationUpdatePayload,
): Promise<void> {
  await api.post(
    `/outsource-shipments/${encodeURIComponent(shipmentId)}/reconcile-update`,
    payload,
  );
}

/**
 * 外协中批次列表（「待接收」tab 数据源）。
 * GET /outsource-shipments/in-flight
 *
 * 2026-10-03 契约对齐：URL 从 `/parts/outsource-in-flight` 迁到 outsource 域
 * （旧路径返的是通用零件列表 `PartListItem`，与本 VO 不同构）；出参从裸数组改为
 * 分页信封 `OutsourceInFlightListOut`。
 */
export async function listOutsourceInFlight(
  params: {
    keyword?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<OutsourceInFlightListResult> {
  const resp = await api.get<unknown>('/outsource-shipments/in-flight', {
    params: cleanParams(params),
  });
  // 2026-10-03 修正：Zod 守门 + 形态对齐（此前按数组消费信封 ⇒ items.length
  // undefined ⇒ 「待接收」tab 表格空白且分页失效）。
  return outsourceInFlightListResultSchema.parse(
    normalizeListResult(resp.data as Parameters<typeof normalizeListResult>[0]),
  ) as OutsourceInFlightListResult;
}

/**
 * 统一外协可发送一览（「可发送」tab 数据源）：合并 APPROVAL（工序需审批 + 已有
 * 已审批报价）与 DIRECT（工序免审批）两类候选，每行带 send_mode + source_status。
 * GET /outsource-sendable
 *
 * 2026-10-03：URL 从 `/parts/outsource-sendable` 迁到 outsource 域顶层，函数从
 * `src/api/parts/crud.ts` 迁入本文件（该列表与批次 lifecycle 写端点不同域：
 * 读侧是外协域，写的 `send-to-outsource` 才是 prod/batches 域）。出参保持分页信封。
 * 工序归属字段已由 `next_process_id` / `next_process_name` 更名为
 * `current_process_id` / `current_process_name`（判据改成
 * `t_part_batch.current_process_id`，兼容没制定过工序链的旧零件）。
 */
export async function listOutsourceSendable(
  params: {
    keyword?: string;
    customer_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<OutsourceSendableListResult> {
  const resp = await api.get<unknown>('/outsource-sendable', {
    params: cleanParams(params),
  });
  // 2026-10-03 修正：Zod 守门（此前无守门 ⇒ 旧 URL 返的通用零件列表被直接喂给
  // 「可发送」表格，列全空且不报错）。
  return outsourceSendableListResultSchema.parse(
    normalizeListResult(resp.data as Parameters<typeof normalizeListResult>[0]),
  ) as OutsourceSendableListResult;
}

// ============================================================
// 外协看板 pool 域（2026-10-03 新增）
//
// 3 个只读端点，供「外协发送/接收」看板按「工序 tab × 左侧可发送候选批次 × 右侧
// 外协公司列」消费。与上面 4 个 list helper 的两点差异：
//   1. 响应是**裸对象**（无分页信封、无 limit/offset）⇒ 不走 `normalizeListResult`
//      （它只重整 items/total/limit/offset 四键，对裸对象无意义）；count 字段本就是
//      裸 i64 数字，与雪花 ID 的字符串方向相反。
//   2. 守门在 API 边界做**第一层**，调用方的 queryFn 还会再 parse 一次（第二层）。
//      本层是沿本文件另外 4 个 list helper 的既有做法在边界挡一次漂移（那 4 个的
//      消费方是页面级 composable、queryFn 里不再 parse）；queryFn 那次是 CLAUDE.md §4
//      对共享 useQuery 的硬要求（worker-pool 三个 query 同款）。本域 3 个 helper 目前
//      **只被 `useOutsourcePool*Query` 消费**，故两层在运行路径上实际重叠。
//
// ⚠️ 本段 3 个 helper 的 `schema.parse(...) as XxxResult` 里的 `as` 是**已知不提供
// schema↔类型一致性保证**的（`as` 允许向更宽方向断言：TS 接口若比 schema 更宽松、
// 如某字段被写成 `| null`，编译器不会报错）。行 schema 与顶层 result schema 两侧的键集
// 一致性都由 `src/composables/queries/__tests__/schemas.spec.ts` 的 outsource-pool 段
// 「parse 后键集 == fixture 键集」断言兜住（4 个行 schema + 3 个顶层 result schema 各
// 一组）—— 漏声明 / 多声明带默认值都会让那组用例会红。
// ============================================================

/**
 * 各外协工序的「可发送 / 在途」计数（看板 tab 标题徽标的唯一数据源）。
 * GET /outsource-pool/counts
 *
 * 响应裸对象：counts[]（只含 sendable_count + in_flight_count > 0 的工序，按
 * process_id 升序）+ sendable_total + in_flight_total + total。
 */
export async function listOutsourcePoolCounts(): Promise<OutsourcePoolCountsResult> {
  const resp = await api.get<unknown>('/outsource-pool/counts');
  return outsourcePoolCountsResultSchema.parse(resp.data) as OutsourcePoolCountsResult;
}

/**
 * 单工序的完整看板数据：可发送候选批次 × 该工序，外加该工序映射的**全部活跃**
 * 外协公司（含在途为 0 的）。
 * GET /outsource-pool/{process_id}
 */
export async function listOutsourcePoolByProcess(
  processId: string,
): Promise<OutsourcePoolDetailResult> {
  const resp = await api.get<unknown>(`/outsource-pool/${encodeURIComponent(processId)}`);
  return outsourcePoolByProcessResultSchema.parse(resp.data) as OutsourcePoolDetailResult;
}

/**
 * 单公司 × 单工序的在途批次（看板右侧公司列的展开内容）。
 * GET /outsource-pool/state?outsource_company_id=&process_id=
 *
 * 两个 query 参数**都必填** —— 缺任一个后端即拒。守门侧由
 * `useOutsourcePoolStateQuery` 的 enabled 闸门挡（不满足时零网络请求），本 helper
 * 仍是纯透传、不兜默认值。
 */
export async function listOutsourcePoolState(params: {
  outsource_company_id: string;
  process_id: string;
}): Promise<OutsourcePoolStateResult> {
  const resp = await api.get<unknown>('/outsource-pool/state', {
    params: cleanParams(params),
  });
  return outsourcePoolStateResultSchema.parse(resp.data) as OutsourcePoolStateResult;
}
