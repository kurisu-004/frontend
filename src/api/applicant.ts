// 申请人 (Applicant) API 封装。

import { api, cleanParams } from '@/api/http';
import type {
  Applicant,
  ApplicantCreatePayload,
  ApplicantListResult,
  ApplicantSearchParams,
  ApplicantUpdatePayload,
} from '@/types/applicant';

export async function listApplicants(
  params: {
    customer_id?: string;
    name_like?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ApplicantListResult> {
  const resp = await api.get<ApplicantListResult>('/com/applicants', {
    params: cleanParams(params),
  });
  return resp.data;
}

/**
 * 申请人前序查询：零件对话框自动补全用。
 * `customer_id` 必须是一级客户的 id（后端会校验 parent_id IS NULL）。
 *
 * 2026-09-16 重构：原 `searchApplicants` 调 `/applicants/search`，但 rust v2
 * 后端 applicant 域（`backend-rust/src/modules/applicant/handler.rs`）
 * 路由表只挂 `/` / `/{id}` / `/{id}/update` / `/{id}/soft-delete`，
 * 无 `/search`；请求被 `/{id}` 捕获后 `Path<i64>` 解析 "search" 失败 → 400。
 *
 * 现改调 list 端点 `/com/applicants`（2026-09-19 com 模块归位后路径），
 * 内部委托给 `listApplicants`，从 `ApplicantListResult.items` 抽出数组返回。
 * `ApplicantSearchParams.name_like?` 字段对齐后端契约（原误写为 `name_prefix`，
 * 调用方未传，影响为零）。
 */
export async function searchApplicants(params: ApplicantSearchParams): Promise<Applicant[]> {
  const result = await listApplicants(params);
  return result.items;
}

/**
 * 2026-10-17 删 `bulkGetOrCreateApplicants` 及其两个 Bulk* 类型（死代码）。
 *
 * 死在哪：① 全仓零调用方（`rg bulkGetOrCreateApplicants src/` 只命中定义处本身）；
 * ② 它 POST 的 `/com/applicants/bulk-get-or-create` 在 rust v2 后端**根本不存在**
 * —— applicant 域只挂 `/` / `/{id}` / `/{id}/update` / `/{id}/soft-delete`
 * （backend-rust `src/modules/com/applicant/handler.rs` 的模块 doc 明确把
 * `/search` 与 `/bulk-get-or-create` 列为「不在范围」）。真有人调用会落进
 * `/{id}` 捕获后 `Path<i64>` 解析失败 → 405/400，**永远不会成功**。
 * 两个 `Bulk*` 接口只服务于该函数，一并删；保留它们只会让后人以为那条路还能走。
 */

/**
 * 幂等 get-or-create 申请人（2026-10-17 新增，替代上面的批量死代码）。
 *
 * 语义：`(name, customer_id)` 命中既有行就**直接返回该行**（HTTP 200），不新建、
 * 不报 409 —— 这是它与 `createApplicant` 的唯一区别，也是新增订单页能安全地
 * 「没登记就自动新增」的根据（同批两行同名申请人不会把整批拖废）。
 *
 * - body 形状与 `ApplicantCreatePayload` 逐字相同（`name` 由后端 trim，
 *   `customer_id` 传**字符串**雪花 id），故直接复用该类型、不另立一份。
 * - 出参 `R<ApplicantOut>` 与 `createApplicant` 完全同形，故复用 `Applicant`。
 * - `customer_id` 必须是**一级客户** id（后端按 `parent_id IS NULL` 校验）。
 *   调用方（`usePartBatchManual.submitStagedEntries`）先经
 *   `resolveRootCustomerId` 上溯再传，传 L2 会被后端拒。
 */
export async function getOrCreateApplicant(payload: ApplicantCreatePayload): Promise<Applicant> {
  const resp = await api.post<Applicant>('/com/applicants/get-or-create', payload);
  return resp.data;
}

export async function createApplicant(payload: ApplicantCreatePayload): Promise<Applicant> {
  const resp = await api.post<Applicant>('/com/applicants', payload);
  return resp.data;
}

export async function updateApplicant(
  id: string,
  payload: ApplicantUpdatePayload,
): Promise<Applicant> {
  const resp = await api.post<Applicant>(`/com/applicants/${id}/update`, payload);
  return resp.data;
}

export async function softDeleteApplicant(id: string): Promise<void> {
  await api.post(`/com/applicants/${id}/soft-delete`);
}
