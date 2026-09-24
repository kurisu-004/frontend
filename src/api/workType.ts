// 工种 (WorkType) API 封装。

import { api, cleanParams } from '@/api/http';
import type {
  SetWorkTypeProcessesPayload,
  WorkType,
  WorkTypeCreatePayload,
  WorkTypeListResult,
  WorkTypeUpdatePayload,
  WorkTypeWithProcesses,
} from '@/types/workType';

export async function listWorkTypes(
  params: { code_like?: string; limit?: number; offset?: number } = {},
): Promise<WorkTypeListResult> {
  // 2026-09-25 修正：后端路由前缀缺失 /prod/ 段，补齐对齐 v2 backend-rust 实际契约。
  const resp = await api.get<WorkTypeListResult>('/prod/work-types', {
    params: cleanParams(params),
  });
  return resp.data;
}

export async function getWorkType(id: string): Promise<WorkType> {
  const resp = await api.get<WorkType>(`/prod/work-types/${id}`);
  return resp.data;
}

export async function createWorkType(payload: WorkTypeCreatePayload): Promise<WorkType> {
  const resp = await api.post<WorkType>('/prod/work-types', payload);
  return resp.data;
}

export async function updateWorkType(
  id: string,
  payload: WorkTypeUpdatePayload,
): Promise<WorkType> {
  const resp = await api.post<WorkType>(`/prod/work-types/${id}/update`, payload);
  return resp.data;
}

export async function softDeleteWorkType(id: string): Promise<void> {
  await api.post(`/prod/work-types/${id}/soft-delete`);
}

export async function getWorkTypeProcesses(workTypeId: string): Promise<WorkTypeWithProcesses> {
  const resp = await api.get<WorkTypeWithProcesses>(`/prod/work-types/${workTypeId}/processes`);
  return resp.data;
}

export async function setWorkTypeProcesses(
  workTypeId: string,
  payload: SetWorkTypeProcessesPayload,
): Promise<WorkTypeWithProcesses> {
  const resp = await api.post<WorkTypeWithProcesses>(
    `/prod/work-types/${workTypeId}/processes`,
    payload,
  );
  return resp.data;
}
