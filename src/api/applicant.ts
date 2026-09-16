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
  const resp = await api.get<ApplicantListResult>('/applicants', {
    params: cleanParams(params),
  });
  return resp.data;
}

/**
 * 申请人前序查询：零件对话框自动补全用。
 * `customer_id` 必须是一级客户的 id（后端会校验 parent_id IS NULL）。
 *
 * 2026-09-16 修复：原先调 `/applicants/search`，但 rust v2 后端
 * applicant 域（`backend-rust/src/modules/applicant/handler.rs`）路由表只含
 * `//` / `/{id}` / `/{id}/update` / `/{id}/soft-delete`，无 `/search`。
 * 前端调 `/applicants/search` 时被 `/{id}` 路由捕获，`Path<i64>` 解析
 * "search" 失败 → 400 VALIDATION_ERROR。
 *
 * 改调 list 端点 `/applicants` 复用已有 `customer_id` / `name_like` / `limit`
 * 过滤能力，`ApplicantListResult.items` 直接抽出来作为返回值，外部行为不变。
 * `ApplicantSearchParams.name_prefix?` 字段保留（调用方未传），对未来扩展开放。
 */
export async function searchApplicants(params: ApplicantSearchParams): Promise<Applicant[]> {
  const resp = await api.get<ApplicantListResult>('/applicants', {
    params: cleanParams(params),
  });
  return resp.data.items;
}

export interface BulkApplicantItemPayload {
  name: string;
  customer_id: string;
}

export interface BulkApplicantResult {
  name: string;
  customer_id: string;
  applicant_id: string;
}

/**
 * 批量 get-or-create 申请人（应标 Excel 导入用）。
 * 后端内部按 (name, l1_root_id) 去重并幂等创建；customer_id 允许传 L1 或 L2。
 * 返回的 customer_id 是 L1 根 id（applicant 实际存储位置）。
 */
export async function bulkGetOrCreateApplicants(
  items: BulkApplicantItemPayload[],
): Promise<BulkApplicantResult[]> {
  const resp = await api.post<BulkApplicantResult[]>('/applicants/bulk-get-or-create', { items });
  return resp.data;
}

export async function getApplicant(id: string): Promise<Applicant> {
  const resp = await api.get<Applicant>(`/applicants/${id}`);
  return resp.data;
}

export async function createApplicant(payload: ApplicantCreatePayload): Promise<Applicant> {
  const resp = await api.post<Applicant>('/applicants', payload);
  return resp.data;
}

export async function updateApplicant(
  id: string,
  payload: ApplicantUpdatePayload,
): Promise<Applicant> {
  const resp = await api.post<Applicant>(`/applicants/${id}/update`, payload);
  return resp.data;
}

export async function softDeleteApplicant(id: string): Promise<void> {
  await api.post(`/applicants/${id}/soft-delete`);
}
