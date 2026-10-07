// 外协公司 (OutsourceCompany) API 封装。
//
// 2026-10-08 新增：外协**看板**三件套的读 / 写端点（前缀 `/outsource-queue/*`），
// 契约类型在 `./outsource.contract.ts`（types only）。分层取舍与
// `productionQueue.ts` 逐字一致：api 层**不做 Zod 守门** —— 守门 schema 随视图目录走
// （`views/outsource/composables/outsourceQueueSchema.ts`），api 层 import 它就是
// api → views 的反向依赖；守门由消费方 composable 在 queryFn / mutationFn 里
// `xxxSchema.parse(await fetchXxx())` 完成。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import type {
  OutsourceMoveRequestDto,
  OutsourceMoveResultDto,
  OutsourceQueueProcessDetailDto,
  OutsourceQueueSnapshotDto,
} from './outsource.contract';
import {
  outsourceInFlightListResultSchema,
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
 * 2026-10-03：URL 是 outsource 域顶层的 `/outsource-sendable`，函数落在本文件
 * （该列表与批次 lifecycle 写端点不同域：读侧是外协域，写的 `send-to-outsource`
 * 才是 prod/batches 域）。出参是分页信封。
 * 工序归属字段是 `current_process_id` / `current_process_name`，判据取
 * `t_part_batch.current_process_id`（兼容没制定过工序链的旧零件）。
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
// 外协看板 (OutsourceQueue) — 2026-10-08 新增
// 端点前缀 `/outsource-queue/*`（**无 alias**），读写合一的三件套。
// 角色：读 Manager + Clerk + Inspector；move `require_any_role([Manager, Clerk,
// Inspector])`（前端闸门见 views/outsource/composables/useOutsourceQueueMove.ts）。
// ============================================================

/** GET /api/v2/outsource-queue/snapshot —— 外协看板 tab 标题双徽标（可发 / 在途）的
 *  唯一数据源。裸对象（**无分页信封、无 `total` 字段**）。
 *  `processes[]` 只含 `sendable_count + in_flight_count > 0` 的工序 ⇒ tab 集合必须与
 *  全量 OUTSOURCE 工序列表 join，否则某工序收发清零时该 tab 会凭空消失。
 *  业务错：40300（角色无权，HTTP 403）。 */
export async function fetchOutsourceQueueSnapshot(): Promise<OutsourceQueueSnapshotDto> {
  const resp = await api.get<OutsourceQueueSnapshotDto>('/outsource-queue/snapshot');
  return resp.data;
}

/** GET /api/v2/outsource-queue/processes/{process_id} —— 单工序看板的全部内容。
 *  左列候选卡 `items[]` + 右列公司 `companies[]`（`companies[].held_batches` 已内联，
 *  **零 N+1**）。**不分页，一次全量**；`companies[]` 含 `held_count === 0` 的空公司
 *  （合法拖拽落点，不能被前端过滤掉）。
 *  业务错：20801（工序不存在）。 */
export async function fetchOutsourceQueueProcess(
  processId: string,
): Promise<OutsourceQueueProcessDetailDto> {
  const resp = await api.get<OutsourceQueueProcessDetailDto>(
    `/outsource-queue/processes/${encodeURIComponent(processId)}`,
  );
  return resp.data;
}

/** POST /api/v2/outsource-queue/move —— 外协收发合一移动（发送 / 回收生产 / 回收品检）。
 *  收发合一的理由：`t_part_batch` 的 `location` / `current_holder_id` / `version` 三列
 *  在三个方向上是同一组列，拆成三个端点只会让同一份事务边界写三遍。
 *  ❌ 缺 `version` 时后端返 HTTP 422 **纯文本**（serde 无 `#[serde(default)]`），不是
 *  业务信封 —— 调用方必须自己保证 version 非空。
 *  业务错：20104（报价路径 `quote_id` / `direct` 都不传或同时传）/ 20121（批次不存在）/
 *  20706（工序链推不出下一道工序且未指定）/ 40901（OCC 冲突，HTTP 409）/
 *  40300（角色无权，HTTP 403）。 */
export async function moveOutsourceBatch(
  payload: OutsourceMoveRequestDto,
): Promise<OutsourceMoveResultDto> {
  const resp = await api.post<OutsourceMoveResultDto>('/outsource-queue/move', payload);
  return resp.data;
}
