// 外协公司 (OutsourceCompany) API 封装。
//
// 2026-10-08 新增：外协**看板**三件套的读 / 写端点（前缀 `/outsource-queue/*`），
// 契约类型在 `./outsource.contract.ts`（types only）。分层取舍与
// `productionQueue.ts` 逐字一致：api 层**不做 Zod 守门** —— 守门 schema 随视图目录走
// （`views/outsource/composables/outsourceQueueSchema.ts`），api 层 import 它就是
// api → views 的反向依赖；守门由消费方 composable 在 queryFn / mutationFn 里
// `xxxSchema.parse(await fetchXxx())` 完成。
//
// 2026-10-09：删掉 `listOutsourceSendable`（`GET /outsource-sendable`）与
// `listOutsourceInFlight`（`GET /outsource-shipments/in-flight`）—— 外协看板
// （`/outsource-queue/*` 三件套）取代了原「可发送 / 待接收」双表格页，这两个端点只服务
// 那两个表格页，后端已硬切删除。前端也不留声明：留着的 helper 会让后来人以为还能调。
//
// 2026-10-09（第二轮契约收敛，18 端点）：
//   - 删 `setOutsourceCompanyProcesses`（`POST /{id}/processes`）—— 工序能力清单的整体
//     替换已吸收进 `POST /{id}/update` 的 `process_ids`（三态可分）；
//   - 删 `getOutsourceQuote`（`GET /outsource-quotes/{id}`）与 `updateOutsourceQuote`
//     （`POST /{id}/update`）—— 后端硬切，前端零消费；
//   - 三条写端点补**必填 body `version`**（公司 `soft-delete`、报价 `submit` 与
//     `soft-delete`），出参类型 / 入参形状按 VO + DTO 逐字对齐。

import { api, cleanParams, normalizeListResult } from '@/api/http';
import type {
  OutsourceMoveRequestDto,
  OutsourceMoveResultDto,
  OutsourceQueueProcessDetailDto,
  OutsourceQueueSnapshotDto,
} from './outsource.contract';
import { outsourceQuotablePartListResultSchema } from '@/composables/queries/schemas';
import type {
  OutsourceCompanyCreatePayload,
  OutsourceCompanyListResult,
  OutsourceCompanyOption,
  OutsourceCompanySoftDeletePayload,
  OutsourceCompanyUpdatePayload,
  OutsourceCompanyWithProcesses,
  OutsourceQuote,
  OutsourceQuoteApprovePayload,
  OutsourceQuoteCreatePayload,
  OutsourceQuoteListResult,
  OutsourceQuoteRejectPayload,
  OutsourceQuoteSoftDeletePayload,
  OutsourceQuoteStatus,
  OutsourceQuoteSubmitPayload,
  OutsourceReconciliationUpdatePayload,
  OutsourceSentPartListResult,
  OutsourceSentPartSortKey,
  QuotablePartListResult,
} from '@/types/outsource';
import type { SortDir } from '@/types/parts';

/** GET /api/v2/outsource-companies —— 外协公司一览（分页信封）。
 *
 *  出参是 `OutsourceCompanyListOut`：**7 字段**的公司行（无 `created_at` / `updated_at`，
 *  2026-10-09 删 —— 两列零消费方却是纯粹的缓存抖动）+ 分页信封四字段。
 *  业务错：40001（入参形状）/ 40103（未登录）/ 40300（角色无权，HTTP 403）。 */
/** `GET /outsource-companies` 的入参形态（后端 `OutsourceCompanyListQuery`，4 字段）。
 *  导出供 `composables/queries/keys.ts` 的键工厂与 query hook 复用（api 层是 wire
 *  契约的唯一定义处，沿 `ListShelvesParams` 等既有做法）。 */
export interface ListOutsourceCompaniesParams {
  name_like?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}

export async function listOutsourceCompanies(
  params: ListOutsourceCompaniesParams = {},
): Promise<OutsourceCompanyListResult> {
  const resp = await api.get<OutsourceCompanyListResult>('/outsource-companies', {
    params: cleanParams(params),
  });
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 OutsourceCompanyListOut 当前是 i64 number，但本 helper 兜底未来漂移到
  // serialize_i64 字符串的场景。schema 类型保持不变。
  return normalizeListResult(resp.data);
}

/** GET /api/v2/outsource-companies/{id} —— 公司详情 + 工序能力清单（编辑对话框用）。
 *
 *  出参 `OutsourceCompanyWithProcessesOut`：**8 字段**（公司 7 项 + `processes[]`）。
 *  `processes[]` 每项 **3 字段**（`process_id` / `process_code` / `process_name`）——
 *  `category` / `sort_order` 已于 2026-10-09 删（前者与勾选框候选集恒等；后者只被
 *  写侧赋值与看板 SQL 的 ORDER BY 读，从不经本 VO）。
 *  业务错：21201（公司不存在或已软删）。 */
export async function getOutsourceCompany(id: string): Promise<OutsourceCompanyWithProcesses> {
  const resp = await api.get<OutsourceCompanyWithProcesses>(
    `/outsource-companies/${encodeURIComponent(id)}`,
  );
  return resp.data;
}

/** GET /api/v2/outsource-companies/by-process/{process_id} —— 按工序反查能做此
 *  OUTSOURCE 工序的活跃公司（新建报价对话框的公司下拉）。
 *
 *  2026-10-09 契约对齐：出参从 `OutsourceCompanyOut[]` 收成窄 VO
 *  `OutsourceCompanyOptionOut { id, name }[]`（**裸数组，非分页信封**）—— service 层已在
 *  Rust 里滤掉停用公司，能出现在本列表里的行恒为启用，再返 `is_active` 等于把「已被后端
 *  消掉的事实」重新交给前端判断。
 *  业务错：40001（`process_id` 非整数）/ 40103（未登录）。 */
export async function listCompaniesByProcess(processId: string): Promise<OutsourceCompanyOption[]> {
  const resp = await api.get<OutsourceCompanyOption[]>(
    `/outsource-companies/by-process/${encodeURIComponent(processId)}`,
  );
  return resp.data;
}

/** POST /api/v2/outsource-companies → 201 —— 新建外协公司（可一并写工序能力清单）。
 *
 *  2026-10-09 契约对齐：出参改 `R<()>`（`data: null`），前端建完一律重拉列表 ——
 *  返整份详情（含工序映射 + 工序元数据）多一次往返，而消费方一个字段都不用。
 *  业务错：40001（`name` 空白）/ 21202 或 21214（公司名重名）/ 21203（`process_ids` 里的
 *  工序不存在或不是 OUTSOURCE / INHOUSE 类别）/ 40300（角色无权）。 */
export async function createOutsourceCompany(payload: OutsourceCompanyCreatePayload): Promise<void> {
  await api.post('/outsource-companies', payload);
}

/** POST /api/v2/outsource-companies/{id}/update —— 改基础字段 + 整体替换工序能力清单。
 *
 *  ⚠️ **`version` 必填**（OCC 锚）：缺省是 axum 的 HTTP 422 **纯文本**
 *  （serde 无 `#[serde(default)]`），不是业务信封 —— 漏传会让编辑功能 100% 失败。
 *  `process_ids` 三态：缺省 / `null` = 不动、`[]` = 清空、`[a,b]` = 整体替换
 *  （同轮硬切删除的 `POST /{id}/processes` 已吸收进本端点）。
 *  业务错：21201（公司不存在）/ 40901（OCC 冲突，HTTP 409）/ 40001（`name` 空白）/
 *  21202 或 21214（重名）/ 21203（`process_ids` 含非法工序）。 */
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

/** POST /api/v2/outsource-companies/{id}/soft-delete —— 软删公司。
 *
 *  2026-10-09 契约对齐：入参**新增必填** `{ version }`（此前无 body，service 自读
 *  version 守乐观锁形同虚设）。守卫顺序为**先 OCC（40901）后工序映射（21205）**。
 *  业务错：21201（公司不存在）/ 40901（OCC 冲突，HTTP 409）/ 21205（仍映射 N 项工序）。 */
export async function softDeleteOutsourceCompany(
  id: string,
  payload: OutsourceCompanySoftDeletePayload,
): Promise<void> {
  await api.post(`/outsource-companies/${encodeURIComponent(id)}/soft-delete`, payload);
}
// ============================================================
// 外协报价 (OutsourceQuote) API — 2026-07-16 新增
// ============================================================

/** GET /api/v2/outsource-quotes —— 报价一览（分页信封）。
 *
 *  2026-10-09 契约对齐：
 *  - **删** `keyword`（改 `drawing_no` / `name` 两个直连 ILIKE 字段）：旧 `keyword`
 *    走预搜索再用 `part_id = ANY($N)` 回筛，预搜索带 `LIMIT 10000` 且无 `ORDER BY`
 *    ⇒ 触顶时静默返回非确定性子集、`total` 偏小；
 *  - **加** `statuses`（**逗号分隔单值**，axum 的 `Query` 走 `serde_urlencoded`，其 `Part`
 *    反序列化器不支持序列，`Vec<String>` 字段只能收 CSV 形态。`src/api/http.ts` 的
 *    `ARRAY_AS_CSV_KEYS` 已含 `'statuses'`，调用点直接传数组即可）。⚠️ 2026-10-09 起后端
 *    才真正接上这条筛选（此前 DTO 少字段 + service 恒传 `&[]`，前端发的 `statuses[]` 被
 *    serde 静默忽略 ⇒ 状态筛选恒不生效，连角色默认筛选也没生效）；
 *  - **加** `drawing_no` / `name` / `is_urgent`。
 *
 *  业务错：40001（`sort_by` / `sort_dir` 非法时回落默认值，不报错）/ 40103（未登录）。 */
/** `GET /outsource-quotes` 的入参形态（后端 `OutsourceQuoteListQuery`）。
 *  导出供键工厂与 query hook 复用。 */
export interface ListOutsourceQuotesParams {
  status?: OutsourceQuoteStatus;
  statuses?: OutsourceQuoteStatus[];
  part_id?: string;
  outsource_company_id?: string;
  customer_id?: string;
  /** `t_part.drawing_no` ILIKE 子串。 */
  drawing_no?: string;
  /** `t_part.name` ILIKE 子串。 */
  name?: string;
  is_urgent?: boolean;
  sort_by?: 'CREATED_AT' | 'PRICE' | 'REVIEWED_AT';
  sort_dir?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}

export async function listOutsourceQuotes(
  params: ListOutsourceQuotesParams = {},
): Promise<OutsourceQuoteListResult> {
  const resp = await api.get<OutsourceQuoteListResult>('/outsource-quotes', {
    params: cleanParams(params),
  });
  // 2026-09-25 修正：用 normalizeListResult 包一层，把 total/limit/offset 强制成 number。
  // 后端 OutsourceQuoteListOut 当前是 i64 number，但本 helper 兜底未来漂移到
  // serialize_i64 字符串的场景。schema 类型保持不变。
  return normalizeListResult(resp.data);
}

export async function createOutsourceQuote(
  payload: OutsourceQuoteCreatePayload,
): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>('/outsource-quotes', payload);
  return resp.data;
}

/** POST /api/v2/outsource-quotes/{id}/submit —— DRAFT → SUBMITTED。
 *
 *  2026-10-09 契约对齐：入参**新增必填** `{ version }`（此前无 body，service 自读 version
 *  守乐观锁，形同虚设）；缺 version 是 axum 的 HTTP 422 **纯文本**，不是业务信封。
 *  业务错：21301（报价不存在）/ 21302（当前状态不允许提交）/ 40901（OCC 冲突，HTTP 409）。 */
export async function submitOutsourceQuote(
  id: string,
  payload: OutsourceQuoteSubmitPayload,
): Promise<OutsourceQuote> {
  const resp = await api.post<OutsourceQuote>(
    `/outsource-quotes/${encodeURIComponent(id)}/submit`,
    payload,
  );
  return resp.data;
}

/** POST /api/v2/outsource-quotes/{id}/approve —— SUBMITTED → APPROVED（MANAGER-only）。
 *  业务错：21301 / 21302（状态不允许）/ 40901（OCC 冲突）/ 40300（非 MANAGER）。 */
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

/** POST /api/v2/outsource-quotes/{id}/reject —— SUBMITTED → REJECTED（MANAGER-only，
 *  `review_note` 必填）。业务错：21301 / 21302 / 40901 / 40001（`review_note` 空白）/ 40300。 */
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

/** POST /api/v2/outsource-quotes/{id}/soft-delete —— 软删报价。
 *
 *  2026-10-09 契约对齐：入参**新增必填** `{ version }`（理由同 submit）。
 *  业务错：21301（报价不存在）/ 21302（非 DRAFT 不可删）/ 40901（OCC 冲突）。 */
export async function softDeleteOutsourceQuote(
  id: string,
  payload: OutsourceQuoteSoftDeletePayload,
): Promise<void> {
  await api.post(`/outsource-quotes/${encodeURIComponent(id)}/soft-delete`, payload);
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
 *
 * GET /api/v2/outsource-companies/{id}/sent-parts。**2026-10-09 契约对齐**：
 *   - 信封**加** `outsource_company_id` / `outsource_company_name`：页头公司名改读这里，
 *     不必再单独发一次 `GET /outsource-companies/{id}`；
 *   - 行 18 → **16 字段**（删 `quote_id` / `part_id`）；
 *   - 入参**删** `keyword`、**加** `drawing_no` / `name` / `customer_id` / `process_id` /
 *     `is_billed`。⚠️ `customer_id` 语义与报价一览的**不同**：本端点只判零件直属
 *     `t_part.customer_id` 等值（筛「这家外协厂供过哪个客户的货」），报价端点在 service
 *     层展开成「自身 ∪ 直接子客户」的客户子树。
 *
 * 业务错：40001（入参形状）/ 40103（未登录）。⚠️ **端点不因公司缺失而 404** —— 公司不存在 /
 * 软删时返回 `outsource_company_name: null` + 空行集（口径对齐 prod::queue 的
 * `held_count` 容错风格），页头要能显示「未知公司」。
 */
/** `GET /outsource-companies/{id}/sent-parts` 的筛选入参形态（后端
 *  `OutsourceSentPartListQuery`）。公司 id 走路径参数、不在此对象里。
 *  导出供键工厂与 query hook 复用。 */
export interface ListOutsourceSentPartsParams {
  /** `t_part.drawing_no` ILIKE 子串。 */
  drawing_no?: string;
  /** `t_part.name` ILIKE 子串。 */
  name?: string;
  /** 零件**直属**客户雪花 ID 字符串（等值，不是客户子树）。 */
  customer_id?: string;
  /** `t_outsource_shipment.process_id` 等值。 */
  process_id?: string;
  /** 已开票 / 未开票分账用。 */
  is_billed?: boolean;
  sent_from?: string; // ISO datetime，闭区间下界（含）
  sent_to?: string; // ISO datetime，闭区间上界（含）
  received_from?: string; // ISO datetime，闭区间下界（含）
  received_to?: string; // ISO datetime，闭区间上界（含）
  sort_by?: OutsourceSentPartSortKey;
  sort_dir?: SortDir;
  limit?: number;
  offset?: number;
}

export async function listCompanySentParts(
  companyId: string,
  params: ListOutsourceSentPartsParams = {},
): Promise<OutsourceSentPartListResult> {
  const resp = await api.get<unknown>(
    `/outsource-companies/${encodeURIComponent(companyId)}/sent-parts`,
    { params: cleanParams(params) },
  );
  return normalizeListResult(
    resp.data as Parameters<typeof normalizeListResult>[0],
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
